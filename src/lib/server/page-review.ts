import { z } from 'zod';
import { ingestionSchema } from '../domain';
import type { Ingestion, Unit } from './extract';

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

export function validatePages(value: unknown, units: Unit[]) {
	const result = pageReviewSchema.parse(value);
	if (result.pages.length !== units.length) throw new Error('Missing page records.');
	for (const [i, unit] of units.entries()) {
		const page = result.pages[i];
		if (page.locator !== unit.locator)
			throw new Error('Page records must match assigned pages in order.');
		const owns = (locator: string) =>
			locator === unit.locator || new RegExp(`^${unit.locator}#[1-9][0-9]*$`).test(locator);
		if (page.chunks.some((c) => !owns(c.locator)) || page.assets.some((a) => !owns(a.locator)))
			throw new Error('Invalid page locator.');
		if (new Set(page.chunks.map((c) => c.locator)).size !== page.chunks.length)
			throw new Error('Duplicate chunk locator.');
		if ((page.outcome === 'blank' || page.outcome === 'unreadable') && page.chunks.length)
			throw new Error('Unreadable/blank page has chunks.');
		if (page.outcome === 'readable' && !page.chunks.length)
			throw new Error('Readable page has no chunks.');
		if (['partial', 'unreadable'].includes(page.outcome) && !page.notes.trim())
			throw new Error('Missing page limitation.');
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
	return Array.from({ length: Math.ceil(units.length / 8) }, (_, i) => ({
		offset: i * 8,
		units: units.slice(i * 8, i * 8 + 8)
	}));
}
