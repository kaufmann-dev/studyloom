import { mkdir, open, readdir, readFile, stat } from 'node:fs/promises';
import { basename, extname, join } from 'node:path';
import type { z } from 'zod';
import { runTool } from './commands';
import { transcribeFile } from './elevenlabs';
import type { ingestionSchema } from '../domain';

// The server reads the formats it knows itself, so Claude never has to work out the tools:
// text and transcripts are stored as they are, documents go to Claude as page text to review,
// and anything else is left to Claude's own tools.

export type Ingestion = z.infer<typeof ingestionSchema>;
/** One page, slide or sheet of a document, in reading order. */
export interface Unit {
	locator: string;
	text: string;
	/** The text was read from a rendered page with OCR and may contain errors. */
	ocr?: true;
	/** A workspace-relative render of the page, for pages with little text or a figure. */
	image?: string;
}
export type DocumentKind = 'pdf' | 'slides' | 'document' | 'spreadsheet';
export type Prepared =
	{ type: 'chunks'; result: Ingestion } | { type: 'review'; kind: DocumentKind; units: Unit[] };
type Kind = 'pdf' | 'document' | 'slides' | 'spreadsheet' | 'office' | 'markup' | 'text' | 'binary';
interface Context {
	jobDir: string;
	files: string;
	signal: AbortSignal;
	progress: (text: string) => void;
}

const HEAD_BYTES = 64 * 1024;
const MAX_TEXT_BYTES = 32 * 1024 * 1024;
const MAX_CENTRAL_DIRECTORY = 16 * 1024 * 1024;
/** Pages with fewer visible characters than this have no usable text layer and are OCR'd. */
const OCR_BELOW = 20;
/** Pages with fewer visible characters than this are rendered so Claude can look at them. */
const SPARSE_BELOW = 300;
/** Embedded images at least this large on both sides count as figures. */
const FIGURE_MIN_PX = 200;
const MINUTE = 60_000;

const visibleChars = (text: string) => text.replace(/\s/g, '').length;

/** Classifies a file by its first bytes and, for ZIP containers, by the names inside. */
export function sniff(head: Buffer, zipNames: string[] = []): Kind {
	if (!head.length) return 'binary';
	if (head.subarray(0, 1024).includes('%PDF-')) return 'pdf';
	if (head.subarray(0, 4).equals(Buffer.from('PK\x03\x04', 'latin1'))) {
		// ODF stores its type uncompressed as the first entry, named "mimetype".
		if (head.toString('latin1', 30, 38) === 'mimetype') {
			const type = head.toString('latin1', 38, 38 + Math.min(head.readUInt32LE(18), 100));
			if (type.startsWith('application/vnd.oasis.opendocument.text')) return 'document';
			if (type.startsWith('application/vnd.oasis.opendocument.presentation')) return 'slides';
			if (type.startsWith('application/vnd.oasis.opendocument.spreadsheet')) return 'spreadsheet';
			return 'binary';
		}
		if (zipNames.includes('word/document.xml')) return 'document';
		if (zipNames.includes('ppt/presentation.xml')) return 'slides';
		if (zipNames.includes('xl/workbook.xml')) return 'spreadsheet';
		return 'binary';
	}
	if (head.subarray(0, 8).equals(Buffer.from('d0cf11e0a1b11ae1', 'hex'))) return 'office';
	if (head.subarray(0, 5).toString('latin1') === '{\\rtf') return 'office';
	if (head.includes(0)) return 'binary';
	try {
		// Streaming decode accepts a character cut off at the end of the sample.
		const text = new TextDecoder('utf-8', { fatal: true }).decode(head, { stream: true });
		return text
			.replace(/^\uFEFF/, '')
			.trimStart()
			.startsWith('<')
			? 'markup'
			: 'text';
	} catch {
		return 'binary';
	}
}
/** The entry names in a ZIP central directory. */
export function centralDirectoryNames(directory: Buffer) {
	const names: string[] = [];
	for (let at = 0; at + 46 <= directory.length;) {
		if (directory.readUInt32LE(at) !== 0x02014b50) break;
		const nameLength = directory.readUInt16LE(at + 28);
		const extra = directory.readUInt16LE(at + 30);
		const comment = directory.readUInt16LE(at + 32);
		names.push(directory.toString('utf8', at + 46, at + 46 + nameLength));
		at += 46 + nameLength + extra + comment;
	}
	return names;
}
async function zipNames(path: string, size: number) {
	const file = await open(path, 'r');
	try {
		const tailLength = Math.min(size, HEAD_BYTES + 22);
		const tail = Buffer.alloc(tailLength);
		await file.read(tail, 0, tailLength, size - tailLength);
		const end = tail.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
		if (end < 0 || end + 22 > tail.length) return [];
		const length = tail.readUInt32LE(end + 12);
		const offset = tail.readUInt32LE(end + 16);
		if (length > MAX_CENTRAL_DIRECTORY || offset + length > size) return [];
		const directory = Buffer.alloc(length);
		await file.read(directory, 0, length, offset);
		return centralDirectoryNames(directory);
	} finally {
		await file.close();
	}
}
export async function sniffFile(path: string) {
	const { size } = await stat(path);
	const file = await open(path, 'r');
	const head = Buffer.alloc(Math.min(size, HEAD_BYTES));
	try {
		await file.read(head, 0, head.length, 0);
	} finally {
		await file.close();
	}
	const zip = head.subarray(0, 4).equals(Buffer.from('PK\x03\x04', 'latin1'));
	return { kind: sniff(head, zip ? await zipNames(path, size) : []), size };
}

