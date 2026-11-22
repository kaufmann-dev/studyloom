import { describe, expect, it, vi } from 'vitest';
import { access, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { eq } from 'drizzle-orm';
import { db, closeDatabase } from './db';
import {
	attempts,
	jobs,
	lessonAnswers,
	materials,
	outputs,
	projects,
	sourceChunks,
	studyAnswers
} from './db/schema';
import { silenceMp3 } from './audio';
import { speak, speechCatalog } from './elevenlabs';
import { startWorkers } from './jobs';
import { claudeRun } from './claude';
import { outputDir } from './outline';
import { callApi, useTestDatabase } from './testing';

vi.mock('./claude', async (importOriginal) => ({
	...(await importOriginal<typeof import('./claude')>()),
	validateModel: vi.fn(async () => {}),
	offeredModel: vi.fn(async (modelId: string) => modelId),
	claudeRun: vi.fn()
}));
vi.mock('./elevenlabs', () => ({
	speechCatalog: vi.fn(),
	speak: vi.fn(),
	transcribeFile: vi.fn(),
	requireTranscription: vi.fn()
}));
// Audio summaries and study sessions share this file: their job workers must never run at the
// same time, or one test's worker would claim the other's job.

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
async function waitFor(jobId: string, status: string) {
	for (let i = 0; i < 200; i++) {
		const [job] = await db().select().from(jobs).where(eq(jobs.id, jobId));
		if (job.status === status) return job;
		await new Promise((resolve) => setTimeout(resolve, 50));
	}
	throw new Error(`Job did not reach ${status}.`);
}

describe.skipIf(!process.env.TEST_DATABASE_URL)('Audio summaries', () => {
	it('voices a cited dialogue in two voices, resumes after a failure and serves the joined MP3', async () => {
		const environment = await useTestDatabase('audio');
		const { data } = environment;
		const [project] = await db().insert(projects).values({ name: 'Navigation' }).returning();
		const call = callApi;
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
			vi.mocked(claudeRun).mockImplementation(async () => ({
				text: 'done',
				stderr: '',
				structured: {
					title: 'How a compass works',
					turns,
					citations: [
						{ materialId: material.id, locator: 'page:1', quote: 'the Earth acts like a magnet' }
					]
				}
			}));
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
				coverage: 'light',
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
			expect(claudeRun).toHaveBeenCalledTimes(1);
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
			const partial = await call(`/api/outputs/${output.id}/audio`, {
				headers: { range: 'bytes=4-6' }
			});
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
			await environment.restore();
		}
	});
});

describe.skipIf(!process.env.TEST_DATABASE_URL)('Study sessions', () => {
	it('plans and pre-voices a session, then keeps one open run with its answers', async () => {
		const environment = await useTestDatabase('study');
		const { data } = environment;
		const [project] = await db().insert(projects).values({ name: 'Biology' }).returning();
		const call = (path: string, body?: unknown) => callApi(path, { body });
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
			vi.mocked(claudeRun).mockImplementation(async () => ({
				text: 'done',
				stderr: '',
				structured: {
					title: 'Osmosis out loud',
					intro: 'Four parts follow.',
					segments: [1, 2, 3, 4].map(segment)
				}
			}));
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
				coverage: 'light'
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
					speechModelName: 'Flash'
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
			await environment.restore();
		}
	});
});

