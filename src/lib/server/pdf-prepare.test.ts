import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import { runTool } from './commands';
import { prepareSource } from './extract';
vi.mock('./commands', () => ({ runTool: vi.fn() }));
it('renders every dense table/vector page and OCRs blank/scanned pages in order', async () => {
	const dir = await mkdtemp(join(tmpdir(), 'studyloom-pdf-'));
	try {
		await mkdir(join(dir, 'files'));
		const input = join(dir, 'files', 'input.pdf');
		await writeFile(input, '%PDF-1.7');
		vi.mocked(runTool).mockImplementation(async (_dir, command, args) => {
			if (command === 'pdfinfo') return 'Pages: 228';
			if (command === 'pdftotext')
				await writeFile(
					join(dir, 'files', 'converted/text.txt'),
					Array.from({ length: 228 }, (_, i) =>
						i === 227 ? '' : 'Dense table or vector diagram text '.repeat(30)
					).join('\f') + '\f'
				);
			if (command === 'tesseract') return '';
			if (command === 'pdftoppm')
				await writeFile(
					join(dir, 'files', `${args.at(-1)}.${args.includes('-jpeg') ? 'jpg' : 'png'}`),
					'image'
				);
			return '';
		});
		const result = await prepareSource(input, dir, AbortSignal.timeout(10000), () => {});
		expect(result?.type).toBe('review');
		if (result?.type !== 'review') throw new Error('Expected review');
		expect(result.units).toHaveLength(228);
		expect(result.units.every((unit) => unit.image?.endsWith('.jpg'))).toBe(true);
		expect(result.units.at(-1)).toMatchObject({ locator: 'page:228', ocr: true });
		expect(runTool).toHaveBeenCalledWith(
			dir,
			'tesseract',
			expect.arrayContaining(['eng+deu']),
			expect.anything()
		);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});
