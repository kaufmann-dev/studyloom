import { describe, expect, it, vi } from 'vitest';
import type { RequestEvent } from '@sveltejs/kit';
import { access, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { eq } from 'drizzle-orm';
import { api } from './api';
import { db, closeDatabase } from './db';
import { jobs, materials, outputs, projects, sourceChunks } from './db/schema';
import { silenceMp3 } from './audio';
import { speak, speechCatalog } from './elevenlabs';
import { startWorkers } from './jobs';
import { museRun } from './muse';

vi.mock('./muse', async (importOriginal) => ({
	...(await importOriginal<typeof import('./muse')>()),
	validateModel: vi.fn(async () => {}),
	museRun: vi.fn()
}));
vi.mock('./elevenlabs', () => ({ speechCatalog: vi.fn(), speak: vi.fn() }));

const turns = [
	{ speaker: 'learner', text: 'How does a compass find north?' },
	{
		speaker: 'tutor',
		text: 'A magnetised needle lines up with the field of the Earth. Pause and think: why?',
		pauseAfterSeconds: 2
	},
	{ speaker: 'tutor', text: 'In short, the needle points north because the Earth is a magnet.' }
];
// Parts start with a real frame header, because silence is written in the parts' own format.
const HEADER = Buffer.from([0xff, 0xfb, 0x90, 0xc4]);
const part = (tag: string) => Buffer.concat([HEADER, Buffer.from(tag)]);

describe.skipIf(!process.env.TEST_DATABASE_URL)('Audio summaries', () => {
	it('voices a cited dialogue in two voices, resumes after a failure and serves the joined MP3', async () => {
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
				voices: [
					{ voiceId: 'voice1', name: 'Rachel', description: '' },
					{ voiceId: 'voice2', name: 'Adam', description: '' }
				],
				models: [
					{ modelId: 'eleven_v4', name: 'Eleven v4', costMultiplier: 1, maxCharacters: 10000 }
				]
			});
			vi.mocked(museRun).mockImplementation(async (workspace) => {
				await writeFile(
					join(workspace, 'files', 'result.json'),
					JSON.stringify({
						title: 'How a compass works',
						turns,
						citations: [
							{ materialId: material.id, locator: 'page:1', quote: 'the Earth acts like a magnet' }
						]
					})
				);
				return { text: 'done', stderr: '' };
			});
			vi.mocked(speak)
				.mockResolvedValueOnce({ audio: part('one'), requestId: 'req-1' })
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

			const dialogue = {
				kind: 'audio',
				materialIds: [material.id],
				modelId: 'test-model',
				voiceId: 'voice1',
				learnerVoiceId: 'voice2',
				speechModelId: 'eleven_v4',
				audioLength: 'short',
				audioStyle: 'dialogue'
			};
			const same = await call(`/api/projects/${project.id}/generate`, {
				body: { ...dialogue, learnerVoiceId: 'voice1' }
			}).catch((cause) => cause);
			expect(same).toMatchObject({ status: 400 });

			const response = await call(`/api/projects/${project.id}/generate`, { body: dialogue });
			expect(response.status).toBe(202);
			const { jobId } = await response.json();
			const failed = await waitFor(jobId, 'failed');
			expect(failed.error).toBe('ElevenLabs credits are used up.');
			const voices = [
				{ speaker: 'tutor', voiceId: 'voice1', voiceName: 'Rachel' },
				{ speaker: 'learner', voiceId: 'voice2', voiceName: 'Adam' }
			];
			expect(failed.payload).toMatchObject({ voices, speechModelName: 'Eleven v4' });

			// The retry keeps the script and the first turn's audio.
			vi.mocked(speak)
				.mockResolvedValueOnce({ audio: part('two'), requestId: 'req-2' })
				.mockResolvedValueOnce({ audio: part('three'), requestId: 'req-3' });
			expect((await call(`/api/jobs/${jobId}/retry`, { body: {} })).status).toBe(202);
			const done = await waitFor(jobId, 'succeeded');
			expect(museRun).toHaveBeenCalledTimes(1);
			expect(speak).toHaveBeenCalledTimes(4);
			// Each voice is stitched only to its own earlier requests.
			expect(vi.mocked(speak).mock.calls[2][0]).toMatchObject({
				text: turns[1].text,
				voiceId: 'voice1',
				modelId: 'eleven_v4',
				previousRequestIds: [],
				nextText: turns[2].text
			});
			expect(vi.mocked(speak).mock.calls[3][0]).toMatchObject({
				voiceId: 'voice1',
				previousRequestIds: ['req-2']
			});

			const expected = Buffer.concat([
				part('one'),
				silenceMp3(250, HEADER),
				part('two'),
				silenceMp3(2000, HEADER),
				part('three')
			]);
			const [output] = await db().select().from(outputs).where(eq(outputs.id, done.outputId!));
			expect(output).toMatchObject({
				kind: 'audio',
				title: 'How a compass works',
				content: [
					`**Learner:** ${turns[0].text}`,
					`**Tutor:** ${turns[1].text}`,
					`**Tutor:** ${turns[2].text}`
				].join('\n\n'),
				audio: {
					style: 'dialogue',
					voices,
					speechModelId: 'eleven_v4',
					speechModelName: 'Eleven v4',
					durationMs: Math.round(expected.length / 16),
					characters: turns.map((turn) => turn.text).join('').length
				}
			});
			const details = await (await call(`/api/outputs/${output.id}`)).json();
			expect(details.output.audio).toMatchObject({ style: 'dialogue', voices });
			expect(JSON.stringify(details)).not.toContain(data);

			const file = await call(`/api/outputs/${output.id}/audio`);
			expect(file.headers.get('content-type')).toBe('audio/mpeg');
			expect(Buffer.from(await file.arrayBuffer())).toEqual(expected);
			const partial = await call(`/api/outputs/${output.id}/audio`, { range: 'bytes=4-6' });
			expect(partial.status).toBe(206);
			expect(await partial.text()).toBe('one');
			await expect(access(join(data, 'audio', output.id, 'parts'))).rejects.toThrow();
			expect(await readFile(join(data, 'audio', output.id, 'summary.mp3'))).toEqual(expected);

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
