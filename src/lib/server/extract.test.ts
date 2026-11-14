import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
	prepareSource,
	sniff,
	sniffFile,
	splitPages,
	textSections,
	transcriptChunk
} from './extract';

/** A minimal stored (uncompressed) ZIP archive with the given entries, in order. */
function zip(entries: [name: string, content: string][]) {
	const locals: Buffer[] = [];
	const central: Buffer[] = [];
	let offset = 0;
	for (const [name, content] of entries) {
		const data = Buffer.from(content);
		const path = Buffer.from(name);
		const local = Buffer.alloc(30);
		local.writeUInt32LE(0x04034b50, 0);
		local.writeUInt32LE(data.length, 18);
		local.writeUInt32LE(data.length, 22);
		local.writeUInt16LE(path.length, 26);
		const record = Buffer.alloc(46);
		record.writeUInt32LE(0x02014b50, 0);
		record.writeUInt32LE(data.length, 20);
		record.writeUInt32LE(data.length, 24);
		record.writeUInt16LE(path.length, 28);
		record.writeUInt32LE(offset, 42);
		locals.push(local, path, data);
		central.push(record, path);
		offset += 30 + path.length + data.length;
	}
	const directory = Buffer.concat(central);
	const end = Buffer.alloc(22);
	end.writeUInt32LE(0x06054b50, 0);
	end.writeUInt16LE(entries.length, 8);
	end.writeUInt16LE(entries.length, 10);
	end.writeUInt32LE(directory.length, 12);
	end.writeUInt32LE(offset, 16);
	return Buffer.concat([...locals, directory, end]);
}
const odf = (type: string) =>
	zip([
		['mimetype', `application/vnd.oasis.opendocument.${type}`],
		['content.xml', '<office:document-content/>']
	]);

let dir = '';
beforeAll(async () => {
	dir = await mkdtemp(join(tmpdir(), 'studyloom-extract-'));
	await mkdir(join(dir, 'files'));
});
afterAll(() => rm(dir, { recursive: true, force: true }));
const file = async (name: string, content: Buffer | string) => {
	const path = join(dir, 'files', name);
	await writeFile(path, content);
	return path;
};

describe('file sniffing', () => {
	it('recognises documents by their bytes, not their names', async () => {
		const kind = async (content: Buffer | string) =>
			(await sniffFile(await file('input-anything.bin', content))).kind;
		expect(await kind('%PDF-1.7\n%âãÏÓ\n')).toBe('pdf');
		expect(
			await kind(
				zip([
					['[Content_Types].xml', '<Types/>'],
					['word/document.xml', '<w/>']
				])
			)
		).toBe('document');
		expect(
			await kind(
				zip([
					['ppt/presentation.xml', '<p/>'],
					['ppt/slides/slide1.xml', '']
				])
			)
		).toBe('slides');
		expect(await kind(zip([['xl/workbook.xml', '<workbook/>']]))).toBe('spreadsheet');
		expect(await kind(odf('text'))).toBe('document');
		expect(await kind(odf('presentation'))).toBe('slides');
		expect(await kind(odf('spreadsheet'))).toBe('spreadsheet');
		expect(await kind(zip([['mimetype', 'application/epub+zip']]))).toBe('binary');
		expect(await kind(zip([['notes.txt', 'just an archive']]))).toBe('binary');
	});
	it('tells plain text from markup and binary data', () => {
		expect(sniff(Buffer.from('d0cf11e0a1b11ae1000000', 'hex'))).toBe('office');
		expect(sniff(Buffer.from('{\\rtf1\\ansi Hello}'))).toBe('office');
		expect(sniff(Buffer.from('  <!doctype html><p>Hi</p>'))).toBe('markup');
		expect(sniff(Buffer.from('\uFEFF<svg xmlns="http://www.w3.org/2000/svg"/>'))).toBe('markup');
		expect(sniff(Buffer.from('Lecture notes\n\nOsmosis…'))).toBe('text');
		expect(sniff(Buffer.from('name,score\nAna,3\n'))).toBe('text');
		// A character cut off at the end of the sample is still text.
		expect(sniff(Buffer.from('Grüße').subarray(0, 3))).toBe('text');
		expect(sniff(Buffer.from([0x48, 0x00, 0x49]))).toBe('binary');
		expect(sniff(Buffer.from([0xff, 0xfe, 0x41]))).toBe('binary');
		expect(sniff(Buffer.alloc(0))).toBe('binary');
	});
});

describe('document units', () => {
	it('splits pdftotext output into pages', () => {
		expect(splitPages('One\fTwo\f')).toEqual(['One', 'Two']);
		expect(splitPages('One\f\f')).toEqual(['One', '']);
		expect(splitPages('Only')).toEqual(['Only']);
	});
	it('locates transcript turns by their time span', () => {
		expect(
			transcriptChunk({ startMs: 0, endMs: 4200, speaker: 'Speaker 1', text: 'Hello.' })
		).toEqual({
			locator: 'time:0-4200',
			kind: 'text',
			text: '[Speaker 1] Hello.'
		});
		expect(transcriptChunk({ startMs: 5, endMs: 9, speaker: null, text: 'Hi.' }).text).toBe('Hi.');
	});
});

describe('text sections', () => {
	it('cuts long paragraphs at line breaks so rows stay whole', () => {
		const rows = Array.from({ length: 200 }, (_, i) => `row ${i},${'x'.repeat(40)}`);
		const sections = textSections(rows.join('\n'));
		expect(sections.length).toBeGreaterThan(1);
		expect(sections.every((section) => section.text.length <= 4000)).toBe(true);
		expect(sections.flatMap((section) => section.text.split('\n'))).toEqual(rows);
	});
});

describe('source preparation', () => {
	const prepare = (path: string) => prepareSource(path, dir, AbortSignal.timeout(10_000), () => {});
	it('stores plain text without Claude', async () => {
		const prepared = await prepare(
			await file('input-notes.md', '# Osmosis\n\nWater follows salt.')
		);
		expect(prepared).toEqual({
			type: 'chunks',
			result: {
				status: 'ready',
				notes: '',
				chunks: [{ locator: 'part:1', kind: 'text', text: '# Osmosis\n\nWater follows salt.' }],
				assets: []
			}
		});
		expect(await prepare(await file('input-empty.txt', '\n \n'))).toMatchObject({
			result: { status: 'unreadable', chunks: [] }
		});
	});
	it('leaves web pages, images and unknown files to Claude', async () => {
		expect(await prepare(await file('input-page.html', '<html><body>Hi</body></html>'))).toBe(
			undefined
		);
		expect(
			await prepare(await file('input-blob.bin', Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 1, 2])))
		).toBe(undefined);
	});
});
