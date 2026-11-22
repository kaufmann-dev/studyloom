import { describe, expect, it } from 'vitest';
import { assemblePages, figureProblem, validatePages, pageBatches } from './page-review';
const unit = { locator: 'page:121', text: 'table', image: 'pages/page-121.jpg' };
const page = {
	locator: unit.locator,
	outcome: 'readable',
	chunks: [{ text: '|Cost|Value|\n|---|---|\n|Material|898366|' }],
	assets: [],
	notes: ''
};
describe('figure references', () => {
	const figure = { path: 'figures/ab12cd34.png', label: 'Cycle', mimeType: 'image/png' };
	const text = 'The cycle:\n\n![Cycle](figure:figures/ab12cd34.png)\n\nMoney flows in a circle.';
	it('accepts a figure that is declared and shown', () => {
		expect(figureProblem([{ text }], [figure])).toBeUndefined();
		const withFigure = {
			...page,
			chunks: [{ text }],
			assets: [figure]
		};
		expect(validatePages({ pages: [withFigure] }, [unit])[0].assets).toEqual([
			{ ...figure, locator: unit.locator }
		]);
	});
	it('rejects a reference without its asset and an asset nobody shows', () => {
		expect(figureProblem([{ text }], [])).toContain('not listed in assets');
		expect(figureProblem([{ text: 'No picture.' }], [figure])).toContain('not referenced');
		expect(figureProblem([{ text }], [figure, figure])).toContain('twice');
		expect(() =>
			validatePages({ pages: [{ ...page, chunks: [{ text }] }] }, [unit])
		).toThrow('page:121');
	});
});
describe('page review validation', () => {
	it('retains page-owned tables', () =>
		expect(assemblePages(validatePages({ pages: [page] }, [unit])).status).toBe('ready'));
	it('rejects missing and duplicate records', () => {
		expect(() => validatePages({ pages: [] }, [unit])).toThrow();
		expect(() => validatePages({ pages: [page, page] }, [unit])).toThrow();
	});
	it('rejects records for other pages', () =>
		expect(() => validatePages({ pages: [{ ...page, locator: 'page:122' }] }, [unit])).toThrow(
			'"page:121"'
		));
	it('gives chunks the locators of their unit, whatever Claude wrote', () => {
		const chunks = [
			{ locator: 'page:121#intro', text: 'Intro' },
			{ locator: 'page:121#q1', kind: 'exercise', text: '1. Why?' }
		];
		expect(validatePages({ pages: [{ ...page, chunks }] }, [unit])[0].chunks).toEqual([
			{ locator: 'page:121#1', kind: 'text', text: 'Intro' },
			{ locator: 'page:121#2', kind: 'exercise', text: '1. Why?' }
		]);
		expect(validatePages({ pages: [page] }, [unit])[0].chunks[0].locator).toBe('page:121');
	});
	it('requires limitations for unreadable pages', () =>
		expect(() =>
			validatePages({ pages: [{ ...page, outcome: 'unreadable', chunks: [] }] }, [unit])
		).toThrow());
	it('does not mark blank pages partial', () => {
		const blank = validatePages({ pages: [{ ...page, outcome: 'blank', chunks: [] }] }, [unit]);
		expect(assemblePages([...validatePages({ pages: [page] }, [unit]), ...blank]).status).toBe(
			'ready'
		);
	});
	it('marks mixed readable and unreadable content partial', () => {
		const unreadable = validatePages(
			{ pages: [{ ...page, outcome: 'unreadable', chunks: [], notes: 'Small labels unreadable' }] },
			[unit]
		);
		expect(assemblePages([...validatePages({ pages: [page] }, [unit]), ...unreadable]).status).toBe(
			'partial'
		);
	});
});

it('batches 228 pages into 29 ordered batches without gaps', () => {
	const units = Array.from({ length: 228 }, (_, i) => ({ locator: `page:${i + 1}`, text: 'text' }));
	const batches = pageBatches(units);
	expect(batches).toHaveLength(29);
	expect(batches.at(-1)?.units).toHaveLength(4);
	expect(batches.flatMap((batch) => batch.units)).toEqual(units);
});

it('preserves preparation limitations even when the model says ready', () => {
	const unit = {
		locator: 'sheet:Budget!A1:B2',
		text: 'data',
		limitations: ['Formula error at B2']
	};
	const pages = validatePages(
		{
			pages: [
				{
					locator: unit.locator,
					outcome: 'readable',
					chunks: [{ text: 'table' }],
					assets: [],
					notes: ''
				}
			]
		},
		[unit]
	);
	expect(assemblePages(pages)).toMatchObject({
		status: 'partial',
		notes: expect.stringContaining('Formula error at B2')
	});
});
it('bounds review batches by text volume as well as unit count', () => {
	const units = Array.from({ length: 3 }, (_, i) => ({
		locator: `sheet:S!A${i}`,
		text: 'x'.repeat(60000)
	}));
	expect(pageBatches(units).map((batch) => batch.units.length)).toEqual([1, 1, 1]);
});
