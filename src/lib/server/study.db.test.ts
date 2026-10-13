import { describe, expect, it, vi } from 'vitest';
import type { RequestEvent } from '@sveltejs/kit';
import { access, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { eq } from 'drizzle-orm';
import { api } from './api';
import { db, closeDatabase } from './db';
import { jobs, materials, outputs, projects, sourceChunks, studyAnswers } from './db/schema';
import { speak, speechCatalog } from './elevenlabs';
import { startWorkers } from './jobs';
import { museRun } from './muse';

vi.mock('./muse', async (importOriginal) => ({
	...(await importOriginal<typeof import('./muse')>()),
	validateModel: vi.fn(async () => {}),
	museRun: vi.fn()
}));
vi.mock('./elevenlabs', () => ({ speechCatalog: vi.fn(), speak: vi.fn() }));

describe.skipIf(!process.env.TEST_DATABASE_URL)('Study sessions', () => {
	it('plans and pre-voices a session, then keeps one open run with its answers', async () => {
		const previousDatabaseUrl = process.env.DATABASE_URL;
		const previousDataDir = process.env.DATA_DIR;
		process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
		const data = await mkdtemp(join(tmpdir(), 'studyloom-study-'));
		process.env.DATA_DIR = data;
		const [project] = await db().insert(projects).values({ name: 'Biology' }).returning();
		const call = (path: string, body?: unknown) => {
			const request = new Request(`https://studyloom.test${path}`, {
				method: body ? 'POST' : 'GET',
				body: body ? JSON.stringify(body) : undefined,
				headers: { 'content-type': 'application/json' }
			});
			return api({
				url: new URL(request.url),
				request,
				locals: { session: { subject: 'test', name: 'Test' } }
			} as RequestEvent);
		};
		const waitFor = async (jobId: string, status: string) => {
			for (let i = 0; i < 200; i++) {
				const [job] = await db().select().from(jobs).where(eq(jobs.id, jobId));
				if (job.status === status) return job;
				await new Promise((resolve) => setTimeout(resolve, 50));
			}
			throw new Error(`Job did not reach ${status}.`);
		};
		const stop = startWorkers();
		try {
			const [material] = await db()
				.insert(materials)
				.values({
					projectId: project.id,
					name: 'Osmosis',
					filename: 'osmosis.txt',
					mimeType: 'text/plain',
					kind: 'file',
					status: 'ready'
				})
				.returning();
			await db().insert(sourceChunks).values({
				materialId: material.id,
				ordinal: 0,
				locator: 'page:1',
				text: 'Water moves towards the side with more salt.'
			});
			vi.mocked(speechCatalog).mockResolvedValue({
				voices: [{ voiceId: 'voice1', name: 'Rachel', description: '' }],
				models: [{ modelId: 'flash', name: 'Flash', costMultiplier: 0.5, maxCharacters: 10000 }]
			});
			const citations = [{ materialId: material.id, locator: 'page:1' }];
			const segment = (n: number) => ({
				title: `Part ${n}`,
				explanation: `Part ${n} of four: water follows salt.`,
				question: `Question ${n}?`,
				keyPoints: ['Water moves to the salt'],
				modelAnswer: 'Water moves towards the salt.',
				citations
			});
			vi.mocked(museRun).mockImplementation(async (workspace) => {
				await writeFile(
					join(workspace, 'files', 'result.json'),
					JSON.stringify({
						title: 'Osmosis out loud',
						intro: 'Four parts follow.',
						segments: [1, 2, 3, 4].map(segment)
					})
				);
				return { text: 'done', stderr: '' };
			});
			vi.mocked(speak).mockImplementation(async ({ text, format }) => {
				expect(format).toBe('pcm_24000');
				return { audio: Buffer.from(text), requestId: `req-${text.length}` };
			});

			const response = await call(`/api/projects/${project.id}/generate`, {
				kind: 'session',
				materialIds: [material.id],
				modelId: 'test-model',
				voiceId: 'voice1',
				speechModelId: 'flash',
				sessionLength: 'short',
				thinkingTime: 'long'
			});
			const { jobId } = await response.json();
			const done = await waitFor(jobId, 'succeeded');
			expect(speak).toHaveBeenCalledTimes(9);
			const [output] = await db().select().from(outputs).where(eq(outputs.id, done.outputId!));
			expect(output).toMatchObject({
				kind: 'session',
				title: 'Osmosis out loud',
				study: {
					voiceId: 'voice1',
					voiceName: 'Rachel',
					speechModelId: 'flash',
					thinkingMs: 4000
				}
			});
			expect(output.content).toContain('**Question:** Question 2?');
			const parts = join(data, 'audio', output.id, 'parts');
			expect(await readFile(join(parts, 'intro.pcm'), 'utf8')).toBe('Four parts follow.');
			expect(await readFile(join(parts, '003-question.pcm'), 'utf8')).toBe('Question 4?');
			await expect(access(join(data, 'audio', output.id, 'manifest.json'))).rejects.toThrow();

			// Starting twice continues the same open run.
			const first = await (await call(`/api/outputs/${output.id}/runs`, {})).json();
			const again = await (await call(`/api/outputs/${output.id}/runs`, {})).json();
			expect(again.runId).toBe(first.runId);
			await db().insert(studyAnswers).values({
				runId: first.runId,
				segmentIndex: 0,
				attempt: 1,
				answer: 'Water goes to the salt.',
				verdict: 'correct',
				next: 'continue',
				feedback: 'Right.'
			});
			await expect(
				db().insert(studyAnswers).values({
					runId: first.runId,
					segmentIndex: 0,
					attempt: 1,
					answer: 'Twice',
					verdict: 'none',
					next: 'continue',
					feedback: ''
				})
			).rejects.toThrow();
			const details = await (await call(`/api/outputs/${output.id}`)).json();
			expect(details.output.study.plan.segments).toHaveLength(4);
			expect(details.runs).toEqual([
				expect.objectContaining({
					id: first.runId,
					status: 'active',
					answers: [
						expect.objectContaining({ answer: 'Water goes to the salt.', verdict: 'correct' })
					]
				})
			]);
			expect(JSON.stringify(details)).not.toContain(data);
		} finally {
			await stop();
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
