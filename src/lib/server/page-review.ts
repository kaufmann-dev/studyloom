import { z } from 'zod';
import { chunkResultSchema, ingestionSchema } from '../domain';
import type { Ingestion, Unit } from './extract';
import { figureReferences } from './figures';

/** Claude writes a unit's chunks and figures; the server gives them the unit's locators. */
export const pageReviewSchema = z.object({
	pages: z
		.array(
			z.object({
				locator: z.string(),
				outcome: z.enum(['readable', 'partial', 'unreadable', 'blank']),
				chunks: z.array(chunkResultSchema.omit({ locator: true })).max(2000),
				assets: z
					.array(ingestionSchema.shape.assets.unwrap().element.omit({ locator: true }))
					.max(200)
					.default([]),
				notes: z.string().max(10000)
			})
		)
		.max(8)
});
export type ReviewedPage = ReturnType<typeof validatePages>[number];

/**
 * What is wrong between a text's figure references and the declared assets, if anything: every
 * reference needs its asset and every asset must be shown where it belongs.
 */
export function figureProblem(chunks: { text: string }[], assets: { path: string }[]) {
	const referenced = chunks.flatMap((chunk) => figureReferences(chunk.text));
	const declared = assets.map((asset) => asset.path);
	if (new Set(declared).size !== declared.length) return 'A figure is listed in assets twice.';
	const missing = referenced.find((path) => !declared.includes(path));
	if (missing) return `The text refers to figure:${missing}, which is not listed in assets.`;
	const unused = declared.find((path) => !referenced.includes(path));
	if (unused) return `The asset ${unused} is not referenced as ![label](figure:${unused}).`;
}

export function validatePages(value: unknown, units: Unit[]) {
	const result = pageReviewSchema.parse(value);
	if (result.pages.length !== units.length)
		throw new Error(
			`The file has ${result.pages.length} records; write exactly one per assigned unit (${units.length}).`
		);
	for (const [i, unit] of units.entries()) {
		const page = result.pages[i];
		if (page.locator !== unit.locator)
			throw new Error(
				`Record ${i + 1} has locator ${JSON.stringify(page.locator)}; the assigned units are ${units.map((u) => JSON.stringify(u.locator)).join(', ')} in this order.`
			);
		const problem = figureProblem(page.chunks, page.assets);
		if (problem) throw new Error(`${unit.locator}: ${problem}`);
		if ((page.outcome === 'blank' || page.outcome === 'unreadable') && page.chunks.length)
			throw new Error('Unreadable/blank page has chunks.');
		if (page.outcome === 'readable' && !page.chunks.length)
			throw new Error('Readable page has no chunks.');
		if (['partial', 'unreadable'].includes(page.outcome) && !page.notes.trim())
			throw new Error('Missing page limitation.');
		if (unit.limitations?.length) {
			if (page.outcome === 'readable' || page.outcome === 'blank') page.outcome = 'partial';
			page.notes = [...unit.limitations, page.notes].filter(Boolean).join('\n').slice(0, 10000);
		}
	}
	return result.pages.map((page) => ({
		...page,
		// One chunk is the unit itself; several are numbered in reading order.
		chunks: page.chunks.map((chunk, n) => ({
			...chunk,
			locator: page.chunks.length > 1 ? `${page.locator}#${n + 1}` : page.locator
		})),
		assets: page.assets.map((asset) => ({ ...asset, locator: page.locator }))
	}));
}

export function assemblePages(pages: ReviewedPage[]): Ingestion {
	const chunks = pages.flatMap((p) => p.chunks);
	return ingestionSchema.parse({
		status: !chunks.length
			? 'unreadable'
			: pages.some((p) => ['partial', 'unreadable'].includes(p.outcome))
				? 'partial'
				: 'ready',
		chunks,
		assets: pages.flatMap((p) => p.assets),
		notes: pages
			.filter((p) => p.notes)
			.map((p) => `${p.locator}: ${p.notes}`)
			.join('\n')
			.slice(0, 10000)
	});
}

export function pageBatches(units: Unit[]) {
	const batches: { offset: number; units: Unit[] }[] = [];
	let offset = 0;
	while (offset < units.length) {
		const start = offset;
		let chars = 0;
		while (offset < units.length && offset - start < 8) {
			const next = units[offset].text.length;
			if (offset > start && chars + next > 100000) break;
			chars += next;
			offset++;
		}
		batches.push({ offset: start, units: units.slice(start, offset) });
	}
	return batches;
}