const PART_CHARS = 4000;
/**
 * Splits text into citable parts of whole paragraphs. A paragraph longer than a part is cut at
 * its last line break, else its last space, past half a part, so table rows and lines stay whole.
 */
export function textSections(text: string) {
	const parts: string[] = [];
	let current = '';
	const push = () => {
		if (current.trim()) parts.push(current.trim());
		current = '';
	};
	const cutAt = (rest: string) => {
		for (const separator of ['\n', ' ']) {
			const at = rest.lastIndexOf(separator, PART_CHARS);
			if (at > PART_CHARS / 2) return at;
		}
		return PART_CHARS;
	};
	for (const paragraph of text.replace(/\r\n?/g, '\n').split(/\n\s*\n/)) {
		let rest = paragraph.trim();
		if (!rest) continue;
		if (current && current.length + rest.length + 2 > PART_CHARS) push();
		while (rest.length > PART_CHARS) {
			push();
			const at = cutAt(rest);
			parts.push(rest.slice(0, at).trim());
			rest = rest.slice(at).trim();
		}
		current = current ? `${current}\n\n${rest}` : rest;
	}
	push();
	return parts.map((part, i) => ({ locator: `part:${i + 1}`, text: part }));
}
/** A transcript turn as a citable chunk, located by its time span in milliseconds. */
export function transcriptChunk(turn: {
	startMs: number;
	endMs: number;
	speaker?: string | null;
	text: string;
}) {
	return {
		locator: `time:${turn.startMs}-${turn.endMs}`,
		text: (turn.speaker ? `[${turn.speaker}] ` : '') + turn.text
	};
}

/** pdftotext ends every page with a form feed. */
export function splitPages(text: string) {
	const pages = text.split('\f');
	if (text.endsWith('\f')) pages.pop();
	return pages;
}
/**
 * Pages with a figure, from `pdfimages -list`: an image at least 200 px on both sides that is
 * not repeated on most pages, as logos and backgrounds are.
 */
export function pdfImagePages(list: string, pageCount: number) {
	const images = list
		.split('\n')
		.slice(2)
		.map((line) => line.trim().split(/\s+/))
		.filter((cols) => cols.length >= 11 && cols[2] === 'image')
		.map((cols) => ({
			page: Number(cols[0]),
			width: Number(cols[3]),
			height: Number(cols[4]),
			object: cols[10]
		}))
		.filter((image) => image.width >= FIGURE_MIN_PX && image.height >= FIGURE_MIN_PX);
	const pagesOf = new Map<string, Set<number>>();
	for (const image of images)
		pagesOf.set(image.object, (pagesOf.get(image.object) ?? new Set()).add(image.page));
	const repeated = Math.max(2, pageCount / 2);
	return new Set(
		images.filter((image) => pagesOf.get(image.object)!.size <= repeated).map((i) => i.page)
	);
}
/** LibreOffice names one CSV per sheet `<base>-<sheet>.csv`; a lone `<base>.csv` is sheet 1. */
export function sheetName(file: string, base: string) {
	if (file === `${base}.csv`) return '1';
	return file.startsWith(`${base}-`) ? file.slice(base.length + 1, -'.csv'.length) : undefined;
}

