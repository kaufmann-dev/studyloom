import { z } from 'zod';
import { ingestionSchema } from '../domain';
import type { Ingestion, Unit } from './extract';
import { figureReferences } from './figures';

export const pageReviewSchema = z.object({
	pages: z
		.array(
			z.object({
				locator: z.string(),
				outcome: z.enum(['readable', 'partial', 'unreadable', 'blank']),
				chunks: ingestionSchema.shape.chunks,
				assets: ingestionSchema.shape.assets,
				notes: z.string().max(10000)
			})
		)
		.max(8)
});

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
	if (result.pages.length !== units.length) throw new Error('Missing page records.');
	for (const [i, unit] of units.entries()) {
		const page = result.pages[i];
		if (page.locator !== unit.locator)
			throw new Error('Page records must match assigned pages in order.');
		const owns = (locator: string) =>
			locator === unit.locator ||
			(locator.startsWith(`${unit.locator}#`) &&
				/^[1-9][0-9]*$/.test(locator.slice(unit.locator.length + 1)));
		if (page.chunks.some((c) => !owns(c.locator)) || page.assets.some((a) => !owns(a.locator)))
			throw new Error('Invalid page locator.');
		if (new Set(page.chunks.map((c) => c.locator)).size !== page.chunks.length)
			throw new Error('Duplicate chunk locator.');
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
	return result.pages;
}

export function assemblePages(pages: z.infer<typeof pageReviewSchema>['pages']): Ingestion {
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
