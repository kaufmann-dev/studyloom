import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { asc, eq } from 'drizzle-orm';
import { claudeRun } from './claude';
import { db, closeDatabase } from './db';
import { assets, jobs, materials, projects, sourceChunks } from './db/schema';
import { prepareSource } from './extract';
import { ingest } from './jobs';
import { materialDir, originalPath } from './storage';
import { useTestDatabase } from './testing';

vi.mock('./claude', async (importOriginal) => ({
	...(await importOriginal<typeof import('./claude')>()),
	claudeRun: vi.fn()
}));
vi.mock('./extract', async (importOriginal) => {
	const actual = await importOriginal<typeof import('./extract')>();
	return { ...actual, prepareSource: vi.fn(actual.prepareSource) };
});

/** A source and its ingest job, leased by this test as a worker would. */
async function queue(data: string, filename: string, content: string) {
	const [project] = await db().insert(projects).values({ name: 'Biology' }).returning();
	const [material] = await db()
		.insert(materials)
		.values({
			projectId: project.id,
			name: filename,
			filename,
			mimeType: 'application/octet-stream',
			kind: 'file',
			status: 'processing'
		})
		.returning();
	await mkdir(materialDir(material.id), { recursive: true });
	await writeFile(originalPath(material.id), content);
	const [job] = await db()
		.insert(jobs)
		.values({
			projectId: project.id,
			materialId: material.id,
			kind: 'ingest',
			queue: 'background',
			status: 'running',
			leaseOwner: 'test-worker',
			payload: { modelId: 'default' }
		})
		.returning();
	const workspace = join(data, 'jobs', job.id);
	await mkdir(join(workspace, 'files'), { recursive: true });
	const run = () => ingest(job, workspace, AbortSignal.timeout(10_000), () => {});
	return { material, job, workspace, run };
}
const stored = async (materialId: string) => ({
	material: (await db().select().from(materials).where(eq(materials.id, materialId)))[0],
	chunks: await db()
		.select({ locator: sourceChunks.locator, text: sourceChunks.text })
		.from(sourceChunks)
		.where(eq(sourceChunks.materialId, materialId))
		.orderBy(asc(sourceChunks.ordinal))
});
/** Claude saves the extraction the prompt asks for. */
const writesExtraction = (workspace: string) =>
	vi.mocked(claudeRun).mockImplementationOnce(async () => {
		await writeFile(
			join(workspace, 'files', 'extracted.json'),
			JSON.stringify({
				status: 'ready',
				notes: '',
				chunks: [{ locator: 'page:1', text: 'Water follows salt.' }],
				assets: []
			})
		);
		return { text: 'Saved.', stderr: '' };
	});