async function pdfUnits(ctx: Context, pdf: string, unit: 'page' | 'slide') {
	const { jobDir, files, signal, progress } = ctx;
	await mkdir(join(files, 'pages'), { recursive: true });
	progress('Extracting text');
	await runTool(jobDir, 'pdftotext', ['-enc', 'UTF-8', pdf, 'converted/text.txt'], {
		signal,
		timeoutMs: 5 * MINUTE
	});
	const pages = splitPages(await readFile(join(files, 'converted', 'text.txt'), 'utf8'));
	const imageList = await runTool(jobDir, 'pdfimages', ['-list', pdf], {
		signal,
		timeoutMs: 5 * MINUTE
	}).catch(() => '');
	const figures = pdfImagePages(imageList, pages.length);
	const units: Unit[] = [];
	for (const [i, layer] of pages.entries()) {
		const n = i + 1;
		const range = ['-f', String(n), '-l', String(n), '-singlefile'];
		let text = layer.trim();
		const ocr = visibleChars(layer) < OCR_BELOW;
		if (ocr) {
			progress(`Reading ${unit} ${n} of ${pages.length} with OCR`);
			await runTool(jobDir, 'pdftoppm', ['-r', '300', '-png', ...range, pdf, 'converted/ocr'], {
				signal,
				timeoutMs: 2 * MINUTE
			});
			text = (
				await runTool(jobDir, 'tesseract', ['converted/ocr.png', '-', '-l', 'eng+deu'], {
					signal,
					timeoutMs: 2 * MINUTE
				})
			).trim();
		}
		let image: string | undefined;
		if (ocr || visibleChars(layer) < SPARSE_BELOW || figures.has(n)) {
			image = `pages/${unit}-${String(n).padStart(3, '0')}`;
			await runTool(jobDir, 'pdftoppm', ['-r', '110', '-png', ...range, pdf, image], {
				signal,
				timeoutMs: 2 * MINUTE
			});
			image += '.png';
		}
		units.push({
			locator: `${unit}:${n}`,
			text,
			...(ocr && { ocr: true }),
			...(image && { image })
		});
	}
	return units;
}
async function libreOffice(ctx: Context, input: string, target: string) {
	ctx.progress('Converting the document with LibreOffice');
	const profile = `file://${join(ctx.jobDir, 'home', 'libreoffice')}`;
	await runTool(
		ctx.jobDir,
		'libreoffice',
		[
			'--headless',
			`-env:UserInstallation=${profile}`,
			'--convert-to',
			target,
			'--outdir',
			'converted',
			input
		],
		{ signal: ctx.signal, timeoutMs: 10 * MINUTE }
	);
	return (await readdir(join(ctx.files, 'converted'))).map((name) => `converted/${name}`);
}
async function officeUnits(ctx: Context, input: string, unit: 'page' | 'slide') {
	const pdf = (await libreOffice(ctx, input, 'pdf')).find((name) => name.endsWith('.pdf'));
	if (!pdf) throw new Error('LibreOffice could not convert the document.');
	return pdfUnits(ctx, pdf, unit);
}
async function sheetUnits(ctx: Context, input: string) {
	const base = basename(input, extname(input));
	const csvs = (
		await libreOffice(
			ctx,
			input,
			'csv:Text - txt - csv (StarCalc):44,34,76,1,,0,false,true,false,false,false,-1'
		)
	).filter((name) => name.endsWith('.csv'));
	// LibreOffice writes the sheets in order, so their write times keep that order.
	const written = await Promise.all(
		csvs.map(async (name) => ({ name, time: (await stat(join(ctx.files, name))).mtimeMs }))
	);
	written.sort((a, b) => a.time - b.time || a.name.localeCompare(b.name));
	const units: Unit[] = [];
	for (const { name } of written) {
		const sheet = sheetName(basename(name), base);
		const text = (await readFile(join(ctx.files, name), 'utf8')).trim();
		if (sheet && text) units.push({ locator: `sheet:${sheet}`, text });
	}
	if (!units.length) throw new Error('LibreOffice could not read the spreadsheet.');
	return units;
}
async function textChunks(path: string, size: number): Promise<Prepared | undefined> {
	if (size > MAX_TEXT_BYTES) return undefined;
	let text: string;
	try {
		text = new TextDecoder('utf-8', { fatal: true }).decode(await readFile(path));
	} catch {
		return undefined;
	}
	const chunks = textSections(text.replace(/^\uFEFF/, ''));
	return {
		type: 'chunks',
		result: chunks.length
			? { status: 'ready', notes: '', chunks, assets: [] }
			: { status: 'unreadable', notes: 'The file contains no text.', chunks: [], assets: [] }
	};
}
const probeStreams = (value: unknown) =>
	(value as { streams?: { codec_type?: string; disposition?: { attached_pic?: number } }[] })
		.streams ?? [];
