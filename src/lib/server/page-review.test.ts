import { describe, expect, it } from 'vitest';
import { assemblePages, validatePages, pageBatches } from './page-review';
const unit = { locator: 'page:121', text: 'table', image: 'pages/page-121.jpg' };
const page = {
	locator: unit.locator,
	outcome: 'readable',
	chunks: [{ locator: unit.locator, text: '|Cost|Value|\n|---|---|\n|Material|898366|' }],
	assets: [],
	notes: ''
};
describe('page review validation', () => {
	it('retains page-owned tables', () =>
		expect(assemblePages(validatePages({ pages: [page] }, [unit])).status).toBe('ready'));
	it('rejects missing and duplicate records', () => {
		expect(() => validatePages({ pages: [] }, [unit])).toThrow();
		expect(() => validatePages({ pages: [page, page] }, [unit])).toThrow();
	});
	it('rejects chunks attributed to other pages', () =>
		expect(() =>
			validatePages({ pages: [{ ...page, chunks: [{ locator: 'page:122', text: 'wrong' }] }] }, [
				unit
			])
		).toThrow());
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
