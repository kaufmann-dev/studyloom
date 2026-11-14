import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { runTool } from './commands';
import { scopedFile } from './storage';

// Figures are cut out of page renders during extraction and stored with their source.

export const MAX_FIGURE_BYTES = 8 * 1024 * 1024;
const MIN_FIGURE_SIDE = 48;
/** A figure reference in extracted Markdown: `![label](figure:<workspace path>)`. */
export const FIGURE_REFERENCE = /(!\[[^\]]*\]\()figure:([^)\s]+)(\))/g;

/** The image type by the file's first bytes; only these three can be shown in the browser. */
export function imageType(data: Buffer) {
	if (data.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex'))) return 'image/png';
	if (data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff) return 'image/jpeg';
	if (data.toString('ascii', 0, 4) === 'RIFF' && data.toString('ascii', 8, 12) === 'WEBP')
		return 'image/webp';
}

/** The workspace paths of the figures a text refers to. */
export function figureReferences(text: string) {
	return [...text.matchAll(FIGURE_REFERENCE)].map((match) => match[2]);
}

export interface CropBox {
	x: number;
	y: number;
	width: number;
	height: number;
}
/**
 * Cuts a region, given as fractions of the image from its top-left corner, out of a workspace
 * image. The crop gets a new name under `figures/`, so it can never replace a page render.
 */
export async function cropImage(jobDir: string, path: string, box: CropBox, signal?: AbortSignal) {
	const files = join(jobDir, 'files');
	const source = await scopedFile(files, path);
	await mkdir(join(files, 'figures'), { recursive: true });
	const name = `figures/${randomUUID().slice(0, 8)}.png`;
	const output = join(files, name);
	const width = Math.min(box.width, 1 - box.x);
	const height = Math.min(box.height, 1 - box.y);
	await runTool(
		jobDir,
		'ffmpeg',
		[
			'-nostdin',
			'-v',
			'error',
			'-y',
			'-i',
			source,
			'-vf',
			`crop=iw*${width}:ih*${height}:iw*${box.x}:ih*${box.y}`,
			'-frames:v',
			'1',
			output
		],
		{ signal, timeoutMs: 60_000 }
	);
	const data = await readFile(output);
	// A PNG states its size right after the signature: width and height of the IHDR chunk.
	const tooSmall =
		data.length < 24 ||
		data.readUInt32BE(16) < MIN_FIGURE_SIDE ||
		data.readUInt32BE(20) < MIN_FIGURE_SIDE;
	if (tooSmall || data.length > MAX_FIGURE_BYTES) {
		await rm(output, { force: true });
		throw new Error(
			tooSmall
				? `The crop is smaller than ${MIN_FIGURE_SIDE} pixels on a side. Choose a larger box.`
				: 'The crop is larger than 8 MiB. Choose a smaller box.'
		);
	}
	return { path: name, data };
}