describe.skipIf(!process.env.TEST_DATABASE_URL)('Quizzes', () => {
	it('asks every source exercise at comprehensive coverage and grades fields on the server', async () => {
		const environment = await useTestDatabase('quiz');
		const [project] = await db().insert(projects).values({ name: 'Economics' }).returning();
		const call = callApi;
		const stop = startWorkers();
		try {
			const [material] = await db()
				.insert(materials)
				.values({
					projectId: project.id,
					name: 'Script',
					filename: 'script.pdf',
					mimeType: 'application/pdf',
					kind: 'file',
					status: 'ready',
					contentFormat: 'markdown'
				})
				.returning();
			await db()
				.insert(sourceChunks)
				.values([
					{
						materialId: material.id,
						ordinal: 0,
						locator: 'page:1',
						text: 'Rentability relates profit to the capital employed.'
					},
					{
						materialId: material.id,
						ordinal: 1,
						locator: 'page:2#1',
						kind: 'exercise',
						text: '4. How high is the rentability with a profit of 1.000 and equity of 4.000?'
					},
					{
						materialId: material.id,
						ordinal: 2,
						locator: 'page:9',
						kind: 'solution',
						text: '4. - [x] 25 %'
					}
				]);
			const citation = { materialId: material.id, locator: 'page:1' };
			const feedback = { correct: 'Profit over capital.', incorrect: 'Divide profit by capital.' };
			const own = {
				id: 'a',
				body: 'What does rentability relate?\n\n{{pick}}',
				fields: [
					{
						id: 'pick',
						type: 'select',
						display: 'radio',
						options: [
							{ id: 'a', text: 'Profit and capital' },
							{ id: 'b', text: 'Revenue and cost', why: 'That is economic efficiency.' }
						],
						correct: 'a'
					}
				],
				explanation: 'See the definition.',
				feedback,
				citations: [citation]
			};
			const exercise = {
				id: 'b',
				body: 'Profit 1.000, equity 4.000. Rentability: {{value}}',
				fields: [{ id: 'value', type: 'number', correct: 25, unit: '%' }],
				explanation: '1000 * 100 / 4000',
				feedback,
				sourceExercise: { materialId: material.id, locator: 'page:2#1' },
				citations: [citation]
			};
			const answers = (questions: unknown[]) => ({
				text: 'done',
				stderr: '',
				structured: { title: 'Rentability', questions }
			});
			vi.mocked(claudeRun)
				.mockReset()
				// The first result leaves the source exercise out and is sent back.
				.mockResolvedValueOnce(answers([own]))
				.mockResolvedValueOnce(answers([own, exercise]));

			const response = await call(`/api/projects/${project.id}/generate`, {
				body: {
					kind: 'quiz',
					materialIds: [material.id],
					modelId: 'test-model',
					coverage: 'comprehensive',
					questionStyles: ['choice']
				}
			});
			const { jobId } = await response.json();
			await waitFor(jobId, 'succeeded');
			expect(claudeRun).toHaveBeenCalledTimes(2);
			expect(vi.mocked(claudeRun).mock.calls[1][0].prompt).toContain('page:2#1');
			// The plan is gone once the quiz is saved.
			await expect(access(join(outputDir(jobId), 'plan.json'))).rejects.toThrow();

			const details = await (await call(`/api/outputs/${jobId}`)).json();
			const [part] = details.output.quiz.parts;
			expect(part.questions.map((question: { id: string }) => question.id)).toEqual([
				'p01q01',
				'p01q02'
			]);
			// The exercise keeps its own format although only multiple choice was asked for.
			expect(part.questions[1].sourceExercise.locator).toBe('page:2#1');

			// A German decimal comma is read; the question left open scores nothing.
			const attempt = await call(`/api/outputs/${jobId}/attempts`, {
				body: { answers: [{ questionId: 'p01q02', values: { value: '25,0 %' } }] }
			});
			const { attemptId, jobId: gradeJob } = await attempt.json();
			expect(gradeJob).toBeUndefined();
			const [graded] = await db().select().from(attempts).where(eq(attempts.id, attemptId));
			expect(graded).toMatchObject({ status: 'complete', score: 1, maxScore: 2 });
			expect(graded.grades).toMatchObject([
				{ questionId: 'p01q01', state: 'incorrect' },
				{ questionId: 'p01q02', state: 'correct' }
			]);
			const unknown = await call(`/api/outputs/${jobId}/attempts`, {
				body: { answers: [{ questionId: 'nope', values: {} }] }
			}).catch((cause) => cause);
			expect(unknown).toMatchObject({ status: 400 });
		} finally {
			await stop();
			await db().delete(projects).where(eq(projects.id, project.id));
			await closeDatabase();
			await environment.restore();
		}
	});
});

