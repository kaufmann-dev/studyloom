import { describe, expect, it, vi } from 'vitest';
import type { RequestEvent } from '@sveltejs/kit';
import { access, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { eq } from 'drizzle-orm';
import { api } from './api';
import { db, closeDatabase } from './db';
import { jobs, materials, outputs, projects, sourceChunks } from './db/schema';
import { speak, speechCatalog } from './elevenlabs';
import { startWorkers } from './jobs';
import { museRun } from './muse';

vi.mock('./muse', async (importOriginal) => ({
	...(await importOriginal<typeof import('./muse')>()),
	validateModel: vi.fn(async () => {}),
	museRun: vi.fn()
}));
vi.mock('./elevenlabs', () => ({ speechCatalog: vi.fn(), speak: vi.fn() }));

const paragraphs = [
	'Today you will learn how a compass finds north.',
	'A magnetised needle lines up with the field of the Earth.',
	'In short, the needle points north because the Earth is a magnet.'
];

describe.skipIf(!process.env.TEST_DATABASE_URL)('Audio summaries', () => {
	it('voices a cited script, resumes after a failure and serves the joined MP3', async () => {
		const previousDatabaseUrl = process.env.DATABASE_URL;
		const previousDataDir = process.env.DATA_DIR;
		process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
		const data = await mkdtemp(join(tmpdir(), 'studyloom-audio-'));
		process.env.DATA_DIR = data;
		const [project] = await db().insert(projects).values({ name: 'Navigation' }).returning();
		const call = (path: string, init: { method?: string; body?: unknown; range?: string } = {}) => {
			const request = new Request(`https://studyloom.test${path}`, {
				method: init.method ?? (init.body ? 'POST' : 'GET'),
				body: init.body ? JSON.stringify(init.body) : undefined,
				headers: {
					'content-type': 'application/json',
					...(init.range ? { range: init.range } : {})
				}
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
					name: 'Compass',
					filename: 'compass.txt',
					mimeType: 'text/plain',
					kind: 'file',
					status: 'ready'
				})
				.returning();
			await db().insert(sourceChunks).values({
				materialId: material.id,
				ordinal: 0,
				locator: 'page:1',
				text: 'The needle points north because the Earth acts like a magnet.'
			});
			vi.mocked(speechCatalog).mockResolvedValue({
				voices: [{ voiceId: 'voice1', name: 'Rachel', description: '' }],
				models: [
					{ modelId: 'eleven_v4', name: 'Eleven v4', costMultiplier: 1, maxCharacters: 10000 }
				]
			});
			vi.mocked(museRun).mockImplementation(async (workspace) => {
				await writeFile(
					join(workspace, 'files', 'result.json'),
					JSON.stringify({
						title: 'How a compass works',
						paragraphs,
						citations: [
							{ materialId: material.id, locator: 'page:1', quote: 'the Earth acts like a magnet' }
						]
					})
				);
				return { text: 'done', stderr: '' };
			});
			vi.mocked(speak)
				.mockResolvedValueOnce({ audio: Buffer.from('one'), requestId: 'req-1' })
				.mockRejectedValueOnce(new Error('ElevenLabs credits are used up.'));

			// An unknown voice is refused before anything is queued.
			const unknown = await call(`/api/projects/${project.id}/generate`, {
				body: {
					kind: 'audio',
					materialIds: [material.id],
					modelId: 'test-model',
					voiceId: 'gone',
					speechModelId: 'eleven_v4'
				}
			}).catch((cause) => cause);
			expect(unknown).toMatchObject({ status: 409 });

			const response = await call(`/api/projects/${project.id}/generate`, {
				body: {
					kind: 'audio',
					materialIds: [material.id],
					modelId: 'test-model',
					voiceId: 'voice1',
					speechModelId: 'eleven_v4',
					audioLength: 'short'
				}
			});
			expect(response.status).toBe(202);
			const { jobId } = await response.json();
			const failed = await waitFor(jobId, 'failed');
			expect(failed.error).toBe('ElevenLabs credits are used up.');
			expect(failed.payload).toMatchObject({ voiceName: 'Rachel', speechModelName: 'Eleven v4' });

			// The retry keeps the script and the first paragraph's audio.
			vi.mocked(speak)
				.mockResolvedValueOnce({ audio: Buffer.from('two'), requestId: 'req-2' })
				.mockResolvedValueOnce({ audio: Buffer.from('three'), requestId: 'req-3' });
			expect((await call(`/api/jobs/${jobId}/retry`, { body: {} })).status).toBe(202);
			const done = await waitFor(jobId, 'succeeded');
			expect(museRun).toHaveBeenCalledTimes(1);
			expect(speak).toHaveBeenCalledTimes(4);
			expect(vi.mocked(speak).mock.calls[2][0]).toMatchObject({
				text: paragraphs[1],
				voiceId: 'voice1',
				modelId: 'eleven_v4',
				previousRequestIds: ['req-1'],
				nextText: paragraphs[2]
			});
			expect(vi.mocked(speak).mock.calls[3][0]).toMatchObject({
				previousRequestIds: ['req-1', 'req-2']
			});

			const [output] = await db().select().from(outputs).where(eq(outputs.id, done.outputId!));
			expect(output).toMatchObject({
				kind: 'audio',
				title: 'How a compass works',
				content: paragraphs.join('\n\n'),
				audio: {
					voiceId: 'voice1',
					voiceName: 'Rachel',
					speechModelId: 'eleven_v4',
					speechModelName: 'Eleven v4',
					characters: paragraphs.join('').length
				}
			});
			const details = await (await call(`/api/outputs/${output.id}`)).json();
			expect(details.output.audio).toMatchObject({ voiceName: 'Rachel' });
			expect(JSON.stringify(details)).not.toContain(data);

			const file = await call(`/api/outputs/${output.id}/audio`);
			expect(file.headers.get('content-type')).toBe('audio/mpeg');
			expect(Buffer.from(await file.arrayBuffer()).toString()).toBe('onetwothree');
			const partial = await call(`/api/outputs/${output.id}/audio`, { range: 'bytes=3-5' });
			expect(partial.status).toBe(206);
			expect(await partial.text()).toBe('two');
			await expect(access(join(data, 'audio', output.id, 'parts'))).rejects.toThrow();
			expect(await readFile(join(data, 'audio', output.id, 'summary.mp3'), 'utf8')).toBe(
				'onetwothree'
			);

			// Deleting the project removes its audio files.
			expect((await call(`/api/projects/${project.id}`, { method: 'DELETE' })).status).toBe(200);
			await expect(access(join(data, 'audio', output.id))).rejects.toThrow();
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
