import { EventEmitter } from 'node:events';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import type { WebSocket } from 'ws';
import { closeDatabase, db } from '../lib/server/db';
import { outputs, projects, studyAnswers, studyRuns } from '../lib/server/db/schema';
import type { AsrEvents } from '../lib/server/realtime-asr';
import type { StudyPlan } from '../lib/domain';

const asr = vi.hoisted(() => ({ events: undefined as AsrEvents | undefined }));
vi.mock('../lib/server/realtime-asr', () => ({
	requireTranscription: () => {},
	openRealtimeAsr: (events: AsrEvents) => {
		asr.events = events;
		setTimeout(() => events.onReady(), 5);
		return {
			send: async () => {},
			end: () => {},
			terminate: () => {},
			settled: async () => {},
			open: true,
			bufferedAmount: 0
		};
	}
}));
vi.mock('../lib/server/muse', async (importOriginal) => ({
	...(await importOriginal<typeof import('../lib/server/muse')>()),
	gradingModel: async (id: string) => id
}));
vi.mock('../lib/server/elevenlabs', () => ({
	speechCatalog: async () => ({ voices: [{ voiceId: 'voice1', name: 'Rachel', description: '' }] }),
	// Odd chunk sizes: the socket must never split a sample.
	speakStream: async function* ({ text }: { text: string }) {
		yield Buffer.alloc(3, text.length);
		yield Buffer.alloc(5, text.length);
	}
}));
const replies = vi.hoisted(() => [] as string[]);
const prompts = vi.hoisted(() => [] as string[]);
vi.mock('../lib/server/tutor', async (importOriginal) => {
	const actual = await importOriginal<typeof import('../lib/server/tutor')>();
	class TutorConversation {
		constructor(
			_run: string,
			_model: string,
			private readonly primer: () => Promise<string>
		) {}
		async warm() {
			prompts.push(await this.primer());
		}
		async ask(prompt: string, onDelta: (delta: string) => void) {
			prompts.push(prompt);
			const reply = replies.shift() ?? '';
			// Stream in small pieces, like Muse.
			for (let i = 0; i < reply.length; i += 7) onDelta(reply.slice(i, i + 7));
			return reply;
		}
		async close() {}
	}
	return { ...actual, TutorConversation };
});
const { studySession } = await import('./study-socket');

const plan: StudyPlan = {
	title: 'Osmosis',
	intro: 'Two parts follow.',
	segments: [1, 2].map((n) => ({
		title: `Part ${n}`,
		explanation: `Explanation ${n}.`,
		question: `Question ${n}?`,
		keyPoints: ['Water moves to the salt'],
		modelAnswer: 'Water moves towards the salt.',
		misconceptions: [],
		citations: [{ materialId: '00000000-0000-4000-8000-000000000001', locator: 'page:1' }]
	}))
};

/** Runs a test against a fresh two-part session with its clips on disk. */
async function withSession(test: (outputId: string, runId: string) => Promise<void>) {
	prompts.length = replies.length = 0;
	const previousDatabaseUrl = process.env.DATABASE_URL;
	const previousDataDir = process.env.DATA_DIR;
	process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
	const data = await mkdtemp(join(tmpdir(), 'studyloom-socket-'));
	process.env.DATA_DIR = data;
	const [project] = await db().insert(projects).values({ name: 'Socket' }).returning();
	try {
		const [output] = await db()
			.insert(outputs)
			.values({
				projectId: project.id,
				kind: 'session',
				title: plan.title,
				content: '',
				study: {
					plan,
					voiceId: 'voice1',
					voiceName: 'Rachel',
					speechModelId: 'flash',
					speechModelName: 'Flash',
					thinkingMs: 30,
					characters: 0
				},
				materialIds: [],
				sourceSnapshot: [],
				modelId: 'test-model'
			})
			.returning();
		const parts = join(data, 'audio', output.id, 'parts');
		await mkdir(parts, { recursive: true });
		for (const key of [
			'intro',
			'000-explanation',
			'000-question',
			'001-explanation',
			'001-question'
		])
			await writeFile(join(parts, `${key}.pcm`), Buffer.alloc(4, 1));
		const [run] = await db().insert(studyRuns).values({ outputId: output.id }).returning();
		await test(output.id, run.id);
	} finally {
		await db().delete(projects).where(eq(projects.id, project.id));
		if (previousDatabaseUrl === undefined) delete process.env.DATABASE_URL;
		else process.env.DATABASE_URL = previousDatabaseUrl;
		if (previousDataDir === undefined) delete process.env.DATA_DIR;
		else process.env.DATA_DIR = previousDataDir;
		await rm(data, { recursive: true, force: true });
	}
}

