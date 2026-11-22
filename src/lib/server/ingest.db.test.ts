import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { asc, eq } from 'drizzle-orm';
import { claudeRun, ClaudeUsageLimit } from './claude';
import { db, closeDatabase } from './db';
import { assets, jobs, materials, projects, sourceChunks } from './db/schema';
import { prepareSource } from './extract';
import { ingest, runJob } from './jobs';
import { materialDir, originalPath } from './storage';
import { reviewDirectory } from './review-checkpoints';
import { callApi, useTestDatabase } from './testing';

vi.mock('./claude', async (importOriginal) => ({
	...(await importOriginal<typeof import('./claude')>()),
	offeredModel: vi.fn(async () => 'default'),
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
								chunks: [{ text: 'Water follows salt.' }],
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
									{ text: `The cycle:\n\n![Cycle](figure:${figure})` },
									{ kind: 'exercise', text: '1. Who takes part?' }
								],
								assets: [{ path: figure, label: 'Cycle', mimeType: 'text/plain' }],
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
	it('resumes a 200-page document in a fresh worker workspace without repeating saved pages', async () => {
		const environment = await useTestDatabase('review-resume');
		const { material, job } = await queue(environment.data, 'large.pdf', '%PDF-1.7');
		const root = reviewDirectory(material.id, job.id);
		const units = Array.from({ length: 200 }, (_, i) => ({
			locator: `page:${i + 1}`,
			image: `pages/${i + 1}.jpg`,
			text: `Page ${i + 1}`
		}));
		const firstPages: number[] = [];
		const limit = new Date('2027-01-15T08:00:00Z');
		let stopAt = 1;
		const png = Buffer.from('89504e470d0a1a0a', 'hex');
		const current = async () => (await db().select().from(jobs).where(eq(jobs.id, job.id)))[0];
		const retry = () => callApi(`/api/jobs/${job.id}/retry`, { body: {} });
		const runQueued = async () => {
			const [claimed] = await db()
				.update(jobs)
				.set({ status: 'running', leaseOwner: 'next-worker' })
				.where(eq(jobs.id, job.id))
				.returning();
			await runJob(claimed, AbortSignal.timeout(15000));
		};
		try {
			vi.mocked(prepareSource).mockResolvedValue({ type: 'review', kind: 'pdf', units });
			vi.mocked(claudeRun).mockImplementation(async ({ workspace, requiredImages }) => {
				const first = Number(requiredImages![0].match(/(\d+)\.jpg$/)![1]);
				firstPages.push(first);
				if (first === stopAt)
					throw new ClaudeUsageLimit('Usage exhausted', first === 1 ? null : limit);
				const image = first === 1;
				if (image) await writeFile(join(workspace, 'files', 'figure.png'), png);
				const pages = units.slice(first - 1, first - 1 + requiredImages!.length).map((unit, i) => ({
					locator: unit.locator,
					outcome: 'readable',
					notes: '',
					chunks: [{ text: image && !i ? '![Example](figure:figure.png)' : unit.text }],
					assets:
						image && !i ? [{ path: 'figure.png', label: 'Example', mimeType: 'image/png' }] : []
				}));
				await writeFile(
					join(workspace, 'files', `review-${first - 1}-result.json`),
					JSON.stringify({ pages })
				);
				return { text: 'Saved.', stderr: '' };
			});
			await runJob(job, AbortSignal.timeout(15000));
			expect(await current()).toMatchObject({
				status: 'paused',
				resetsAt: null,
				review: { saved: 0, total: 200, unit: 'pages' }
			});
			stopAt = 97;
			await Promise.all([retry(), retry()]);
			await runQueued();
			expect(await current()).toMatchObject({
				status: 'paused',
				resetsAt: limit,
				review: { saved: 96 }
			});
			expect((await stored(material.id)).chunks).toHaveLength(0);
			await db()
				.insert(jobs)
				.values(
					Array.from({ length: 101 }, () => ({
						projectId: material.projectId,
						kind: 'summary' as const,
						queue: 'background' as const,
						status: 'succeeded' as const
					}))
				);
			const workspace = await (await callApi(`/api/projects/${material.projectId}`)).json();
			expect(workspace.jobs).toContainEqual(
				expect.objectContaining({ id: job.id, status: 'paused', resetsAt: limit.toISOString() })
			);
			// An uncommitted directory left by a crashed writer must be ignored.
			await mkdir(join(root, '.pending-incomplete'));
			stopAt = 0;
			firstPages.length = 0;
			await retry();
			await runQueued();
			expect(firstPages).toEqual(Array.from({ length: 13 }, (_, i) => 97 + 8 * i));
			expect(await current()).toMatchObject({ status: 'succeeded' });
			const result = await stored(material.id);
			expect(result.chunks.map((chunk) => chunk.locator)).toEqual(
				units.map((unit) => unit.locator)
			);
			const figures = await db().select().from(assets).where(eq(assets.materialId, material.id));
			expect(figures).toHaveLength(1);
			expect(await readFile(figures[0].path)).toEqual(png);
			expect(result.chunks[0].text).toBe(`![Example](asset:${figures[0].id})`);
			await expect(readdir(root)).rejects.toMatchObject({ code: 'ENOENT' });
		} finally {
			await db().delete(projects).where(eq(projects.id, material.projectId));
			await closeDatabase();
			await environment.restore();
		}
	});
	it.each(['discard', 'material', 'project'] as const)(
		'cleans up paused review files on %s',
		async (action) => {
			const environment = await useTestDatabase('review-cleanup');
			const { material, job } = await queue(environment.data, 'notes.pdf', '%PDF-1.7');
			try {
				await db()
					.update(jobs)
					.set({
						status: 'paused',
						leaseOwner: null,
						review: { total: 16, saved: 8, unit: 'pages' }
					})
					.where(eq(jobs.id, job.id));
				const root = reviewDirectory(material.id, job.id);
				await mkdir(root, { recursive: true });
				await writeFile(join(root, 'saved'), 'saved');
				const path =
					action === 'discard'
						? `/api/jobs/${job.id}`
						: action === 'material'
							? `/api/materials/${material.id}`
							: `/api/projects/${material.projectId}`;
				expect((await callApi(path, { method: 'DELETE' })).status).toBe(200);
				await expect(readdir(root)).rejects.toMatchObject({ code: 'ENOENT' });
				if (action === 'discard') {
					expect((await stored(material.id)).material.status).toBe('stored');
					expect(await readFile(originalPath(material.id), 'utf8')).toBe('%PDF-1.7');
				}
			} finally {
				await db().delete(projects).where(eq(projects.id, material.projectId));
				await closeDatabase();
				await environment.restore();
			}
		}
	);
});
