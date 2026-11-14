import { describe, expect, it, vi } from 'vitest';
import { readFile, readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { eq } from 'drizzle-orm';
import { ClientError } from './config';
import { db, closeDatabase } from './db';
import { jobs, materials, projects } from './db/schema';
import { callApi, useTestDatabase } from './testing';
import { fetchWebPage } from './web-page';

vi.mock('./claude', async (importOriginal) => ({
	...(await importOriginal<typeof import('./claude')>()),
	validateModel: vi.fn(async () => {})
}));
vi.mock('./web-page', () => ({ fetchWebPage: vi.fn() }));

const page = {
	url: 'https://example.test/articles/compass',
	name: 'The compass',
	filename: 'The compass.html',
	mimeType: 'text/html',
	body: Buffer.from('<title>The compass</title><p>North.</p>')
};

describe.skipIf(!process.env.TEST_DATABASE_URL)('Web page sources', () => {
	it('stores the downloaded copy, queues extraction and can process the copy again', async () => {
		const environment = await useTestDatabase('web');
		const { data } = environment;
		const [project] = await db().insert(projects).values({ name: 'Leadership' }).returning();
		const call = (path: string, body: unknown) => callApi(path, { body });
		try {
			vi.mocked(fetchWebPage).mockResolvedValueOnce(page);
			const response = await call(`/api/projects/${project.id}/web-sources`, {
				url: ' https://example.test/articles/compass ',
				modelId: 'test-model'
			});
			expect(response.status).toBe(202);
			expect(fetchWebPage).toHaveBeenLastCalledWith('https://example.test/articles/compass');
			const { materialId, jobId } = await response.json();

			const [material] = await db().select().from(materials).where(eq(materials.id, materialId));
			expect(material).toMatchObject({
				projectId: project.id,
				name: 'The compass',
				filename: 'The compass.html',
				mimeType: 'text/html',
				kind: 'file',
				status: 'processing',
				size: page.body.length,
				receivedBytes: page.body.length,
				sourceUrl: page.url
			});
			expect(await readFile(join(data, 'materials', materialId, 'original'))).toEqual(page.body);
			const [job] = await db().select().from(jobs).where(eq(jobs.id, jobId));
			expect(job).toMatchObject({
				kind: 'ingest',
				status: 'queued',
				materialId,
				payload: { modelId: 'test-model' }
			});

			// A failed extraction is retried from the stored copy; the page is not downloaded again.
			await db().update(jobs).set({ status: 'failed' }).where(eq(jobs.id, jobId));
			await db().update(materials).set({ status: 'failed' }).where(eq(materials.id, materialId));
			const retry = await call(`/api/materials/${materialId}/process`, { modelId: 'test-model' });
			expect(retry.status).toBe(202);
			expect((await retry.json()).jobId).not.toBe(jobId);
			expect(fetchWebPage).toHaveBeenCalledTimes(1);
			expect(await readFile(join(data, 'materials', materialId, 'original'))).toEqual(page.body);

			// A source that is already extracted can be processed again; until the new result is
			// saved it stays usable, and a cancelled run leaves it as it was.
			await db().update(jobs).set({ status: 'failed' }).where(eq(jobs.materialId, materialId));
			await db()
				.update(materials)
				.set({ status: 'ready', notes: 'Read in full.' })
				.where(eq(materials.id, materialId));
			const again = await call(`/api/materials/${materialId}/process`, { modelId: 'test-model' });
			const reprocess = (await again.json()).jobId;
			const [queued] = await db().select().from(jobs).where(eq(jobs.id, reprocess));
			expect(queued.payload).toMatchObject({
				previous: { status: 'ready', notes: 'Read in full.' }
			});
			await call(`/api/jobs/${reprocess}/cancel`, {});
			const [restored] = await db().select().from(materials).where(eq(materials.id, materialId));
			expect(restored).toMatchObject({ status: 'ready', notes: 'Read in full.' });

			// While a job reads the source, it cannot be replaced underneath it.
			const [reader] = await db()
				.insert(jobs)
				.values({
					projectId: project.id,
					kind: 'quiz',
					queue: 'background',
					payload: { materialIds: [materialId] }
				})
				.returning();
			const blocked = await call(`/api/materials/${materialId}/process`, {
				modelId: 'test-model'
			}).catch((cause) => cause);
			expect(blocked).toMatchObject({ status: 409 });
			await db().delete(jobs).where(eq(jobs.id, reader.id));

			// Processing can be put off: the page is downloaded and stored, and nothing is queued.
			vi.mocked(fetchWebPage).mockResolvedValueOnce(page);
			const later = await call(`/api/projects/${project.id}/web-sources`, {
				url: 'https://example.test/articles/compass',
				modelId: 'test-model',
				process: false
			});
			const storedOnly = await later.json();
			expect(storedOnly.jobId).toBeUndefined();
			const [waiting] = await db()
				.select()
				.from(materials)
				.where(eq(materials.id, storedOnly.materialId));
			expect(waiting.status).toBe('stored');
			const started = await call(`/api/materials/${storedOnly.materialId}/process`, {
				modelId: 'test-model'
			});
			expect(started.status).toBe(202);
			const [processing] = await db()
				.select()
				.from(materials)
				.where(eq(materials.id, storedOnly.materialId));
			expect(processing.status).toBe('processing');
			await db().delete(materials).where(eq(materials.id, storedOnly.materialId));
			await rm(join(data, 'materials', storedOnly.materialId), { recursive: true, force: true });

			// A page that cannot be downloaded leaves no source behind.
			vi.mocked(fetchWebPage).mockRejectedValueOnce(
				new ClientError(400, 'The page was not found.')
			);
			const failed = await call(`/api/projects/${project.id}/web-sources`, {
				url: 'https://example.test/gone',
				modelId: 'test-model'
			}).catch((cause) => cause);
			expect(failed).toMatchObject({ status: 400 });
			const rejected = await call(`/api/projects/${project.id}/web-sources`, {
				url: 'ftp://example.test/file',
				modelId: 'test-model'
			}).catch((cause) => cause);
			expect(rejected).toMatchObject({ status: 400 });
			expect(
				await db().select().from(materials).where(eq(materials.projectId, project.id))
			).toHaveLength(1);
			expect(await readdir(join(data, 'materials'))).toEqual([materialId]);
		} finally {
			await db().delete(projects).where(eq(projects.id, project.id));
			await closeDatabase();
			await environment.restore();
		}
	});
});