/** A browser that plays every clip at once and answers each question out loud. */
function browser(answers: string[]) {
	const client = new EventEmitter() as EventEmitter & {
		readyState: number;
		sent: unknown[];
		binary: Buffer[];
		send(data: unknown): void;
		close(code: number): void;
		ping(): void;
	};
	client.readyState = 1;
	client.sent = [];
	client.binary = [];
	const reply = (value: unknown) =>
		setTimeout(() => client.emit('message', Buffer.from(JSON.stringify(value)), false), 1);
	client.send = (data) => {
		if (Buffer.isBuffer(data)) return void client.binary.push(data);
		const message = JSON.parse(String(data));
		client.sent.push(message);
		if (message.type === 'clipEnd') reply({ type: 'played', clip: message.clip });
		if (message.type === 'listen') {
			const answer = answers.shift() ?? '';
			setTimeout(() => {
				asr.events!.onSpeechStart?.(1, 0);
				void asr.events!.onComplete(1, answer, 0);
			}, 5);
		}
	};
	client.close = (code) => {
		client.readyState = 3;
		client.emit('close', code);
	};
	client.ping = () => {};
	return client;
}

describe.skipIf(!process.env.TEST_DATABASE_URL)('Study session socket', () => {
	it('replays unconfirmed feedback on resume and ends early on request', async () => {
		await withSession(async (outputId, runId) => {
			// The first answer was graded, but the browser disconnected before it played.
			await db().insert(studyAnswers).values({
				runId,
				segmentIndex: 0,
				attempt: 1,
				answer: 'Water moves.',
				verdict: 'correct',
				next: 'continue',
				feedback: 'Saved feedback.'
			});
			const client = browser([]);
			// End the session as soon as the tutor starts listening again.
			const send = client.send;
			client.send = (data) => {
				send(data);
				if (!Buffer.isBuffer(data) && JSON.parse(String(data)).type === 'listen')
					setTimeout(() => client.emit('message', Buffer.from('{"type":"end"}'), false), 1);
			};
			await studySession(client as unknown as WebSocket, outputId, runId, 'token');
			const clips = client.sent.filter((m) => (m as { type: string }).type === 'clip');
			expect(clips.map((m) => (m as { kind: string }).kind)).toEqual([
				'feedback',
				'explanation',
				'question'
			]);
			expect(clips[0]).toMatchObject({ text: 'Saved feedback.' });
			expect(client.sent.at(-1)).toEqual({ type: 'complete' });
			const [saved] = await db().select().from(studyRuns).where(eq(studyRuns.id, runId));
			expect(saved).toMatchObject({ status: 'complete', segmentIndex: 1, attempt: 1 });
			expect(saved.completedAt).not.toBeNull();
		});
	});
	it('explains, listens, grades, follows up once and saves the whole protocol', async () => {
		await withSession(async (outputId, runId) => {
			replies.push(
				'{"verdict":"partial","next":"followUp","gap":"which side has more salt"}\nGood start. Which side has more salt?',
				'{"verdict":"correct","next":"followUp"}\nExactly, the water follows the salt.',
				'{"verdict":"correct","next":"continue"}\nRight again.',
				'You did well. Review the salt side tomorrow.'
			);
			const client = browser(['Water moves.', 'The outside.', 'It swells.']);
			const closed = new Promise<number>((resolve) => client.on('close', resolve));
			await studySession(client as unknown as WebSocket, outputId, runId, 'token');
			expect(await closed).toBe(1000);

			const clips = client.sent
				.filter((m): m is { type: string; kind: string } => (m as { type: string }).type === 'clip')
				.map((m) => m.kind);
			expect(clips).toEqual([
				'intro',
				'explanation',
				'question',
				'feedback',
				'feedback',
				'explanation',
				'question',
				'feedback',
				'wrapup'
			]);
			expect(client.sent).toContainEqual({ type: 'heard', text: 'The outside.' });
			expect(client.sent.at(-1)).toEqual({ type: 'complete' });
			expect(client.binary.every((frame) => frame.length % 2 === 0)).toBe(true);
			// The primer and each answer reach the tutor; the second attempt is marked as the last.
			expect(prompts[0]).toContain('<protocol>none yet</protocol>');
			expect(prompts[2]).toContain('attempt 2 of 2');

			const [saved] = await db().select().from(studyRuns).where(eq(studyRuns.id, runId));
			expect(saved).toMatchObject({ status: 'complete', segmentIndex: 2, attempt: 1 });
			const answers = await db()
				.select()
				.from(studyAnswers)
				.where(eq(studyAnswers.runId, runId))
				.orderBy(studyAnswers.segmentIndex, studyAnswers.attempt);
			expect(
				answers.map(({ segmentIndex, attempt, answer, verdict, next, gap, feedback }) => ({
					segmentIndex,
					attempt,
					answer,
					verdict,
					next,
					gap,
					feedback
				}))
			).toEqual([
				{
					segmentIndex: 0,
					attempt: 1,
					answer: 'Water moves.',
					verdict: 'partial',
					next: 'followUp',
					gap: 'which side has more salt',
					feedback: 'Good start. Which side has more salt?'
				},
				{
					segmentIndex: 0,
					attempt: 2,
					answer: 'The outside.',
					verdict: 'correct',
					// The last attempt always moves on, whatever the tutor asked for.
					next: 'continue',
					gap: '',
					feedback: 'Exactly, the water follows the salt.'
				},
				{
					segmentIndex: 1,
					attempt: 1,
					answer: 'It swells.',
					verdict: 'correct',
					next: 'continue',
					gap: '',
					feedback: 'Right again.'
				}
			]);
		});
	});
	afterAll(() => closeDatabase());
});
