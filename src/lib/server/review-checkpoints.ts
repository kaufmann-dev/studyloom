import { createHash } from 'node:crypto';
import { copyFile, mkdir, mkdtemp, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { idSchema } from '../domain';
import { type Unit } from './extract';
import { FIGURE_REFERENCE, MAX_FIGURE_BYTES, imageType } from './figures';
import { pageReviewSchema, validatePages } from './page-review';
import { materialDir, scopedFile } from './storage';
import { isMissingFile } from './voicing';

export const reviewDirectory = (materialId: string, jobId: string) =>
	join(materialDir(materialId), 'reviews', idSchema.parse(jobId));

const signature = (units: Unit[]) =>
	createHash('sha256').update(JSON.stringify(units)).digest('hex');

export async function readReviewBatch(root: string, offset: number, units: Unit[]) {
	const json = await readFile(join(root, String(offset), 'batch.json'), 'utf8').catch((cause) => {
		if (isMissingFile(cause)) return undefined;
		throw cause;
	});
	if (json === undefined) return;
	const data = JSON.parse(json);
	if (data.signature !== signature(units))
		throw new Error('The prepared document changed. Discard saved progress to process it again.');
	return validatePages(data, units);
}

/** Give every figure a server-owned name and validate the block before publishing any files. */
export async function prepareReviewBatch(
	raw: unknown,
	units: Unit[],
	files: string,
	offset: number
) {
	const data = pageReviewSchema.parse(raw);
	validatePages(data, units);
	const figures: { source: string; name: string }[] = [];
	for (const page of data.pages) {
		const paths = new Map<string, string>();
		for (const asset of page.assets) {
			const source = await scopedFile(files, asset.path).catch(() => {
				throw new Error(`The asset ${asset.path} does not exist. Crop it with crop_image.`);
			});
			if ((await stat(source)).size > MAX_FIGURE_BYTES)
				throw new Error('An extracted figure exceeds 8 MiB.');
			if (!imageType(await readFile(source)))
				throw new Error('The extracted figure must be a PNG, JPEG or WebP image.');
			const name = `figure-${figures.length + 1}`;
			figures.push({ source, name });
			paths.set(asset.path, `${offset}/${name}`);
			asset.path = `${offset}/${name}`;
		}
		for (const chunk of page.chunks)
			chunk.text = chunk.text.replace(
				FIGURE_REFERENCE,
				(_, open, path, close) => `${open}figure:${paths.get(path)}${close}`
			);
	}
	return { data, pages: validatePages(data, units), figures };
}

/** The caller holds the job lock. The rename commits the whole block, including its figures. */
export async function saveReviewBatch(
	root: string,
	offset: number,
	units: Unit[],
	batch: Awaited<ReturnType<typeof prepareReviewBatch>>
) {
	await mkdir(root, { recursive: true, mode: 0o700 });
	const temp = await mkdtemp(join(root, '.pending-'));
	try {
		for (const { source, name } of batch.figures) await copyFile(source, join(temp, name));
		await writeFile(
			join(temp, 'batch.json'),
			JSON.stringify({ signature: signature(units), ...batch.data }),
			{ mode: 0o600 }
		);
		await rename(temp, join(root, String(offset)));
	} finally {
		await rm(temp, { recursive: true, force: true });
	}
}