describe.skipIf(!process.env.TEST_DATABASE_URL)('Lessons', () => {
	it('writes chapter by chapter, resumes at the missing chapter and grades answers', async () => {
		const environment = await useTestDatabase('lesson');
		const [project] = await db().insert(projects).values({ name: 'Economics' }).returning();
		const call = callApi;
		const stop = startWorkers();
		try {
			const [material] = await db()
				.insert(materials)
				.values({
					projectId: project.id,
					name: 'Script',
					filename: 'script.pdf',
					mimeType: 'application/pdf',
					kind: 'file',
					status: 'ready',
					contentFormat: 'markdown'
				})
				.returning();
			await db()
				.insert(sourceChunks)
				.values([
					{
						materialId: material.id,
						ordinal: 0,
						locator: 'page:1',
						text: 'Rentability relates profit to capital.'
					},
					{
						materialId: material.id,
						ordinal: 1,
						locator: 'page:2#1',
						kind: 'exercise',
						text: '4. Rentability with a profit of 1.000 and equity of 4.000?'
					},
					{
						materialId: material.id,
						ordinal: 2,
						locator: 'page:3',
						text: 'Liquidity keeps a company able to pay.'
					}
				]);
			const ref = (locator: string) => ({ materialId: material.id, locator });
			const feedback = { correct: 'Profit over capital.', incorrect: 'Divide profit by capital.' };
			const beat = (text: string) => ({
				narration: text,
				slide: { kind: 'content', markdown: `- ${text}` }
			});
			const outline = {
				title: 'Key figures',
				parts: [
					{
						title: 'Rentability',
						sections: [
							{
								title: 'Profit and capital',
								locators: [ref('page:1')],
								exercises: [ref('page:2#1')]
							}
						]
					},
					{
						title: 'Liquidity',
						sections: [{ title: 'Able to pay', locators: [ref('page:3')], exercises: [] }]
					}
				]
			};
			const first = {
				sections: [
					{
						title: 'Profit and capital',
						beats: [beat('Rentability compares profit with capital.')],
						questions: [
							{
								id: 'x',
								body: 'Rentability: {{value}}',
								fields: [{ id: 'value', type: 'number', correct: 25, unit: '%' }],
								explanation: '1000 * 100 / 4000',
								feedback,
								sourceExercise: ref('page:2#1'),
								citations: [ref('page:1')]
							}
						],
						citations: [ref('page:1')]
					}
				]
			};
			const second = {
				sections: [
					{
						title: 'Able to pay',
						beats: [
							beat('Liquidity means bills can be paid.'),
							beat('Without it a company fails.')
						],
						questions: [
							{
								id: 'y',
								body: 'Why does liquidity matter?\n\n{{why}}',
								fields: [
									{
										id: 'why',
										type: 'essay',
										modelAnswer: 'It keeps the company solvent.',
										rubric: 'Solvency'
									}
								],
								explanation: 'See page 3.',
								feedback,
								citations: [ref('page:3')]
							}
						],
						citations: [ref('page:3')]
					}
				]
			};
			const result = (structured: unknown) => ({ text: 'done', stderr: '', structured });
			vi.mocked(claudeRun)
				.mockReset()
				.mockResolvedValueOnce(result(outline))
				.mockResolvedValueOnce(result(first))
				.mockRejectedValueOnce(new Error('Your Claude usage limit is reached.'));

			const response = await call(`/api/projects/${project.id}/generate`, {
				body: {
					kind: 'lesson',
					materialIds: [material.id],
					modelId: 'test-model',
					coverage: 'comprehensive'
				}
			});
			const { jobId } = await response.json();
			expect((await waitFor(jobId, 'failed')).error).toBe('Your Claude usage limit is reached.');

			// The retry writes only the chapter that is missing.
			vi.mocked(claudeRun).mockResolvedValueOnce(result(second));
			await call(`/api/jobs/${jobId}/retry`, { body: {} });
			await waitFor(jobId, 'succeeded');
			expect(claudeRun).toHaveBeenCalledTimes(4);
			await expect(access(join(outputDir(jobId), 'plan.json'))).rejects.toThrow();

			const details = await (await call(`/api/outputs/${jobId}`)).json();
			const { lesson } = details.output.lesson;
			expect(lesson.chapters.map((chapter: { id: string }) => chapter.id)).toEqual(['c01', 'c02']);
			const [exercise] = lesson.chapters[0].sections[0].questions;
			const [written] = lesson.chapters[1].sections[0].questions;
			expect(exercise.id).toBe('c01s01q1');
			expect(lesson.chapters[1].sections[0].beats.map((item: { id: string }) => item.id)).toEqual([
				'c02s01b1',
				'c02s01b2'
			]);
			expect(details.output.content).toContain('## 2. Liquidity');
			expect(details.answers).toEqual([]);

			// A closed question is graded at once, without Claude.
			const closed = await (
				await call(`/api/outputs/${jobId}/answers`, {
					body: { questionId: exercise.id, values: { value: '20' } }
				})
			).json();
			expect(closed.jobId).toBeUndefined();
			expect(closed.answer).toMatchObject({ status: 'graded', result: { state: 'incorrect' } });
			await call(`/api/outputs/${jobId}/answers`, {
				body: { questionId: exercise.id, values: { value: '25 %' } }
			});

			// Free text waits for Claude, whose feedback is what the tutor says.
			vi.mocked(claudeRun).mockResolvedValueOnce(
				result({
					grades: [
						{ questionId: written.id, fieldId: 'why', score: 0.5, feedback: 'Name solvency.' }
					]
				})
			);
			const open = await (
				await call(`/api/outputs/${jobId}/answers`, {
					body: { questionId: written.id, values: { why: 'Money matters.' } }
				})
			).json();
			expect(open.answer.status).toBe('grading');
			await waitFor(open.jobId, 'succeeded');
			const after = await (await call(`/api/outputs/${jobId}`)).json();
			// The newest answer per question is the current one.
			expect(after.answers).toHaveLength(2);
			expect(after.answers).toEqual(
				expect.arrayContaining([
					expect.objectContaining({
						questionId: exercise.id,
						result: expect.objectContaining({ state: 'correct' })
					}),
					expect.objectContaining({
						questionId: written.id,
						status: 'graded',
						feedback: 'Name solvency.',
						result: expect.objectContaining({ state: 'partial', score: 0.5 })
					})
				])
			);
			const given = () =>
				db().select().from(lessonAnswers).where(eq(lessonAnswers.outputId, jobId));
			expect(await given()).toHaveLength(3);

			const unknown = await call(`/api/outputs/${jobId}/answers`, {
				body: { questionId: 'nope', values: {} }
			}).catch((cause) => cause);
			expect(unknown).toMatchObject({ status: 404 });

			// Without a voice nothing can be voiced; with one, each clip is voiced exactly once.
			const clip = `/api/outputs/${jobId}/clips/c02s01b1`;
			expect(await call(clip, { body: {} }).catch((cause) => cause)).toMatchObject({ status: 409 });
			vi.mocked(speechCatalog).mockResolvedValue({
				voices: [{ voiceId: 'voice1', name: 'Rachel', description: '' }],
				models: [
					{ modelId: 'eleven_v4', name: 'Eleven v4', costMultiplier: 1, maxCharacters: 10000 }
				]
			});
			const chosen = await (
				await call(`/api/outputs/${jobId}/voice`, {
					method: 'PUT',
					body: { voiceId: 'voice1', speechModelId: 'eleven_v4' }
				})
			).json();
			expect(chosen.voice).toMatchObject({ voiceName: 'Rachel', speechModelName: 'Eleven v4' });
			vi.mocked(speak)
				.mockReset()
				.mockResolvedValue({ audio: part('clip'), requestId: 'r' });
			// Reading a clip never voices it.
			expect(await call(clip).catch((cause) => cause)).toMatchObject({ status: 404 });
			expect(speak).not.toHaveBeenCalled();
			await Promise.all([call(clip, { body: {} }), call(clip, { body: {} })]);
			await call(clip, { body: {} });
			expect(speak).toHaveBeenCalledTimes(1);
			expect(vi.mocked(speak).mock.calls[0][0]).toMatchObject({
				text: 'Liquidity means bills can be paid.',
				voiceId: 'voice1',
				modelId: 'eleven_v4'
			});
			expect(Buffer.from(await (await call(clip)).arrayBuffer())).toEqual(part('clip'));
			for (const bad of ['nope', '..%2F..%2Fplan', `${exercise.id}-maybe`])
				expect(
					await call(`/api/outputs/${jobId}/clips/${bad}`, { body: {} }).catch((cause) => cause)
				).toMatchObject({ status: 404 });
			// Prepared feedback and Claude's feedback on a written answer are clips too.
			await call(`/api/outputs/${jobId}/clips/${exercise.id}-incorrect`, { body: {} });
			const writtenAnswer = after.answers.find(
				(item: { questionId: string }) => item.questionId === written.id
			);
			await call(`/api/outputs/${jobId}/clips/answer-${writtenAnswer.id}`, { body: {} });
			expect(vi.mocked(speak).mock.calls.map(([request]) => request.text)).toEqual([
				'Liquidity means bills can be paid.',
				'Divide profit by capital.',
				'Name solvency.'
			]);

			// "Voice everything now" voices the explanations that are still missing.
			const all = await (await call(`/api/outputs/${jobId}/voice-all`, { body: {} })).json();
			await waitFor(all.jobId, 'succeeded');
			expect(speak).toHaveBeenCalledTimes(5);
			// Turning the voice off discards the clips.
			await call(`/api/outputs/${jobId}/voice`, { method: 'DELETE' });
			await expect(access(join(outputDir(jobId), 'clips'))).rejects.toThrow();
			await call(`/api/outputs/${jobId}/answers`, { method: 'DELETE' });
			expect(await given()).toHaveLength(0);
		} finally {
			await stop();
			await db().delete(projects).where(eq(projects.id, project.id));
			await closeDatabase();
			await environment.restore();
		}
	}, 30_000);
});
