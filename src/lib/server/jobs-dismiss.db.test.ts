import { describe, expect, it, vi } from 'vitest';
import { access, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { eq } from 'drizzle-orm';
import { db, closeDatabase } from './db';
import { jobs, projects } from './db/schema';
import { audioDir } from './audio';
import { outputDir } from './outline';
import { callApi, useTestDatabase } from './testing';

vi.mock('./claude', async (importOriginal) => ({
	...(await importOriginal<typeof import('./claude')>()),
	offeredModel: vi.fn(async (modelId: string) => (modelId === 'opus' ? modelId : 'default'))
}));

const exists = (path: string) =>
	access(path).then(
		() => true,
		() => false
	);

describe.skipIf(!process.env.TEST_DATABASE_URL)('Interrupted jobs', () => {
	it('dismisses a failed job with its retry files and retries with a model still offered', async () => {
		const test = await useTestDatabase('dismiss');
		const [project] = await db().insert(projects).values({ name: 'Physics' }).returning();
		try {
			const job = async (status: 'failed' | 'running', modelId: string) =>
				(
					await db()
						.insert(jobs)
						.values({
							projectId: project.id,
							kind: 'lesson',
							queue: 'interactive',
							status,
							error: status === 'failed' ? 'This model is no longer available.' : null,
							payload: { modelId }
						})
						.returning()
				)[0];
			const failed = await job('failed', 'retired-model');
			await mkdir(outputDir(failed.id), { recursive: true });
			await writeFile(join(outputDir(failed.id), 'plan.json'), '{}');
			await mkdir(audioDir(failed.id), { recursive: true });

			const running = await job('running', 'opus');
			const refused = await callApi(`/api/jobs/${running.id}`, { method: 'DELETE' }).catch(
				(cause) => cause
			);
			expect(refused).toMatchObject({ status: 409 });

			expect((await callApi(`/api/jobs/${failed.id}`, { method: 'DELETE' })).status).toBe(200);
			expect(await db().select().from(jobs).where(eq(jobs.id, failed.id))).toEqual([]);
			expect(await exists(outputDir(failed.id))).toBe(false);
			expect(await exists(audioDir(failed.id))).toBe(false);

			// A retry with a model Claude Code no longer offers runs on the default instead.
			const retired = await job('failed', 'retired-model');
			const kept = await job('failed', 'opus');
			for (const { id } of [retired, kept])
				expect((await callApi(`/api/jobs/${id}/retry`, { body: {} })).status).toBe(202);
			const [retried] = await db().select().from(jobs).where(eq(jobs.id, retired.id));
			const [unchanged] = await db().select().from(jobs).where(eq(jobs.id, kept.id));
			expect(retried).toMatchObject({ status: 'queued', payload: { modelId: 'default' } });
			expect(unchanged.payload).toEqual({ modelId: 'opus' });
		} finally {
			await db().delete(projects).where(eq(projects.id, project.id));
			await closeDatabase();
			await test.restore();
		}
	});
});