async function mediaChunks(ctx: Context, input: string): Promise<Prepared | undefined> {
	const probe = await runTool(
		ctx.jobDir,
		'ffprobe',
		[
			'-v',
			'error',
			'-show_entries',
			'stream=codec_type:stream_disposition=attached_pic',
			'-of',
			'json',
			input
		],
		{ signal: ctx.signal, timeoutMs: MINUTE }
	).catch(() => undefined);
	if (probe === undefined) return undefined;
	const streams = probeStreams(JSON.parse(probe));
	if (!streams.some((stream) => stream.codec_type === 'audio')) return undefined;
	const video = streams.some(
		(stream) => stream.codec_type === 'video' && !stream.disposition?.attached_pic
	);
	ctx.progress('Extracting the audio');
	await runTool(
		ctx.jobDir,
		'ffmpeg',
		['-nostdin', '-v', 'error', '-i', input, '-vn', '-ac', '1', '-ar', '16000'].concat([
			'-c:a',
			'flac',
			'converted/audio.flac'
		]),
		{ signal: ctx.signal, timeoutMs: 30 * MINUTE }
	);
	ctx.progress('Transcribing the audio');
	const transcript = await transcribeFile(join(ctx.files, 'converted', 'audio.flac'), ctx.signal);
	const chunks = transcript.turns.length
		? transcript.turns.map((turn) => transcriptChunk({ ...turn, text: turn.transcript }))
		: transcript.transcript.trim()
			? [
					transcriptChunk({
						startMs: 0,
						endMs: transcript.audioDurationMs,
						text: transcript.transcript.trim()
					})
				]
			: [];
	if (!chunks.length) return undefined;
	return {
		type: 'chunks',
		result: {
			status: 'ready',
			notes: video ? 'Transcribed from the audio track; the video picture was not read.' : '',
			chunks,
			assets: []
		}
	};
}

/**
 * Extracts a source the server knows how to read. `undefined` leaves the file to Claude's own
 * tools: images, web pages and other markup, unknown formats, and media without speech.
 */
export async function prepareSource(
	input: string,
	jobDir: string,
	signal: AbortSignal,
	progress: (text: string) => void
): Promise<Prepared | undefined> {
	const files = join(jobDir, 'files');
	const ctx: Context = { jobDir, files, signal, progress };
	const name = basename(input);
	const { kind, size } = await sniffFile(input);
	if (kind === 'markup') return undefined;
	if (kind === 'text') return textChunks(input, size);
	await mkdir(join(files, 'converted'), { recursive: true });
	if (kind === 'binary') return mediaChunks(ctx, name);
	if (kind === 'pdf') return { type: 'review', kind, units: await pdfUnits(ctx, name, 'page') };
	if (kind === 'slides')
		return { type: 'review', kind, units: await officeUnits(ctx, name, 'slide') };
	if (kind === 'spreadsheet') return { type: 'review', kind, units: await sheetUnits(ctx, name) };
	return { type: 'review', kind: 'document', units: await officeUnits(ctx, name, 'page') };
}