describe.skipIf(!process.env.TEST_DATABASE_URL)('Source ingestion', () => {
	it('stores text files directly, reviews prepared documents and leaves the rest to Claude', async () => {
		const environment = await useTestDatabase('ingest');
		const { data } = environment;
		try {
			// Plain text needs no model run.
			const text = await queue(data, 'notes.md', '# Osmosis\n\nWater follows salt.');
			await text.run();
			expect(claudeRun).not.toHaveBeenCalled();
			expect(await stored(text.material.id)).toMatchObject({
				material: { status: 'ready' },
				chunks: [{ locator: 'part:1', text: '# Osmosis\n\nWater follows salt.' }]
			});
			const [done] = await db().select().from(jobs).where(eq(jobs.id, text.job.id));
			expect(done.status).toBe('succeeded');

			// A document the server extracted goes to Claude as prepared page text to review.
			const pdf = await queue(data, 'lecture.pdf', '%PDF-1.7');
			vi.mocked(prepareSource).mockResolvedValueOnce({
				type: 'review',
				kind: 'pdf',
				units: [
					{
						locator: 'page:1',
						text: 'UNIVERSITY LOGO\nWater follows salt.',
						image: 'pages/page-001.jpg'
					}
				]
			});
			vi.mocked(claudeRun).mockImplementationOnce(async () => {
				await writeFile(
					join(pdf.workspace, 'files', 'review-0-result.json'),
					JSON.stringify({
						pages: [
							{
								locator: 'page:1',
								outcome: 'readable',
								chunks: [{ locator: 'page:1', text: 'Water follows salt.' }],
								assets: [],
								notes: ''
							}
						]
					})
				);
				return { text: 'Done', stderr: '' };
			});
			await pdf.run();
			expect(vi.mocked(claudeRun).mock.calls[0][0].requiredImages).toEqual(['pages/page-001.jpg']);
			expect(await stored(pdf.material.id)).toMatchObject({
				material: { status: 'ready' },
				chunks: [{ locator: 'page:1', text: 'Water follows salt.' }]
			});

			// When preparation fails, Claude reads the file with its own tools.
			const odd = await queue(data, 'scan.xyz', 'odd');
			vi.mocked(prepareSource).mockRejectedValueOnce(new Error('pdftotext exited with 1'));
			writesExtraction(odd.workspace);
			vi.spyOn(console, 'error').mockImplementation(() => {});
			await odd.run();
			const agentic = vi.mocked(claudeRun).mock.calls[1][0];
			expect(agentic.prompt).toContain('choose tools yourself');
			expect(agentic.prompt).not.toContain('prepared.json');
			expect((await stored(odd.material.id)).material.status).toBe('ready');
		} finally {
			await closeDatabase();
			await environment.restore();
		}
	});
	it('stores cropped figures, exercise kinds and Markdown, and replaces an earlier extraction', async () => {
		const environment = await useTestDatabase('figures');
		const { data } = environment;
		const png = Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), Buffer.alloc(32)]);
		/** Claude reviews one page and crops one figure from it. */
		const reviews = async (source: Awaited<ReturnType<typeof queue>>, figure: string) => {
			vi.mocked(prepareSource).mockResolvedValueOnce({
				type: 'review',
				kind: 'pdf',
				units: [{ locator: 'page:1', text: 'Cycle', image: 'pages/page-001.jpg' }]
			});
			vi.mocked(claudeRun).mockImplementationOnce(async () => {
				await mkdir(join(source.workspace, 'files', 'figures'), { recursive: true });
				await writeFile(join(source.workspace, 'files', figure), png);
				await writeFile(
					join(source.workspace, 'files', 'review-0-result.json'),
					JSON.stringify({
						pages: [
							{
								locator: 'page:1',
								outcome: 'readable',
								chunks: [
									{ locator: 'page:1', text: `The cycle:\n\n![Cycle](figure:${figure})` },
									{ locator: 'page:1#1', kind: 'exercise', text: '1. Who takes part?' }
								],
								assets: [
									{ path: figure, label: 'Cycle', mimeType: 'text/plain', locator: 'page:1' }
								],
								notes: ''
							}
						]
					})
				);
				return { text: 'Done', stderr: '' };
			});
			await source.run();
		};
		try {
			vi.mocked(claudeRun).mockReset();
			const first = await queue(data, 'script.pdf', '%PDF-1.7');
			await reviews(first, 'figures/aaaa1111.png');
			const [asset] = await db()
				.select()
				.from(assets)
				.where(eq(assets.materialId, first.material.id));
			// The type comes from the file, and the text now names the stored asset.
			expect(asset).toMatchObject({ label: 'Cycle', mimeType: 'image/png', locator: 'page:1' });
			expect(await readFile(asset.path)).toEqual(png);
			const rows = await db()
				.select({ kind: sourceChunks.kind, text: sourceChunks.text })
				.from(sourceChunks)
				.where(eq(sourceChunks.materialId, first.material.id))
				.orderBy(asc(sourceChunks.ordinal));
			expect(rows).toEqual([
				{ kind: 'text', text: `The cycle:\n\n![Cycle](asset:${asset.id})` },
				{ kind: 'exercise', text: '1. Who takes part?' }
			]);
			expect((await stored(first.material.id)).material.contentFormat).toBe('markdown');

			// Processing the source again replaces the figure and removes the old file.
			const [again] = await db()
				.insert(jobs)
				.values({
					projectId: first.material.projectId,
					materialId: first.material.id,
					kind: 'ingest',
					queue: 'background',
					status: 'running',
					leaseOwner: 'test-worker',
					payload: { modelId: 'default' }
				})
				.returning();
			const workspace = join(data, 'jobs', again.id);
			await mkdir(join(workspace, 'files'), { recursive: true });
			await reviews(
				{
					...first,
					job: again,
					workspace,
					run: () => ingest(again, workspace, AbortSignal.timeout(10_000), () => {})
				},
				'figures/bbbb2222.png'
			);
			const after = await db()
				.select()
				.from(assets)
				.where(eq(assets.materialId, first.material.id));
			expect(after).toHaveLength(1);
			expect(after[0].id).not.toBe(asset.id);
			expect(await readdir(join(materialDir(first.material.id), 'assets'))).toEqual([after[0].id]);
		} finally {
			await closeDatabase();
			await environment.restore();
		}
	});
});
