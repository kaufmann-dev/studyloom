import { readFile, stat } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { z } from 'zod';
import { runTool } from './commands';
import type { Unit } from './extract';

const manifestSchema = z.object({
	spreadsheet: z.boolean(),
	units: z
		.array(
			z.object({
				locator: z.string().min(1).max(280),
				text: z.string().max(150000),
				pdf: z.string().regex(/^converted\/workbook\/region-\d+\.pdf$/),
				limitations: z.array(z.string())
			})
		)
		.max(2000)
});

/** Structured cell data and bounded visual regions, never a lossy CSV intermediary. */
export async function spreadsheetUnits(
	jobDir: string,
	input: string,
	signal: AbortSignal,
	progress: (text: string) => void
): Promise<Unit[] | undefined> {
	progress('Reading workbook cells, formulas and charts');
	await runTool(
		jobDir,
		'/usr/bin/python3',
		[resolve('scripts/prepare-spreadsheet.py'), input, 'converted/workbook'],
		{ signal, timeoutMs: 30 * 60_000 }
	);
	const files = join(jobDir, 'files');
	const manifest = join(files, 'converted/workbook/manifest.json');
	if ((await stat(manifest)).size > 64 * 1024 * 1024)
		throw new Error('Workbook manifest exceeds the extraction limit.');
	const result = manifestSchema.parse(JSON.parse(await readFile(manifest, 'utf8')));
	if (!result.spreadsheet) return undefined;
	const units: Unit[] = [];
	for (const [i, unit] of result.units.entries()) {
		signal.throwIfAborted();
		progress(`Rendering spreadsheet region ${i + 1} of ${result.units.length}`);
		const info = await runTool(jobDir, 'pdfinfo', [unit.pdf], { signal, timeoutMs: 60000 });
		if (Number(info.match(/^Pages:\s+(\d+)/m)?.[1]) !== 1)
			throw new Error('Spreadsheet region did not render to exactly one page.');
		const prefix = `converted/workbook/region-${i}`;
		await runTool(
			jobDir,
			'pdftoppm',
			[
				'-r',
				'150',
				'-scale-to',
				'2000',
				'-jpeg',
				'-jpegopt',
				'quality=85',
				'-singlefile',
				unit.pdf,
				prefix
			],
			{ signal, timeoutMs: 120000 }
		);
		const image = `${prefix}.jpg`;
		if ((await stat(join(files, image))).size > 8 * 1024 * 1024)
			throw new Error('Spreadsheet image exceeds the review limit.');
		units.push({ locator: unit.locator, text: unit.text, image, limitations: unit.limitations });
	}
	if (new Set(units.map((unit) => unit.locator)).size !== units.length)
		throw new Error('Duplicate spreadsheet region.');
	return units;
}
