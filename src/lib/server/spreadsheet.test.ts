import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { runTool } from './commands';
import { spreadsheetUnits } from './spreadsheet';
vi.mock('./commands', () => ({ runTool: vi.fn() }));
let dir: string;
const signal = () => AbortSignal.timeout(10000);
const chart = {
	locator: "sheet:'Chart only'!A1:H30",
	text: JSON.stringify({ cells: [], charts: [{ name: 'Sales', sourceRanges: ['Data!A1:B3'] }] }),
	pdf: 'converted/workbook/region-0.pdf',
	limitations: []
};
beforeEach(async () => {
	dir = await mkdtemp(join(tmpdir(), 'studyloom-sheet-'));
	await mkdir(join(dir, 'files/converted/workbook'), { recursive: true });
	vi.mocked(runTool).mockReset();
	vi.mocked(runTool).mockImplementation(async (_dir, command, args) => {
		if (command === 'pdfinfo') return 'Pages: 1';
		if (command === 'pdftoppm') await writeFile(join(dir, 'files', `${args.at(-1)}.jpg`), 'render');
		return '';
	});
});
afterEach(() => rm(dir, { recursive: true, force: true }));
const manifest = (units: unknown[]) =>
	writeFile(
		join(dir, 'files/converted/workbook/manifest.json'),
		JSON.stringify({ spreadsheet: true, units })
	);
it('keeps chart-only sheets and exact sheet range locators', async () => {
	await manifest([chart]);
	const result = await spreadsheetUnits(dir, 'input.xlsx', signal(), () => {});
	expect(result).toEqual([
		{
			locator: chart.locator,
			text: chart.text,
			image: 'converted/workbook/region-0.jpg',
			limitations: []
		}
	]);
	expect(runTool).toHaveBeenCalledWith(
		dir,
		'/usr/bin/python3',
		[resolve('scripts/prepare-spreadsheet.py'), 'input.xlsx', 'converted/workbook'],
		expect.anything()
	);
});
it('retains formula limitations for review', async () => {
	await manifest([{ ...chart, limitations: ['Formula error at B2'] }]);
	expect((await spreadsheetUnits(dir, 'input.ods', signal(), () => {}))?.[0].limitations).toEqual([
		'Formula error at B2'
	]);
});
it('rejects extra pages rather than losing visual content', async () => {
	await manifest([chart]);
	vi.mocked(runTool).mockImplementation(async (_dir, command) =>
		command === 'pdfinfo' ? 'Pages: 2' : ''
	);
	await expect(spreadsheetUnits(dir, 'input.xlsx', signal(), () => {})).rejects.toThrow(
		'exactly one page'
	);
});
it('rejects manifest paths outside generated workbook files', async () => {
	await manifest([{ ...chart, pdf: '../../private.pdf' }]);
	await expect(spreadsheetUnits(dir, 'input.xlsx', signal(), () => {})).rejects.toThrow();
});
it('propagates conversion failure without a CSV fallback', async () => {
	vi.mocked(runTool).mockRejectedValue(new Error('Workbook could not be opened'));
	await expect(spreadsheetUnits(dir, 'input.xlsx', signal(), () => {})).rejects.toThrow(
		'could not be opened'
	);
});
it('checks workbook cache parsing and tiling without native Office', () => {
	expect(() =>
		execFileSync('/usr/bin/python3', ['scripts/prepare-spreadsheet.test.py'], { stdio: 'pipe' })
	).not.toThrow();
});
