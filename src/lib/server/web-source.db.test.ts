import { describe, expect, it, vi } from 'vitest';
import type { RequestEvent } from '@sveltejs/kit';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { eq } from 'drizzle-orm';
import { api } from './api';
import { ClientError } from './config';
import { db, closeDatabase } from './db';
import { jobs, materials, projects } from './db/schema';
import { fetchWebPage } from './web-page';

vi.mock('./muse', async (importOriginal) => ({
	...(await importOriginal<typeof import('./muse')>()),
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
	it('stores the downloaded copy, queues extraction and can retry from the copy', async () => {
		const previousDatabaseUrl = process.env.DATABASE_URL;
		const previousDataDir = process.env.DATA_DIR;
		process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
		const data = await mkdtemp(join(tmpdir(), 'studyloom-web-'));
		process.env.DATA_DIR = data;
		const [project] = await db().insert(projects).values({ name: 'Leadership' }).returning();
		const call = (path: string, body: unknown) => {
			const request = new Request(`https://studyloom.test${path}`, {
				method: 'POST',
				body: JSON.stringify(body),
				headers: { 'content-type': 'application/json' }
			});
			return api({
				url: new URL(request.url),
				request,
				locals: { session: { subject: 'test', name: 'Test' } }
			} as RequestEvent);
		};
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
			const retry = await call(`/api/materials/${materialId}/retry`, { modelId: 'test-model' });
			expect(retry.status).toBe(202);
			expect((await retry.json()).jobId).not.toBe(jobId);
			expect(fetchWebPage).toHaveBeenCalledTimes(1);
			expect(await readFile(join(data, 'materials', materialId, 'original'))).toEqual(page.body);

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
			await rm(data, { recursive: true, force: true });
			if (previousDatabaseUrl === undefined) delete process.env.DATABASE_URL;
			else process.env.DATABASE_URL = previousDatabaseUrl;
			if (previousDataDir === undefined) delete process.env.DATA_DIR;
			else process.env.DATA_DIR = previousDataDir;
		}
	});
});
