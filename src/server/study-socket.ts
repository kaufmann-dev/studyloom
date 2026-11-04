import { readFile } from 'node:fs/promises';
import { WebSocket } from 'ws';
import { and, eq } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '../lib/server/db';
import * as t from '../lib/server/db/schema';
import { safeError } from '../lib/server/config';
import { audioDir } from '../lib/server/audio';
import { speakStream, speechCatalog } from '../lib/server/elevenlabs';
import { studyClipKey, type Snapshot } from '../lib/server/jobs';
import { gradingModel } from '../lib/server/claude';
import {
	openRealtimeAsr,
	requireTranscription,
	type RealtimeAsr
} from '../lib/server/realtime-asr';
import { publicAnswer, studyRuns } from '../lib/server/endpoints/study';
import {
	AnswerCollector,
	finalNext,
	nextPosition,
	resumeStep,
	type Position
} from '../lib/server/study-run';
import {
	FALLBACK_HEADER,
	FeedbackStream,
	TutorConversation,
	WRAP_UP_PROMPT,
	answerPrompt,
	citedExcerpts,
	primerPrompt
} from '../lib/server/tutor';
import { clipPath } from '../lib/server/voicing';
import type { StudyAnswer, StudyInfo } from '../lib/domain';
import { send, watchSession } from './socket';

/** PCM frames sent to the browser: 0.2 s at 24 kHz, 16-bit mono. */
const FRAME_BYTES = 9600;
const SAMPLE_RATE = 24_000;
const PAUSE_AFTER_EXPLANATION = Buffer.alloc(Math.round(0.7 * SAMPLE_RATE) * 2);
const messageSchema = z.discriminatedUnion('type', [
	z.object({ type: z.literal('played'), clip: z.string() }),
	z.object({ type: z.literal('skip') }),
	z.object({ type: z.literal('done') }),
	z.object({ type: z.literal('end') })
]);
type ClipKind = 'intro' | 'explanation' | 'question' | 'feedback' | 'wrapup';
type Phase = 'presenting' | 'listening' | 'thinking' | 'feedback' | 'complete';

/** A study session socket replaced by a newer one; only one runs at a time. */
let current: { close: (message: string) => void } | undefined;

/** Runs one spoken study session over an authenticated socket until it ends or disconnects. */
export async function studySession(
	client: WebSocket,
	outputId: string,
	runId: string,
	sessionToken: string | undefined
) {
	const lifetime = new AbortController();
	let asr: RealtimeAsr | undefined;
	let conversation: TutorConversation | undefined;
	let closed = false;
	const stop = (code: number, message?: string) => {
		if (closed) return;
		closed = true;
		lifetime.abort();
		asr?.terminate();
		if (message) send(client, { type: 'error', message, retryable: code !== 1000 });
		client.close(code, code === 1000 ? 'Session ended' : 'Session interrupted');
	};
	const fail = (e: unknown) => stop(1011, safeError(e));
	current?.close('Session continued in another window.');
	const self = { close: (message: string) => stop(4000, message) };
	current = self;
	const stopWatching = watchSession(
		client,
		sessionToken,
		'Your session expired. Sign in again to resume.',
		fail
	);
	client.on('error', () => {});

	// Messages from the browser resolve whatever the session is waiting for.
	let onPlayed: ((clip: string) => void) | undefined;
	let onSkip: (() => void) | undefined;
	let onDone: (() => void) | undefined;
	let onAudio: ((pcm: Buffer) => void) | undefined;
	let ended: (() => void) | undefined;
	const endRequested = new Promise<void>((resolve) => (ended = resolve));
	client.on('message', (raw, isBinary) => {
		if (isBinary) return onAudio?.(Buffer.from(raw as Buffer));
		// A throw here would escape ws and end the whole server process.
		const parsed = messageSchema.safeParse(parseJson(raw.toString()));
		if (!parsed.success) return fail(new Error('Unknown study session message.'));
		const message = parsed.data;
		if (message.type === 'played') onPlayed?.(message.clip);
		if (message.type === 'skip') onSkip?.();
		if (message.type === 'done') onDone?.();
		if (message.type === 'end') ended?.();
	});
	client.on('close', () => {
		closed = true;
		lifetime.abort();
		asr?.terminate();
		stopWatching();
		if (current === self) current = undefined;
		void conversation?.close();
	});

	try {
		requireTranscription();
		const [output] = await db().select().from(t.outputs).where(eq(t.outputs.id, outputId));
		const [run] = await db()
			.select()
			.from(t.studyRuns)
			.where(and(eq(t.studyRuns.id, runId), eq(t.studyRuns.outputId, outputId)));
		if (!output?.study || !run) throw new Error('This study session no longer exists.');
		if (run.status === 'complete') throw new Error('This run is finished. Start a new one.');
		const study: StudyInfo = output.study;
		const { plan } = study;
		const modelId = await gradingModel(output.modelId);
		const { voices } = await speechCatalog();
		if (!voices.some((voice) => voice.voiceId === study.voiceId))
			throw new Error('The session voice is no longer available in ElevenLabs.');
		let answers: StudyAnswer[] = (await studyRuns(outputId)).find((r) => r.id === runId)!.answers;
		const excerpts = citedExcerpts(
			plan.segments.flatMap((segment) => segment.citations),
			output.sourceSnapshot as Snapshot
		);
		conversation = new TutorConversation(runId, modelId, async () =>
			primerPrompt(plan, excerpts, answers)
		);
		// The tutor session starts while the first part plays.
		const warming = conversation.warm();
		void warming.catch(() => {});
		let position: Position = { segmentIndex: run.segmentIndex, attempt: run.attempt };
		let clipCount = 0;
		const state = (phase: Phase) =>
			send(client, {
				type: 'state',
				phase,
				segment: Math.min(position.segmentIndex, plan.segments.length - 1),
				segments: plan.segments.length,
				attempt: position.attempt,
				title: plan.segments[position.segmentIndex]?.title ?? plan.title
			});
		const live = () => {
			if (closed) throw new Error('The study session was stopped.');
		};

		/** Plays one clip: binary PCM after its announcement, finished when the browser has played it. */
		async function playClip(
			kind: ClipKind,
			text: string,
			produce: (sendPcm: (pcm: Buffer) => void, signal: AbortSignal) => Promise<void>
		) {
			live();
			const clip = `clip-${++clipCount}`;
			const skipped = new AbortController();
			const finished = new Promise<void>((resolve) => {
				onPlayed = (played) => played === clip && resolve();
				onSkip = () => {
					skipped.abort();
					resolve();
				};
			});
			send(client, { type: 'clip', clip, kind, text });
			let carry: Buffer | undefined;
			const sendPcm = (pcm: Buffer) => {
				if (skipped.signal.aborted || client.readyState !== WebSocket.OPEN) return;
				let data = carry ? Buffer.concat([carry, pcm]) : pcm;
				carry = undefined;
				if (data.length % 2) {
					carry = data.subarray(data.length - 1);
					data = data.subarray(0, data.length - 1);
				}
				for (let at = 0; at < data.length; at += FRAME_BYTES)
					client.send(data.subarray(at, at + FRAME_BYTES));
			};
			try {
				await produce(sendPcm, AbortSignal.any([lifetime.signal, skipped.signal]));
			} catch (error) {
				if (!skipped.signal.aborted) throw error;
			}
			send(client, { type: 'clipEnd', clip });
			await Promise.race([finished, aborted()]);
			onPlayed = onSkip = undefined;
			live();
		}
		const aborted = () =>
			new Promise<never>((_, reject) => {
				if (lifetime.signal.aborted) return reject(new Error('Stopped.'));
				lifetime.signal.addEventListener('abort', () => reject(new Error('Stopped.')), {
					once: true
				});
			});
		const savedClip = (key: string, extra?: Buffer) => async (sendPcm: (pcm: Buffer) => void) => {
			sendPcm(await readFile(clipPath(audioDir(outputId), key, 'pcm_24000')));
			if (extra) sendPcm(extra);
		};
		/** Voices text sentence by sentence; each request starts as soon as its sentence exists. */
		function speaker() {
			const pending: AsyncIterator<Buffer>[] = [];
			let previous = '';
			let wake: (() => void) | undefined;
			let finished = false;
			return {
				say(text: string, signal: AbortSignal) {
					pending.push(
						prefetch(
							speakStream({
								text,
								voiceId: study.voiceId,
								modelId: study.speechModelId,
								previousText: previous || undefined,
								signal
							})
						)
					);
					previous = text;
					wake?.();
				},
				end() {
					finished = true;
					wake?.();
				},
				async drain(sendPcm: (pcm: Buffer) => void) {
					for (;;) {
						const next = pending.shift();
						if (!next) {
							if (finished) return;
							await new Promise<void>((resolve) => (wake = resolve));
							wake = undefined;
							continue;
						}
						for (let chunk = await next.next(); !chunk.done; chunk = await next.next())
							sendPcm(chunk.value);
					}
				}
			};
		}
		/** Speaks a reply as it streams from Claude; returns the grading line and the spoken text. */
		async function speakReply(prompt: string, kind: ClipKind, withHeader: boolean) {
			const voice = speaker();
			let voiceSignal = lifetime.signal;
			const stream = new FeedbackStream(
				{
					onHeader: (parsed) => send(client, { type: 'result', ...parsed }),
					onChunk: (text) => {
						send(client, { type: 'caption', text });
						voice.say(text, voiceSignal);
					}
				},
				withHeader
			);
			// Skipping stops the voice only: the reply still finishes, so the protocol stays complete.
			const reply = conversation!
				.ask(prompt, (delta) => stream.push(delta), lifetime.signal)
				.then(() => stream.end())
				.finally(() => voice.end());
			void reply.catch(() => {});
			await playClip(kind, '', async (sendPcm, signal) => {
				voiceSignal = signal;
				await Promise.all([reply, voice.drain(sendPcm)]);
			});
			await reply;
			return { header: stream.header, spoken: stream.spoken };
		}
		/** Opens transcription, then waits until the learner has finished answering. */
		async function listen() {
			live();
			state('listening');
			return new Promise<string>((resolve, reject) => {
				let started = 0;
				let samples = 0;
				let settled = false;
				let ending = false;
				let chain = Promise.resolve();
				const answer = new AnswerCollector(
					(text) => {
						settled = true;
						onAudio = onDone = undefined;
						stream.terminate();
						send(client, { type: 'heard', text });
						resolve(text);
					},
					() =>
						failed(new Error('Listening paused after ten minutes. Resume when you want to answer.'))
				);
				const failed = (e: unknown) => {
					if (settled) return;
					settled = true;
					answer.dispose();
					onAudio = onDone = undefined;
					stream.terminate();
					reject(e);
				};
				const stream = openRealtimeAsr({
					onReady() {
						started = Date.now();
						onAudio = (pcm) => {
							// After "I'm done" the stream is closing: audio still in flight is dropped.
							if (ending) return;
							samples += pcm.length / 2;
							if (pcm.length % 2 || samples / 24 > Date.now() - started + 1000)
								return failed(new Error('Microphone audio arrived too quickly.'));
							if (!stream.open || stream.bufferedAmount > 48000 * 4)
								return failed(new Error('Transcription connection interrupted.'));
							chain = chain.then(() => stream.send(pcm)).catch(failed);
						};
						// Only the learner ends an answer; pauses never do.
						onDone = () => {
							if (ending) return;
							ending = true;
							answer.done();
							void chain.then(() => stream.end()).catch(failed);
						};
						answer.ready();
						send(client, { type: 'listen' });
					},
					onPartial: (_turn, text) => send(client, { type: 'partial', text }),
					onComplete: (turn) => answer.complete(turn.text),
					onError: failed,
					// Events before the close are handled first, so the last words still count.
					onClose: () =>
						void stream.settled().then(() => {
							if (!answer.closed())
								failed(new Error('Transcription disconnected. Resume to answer again.'));
						})
				});
				asr = stream;
				lifetime.signal.addEventListener('abort', () => failed(new Error('Stopped.')), {
					once: true
				});
			});
		}
		async function savePosition(next: Position, complete = false) {
			position = next;
			await db()
				.update(t.studyRuns)
				.set({
					...next,
					updatedAt: new Date(),
					...(complete ? { status: 'complete' as const, completedAt: new Date() } : {})
				})
				.where(eq(t.studyRuns.id, runId));
		}
		async function sayAgain(text: string) {
			const voice = speaker();
			await playClip('feedback', text, async (sendPcm) => {
				voice.say(text, lifetime.signal);
				voice.end();
				await voice.drain(sendPcm);
			});
		}

		const session = (async () => {
			// Set once the follow-up question has just been spoken in this connection.
			let followUpSpoken = false;
			while (position.segmentIndex < plan.segments.length) {
				const step = resumeStep(position, answers);
				const segment = plan.segments[position.segmentIndex];
				if (step.kind === 'replay') {
					state('feedback');
					await sayAgain(step.answer.feedback);
					await savePosition(nextPosition(position, step.answer.next));
					followUpSpoken = position.attempt === 2;
					continue;
				}
				if (step.kind === 'present') {
					state('presenting');
					if (step.intro) await playClip('intro', plan.intro, savedClip('intro'));
					await playClip(
						'explanation',
						segment.explanation,
						savedClip(studyClipKey(position.segmentIndex, 'explanation'), PAUSE_AFTER_EXPLANATION)
					);
					await playClip(
						'question',
						segment.question,
						savedClip(studyClipKey(position.segmentIndex, 'question'))
					);
				} else if (step.previous && !followUpSpoken) {
					// Resuming at a follow-up: the question ends the saved feedback.
					state('feedback');
					await sayAgain(step.previous.feedback);
				}
				const answer = await listen();
				state('thinking');
				const { header, spoken } = await speakReply(
					answerPrompt(plan, position.segmentIndex, position.attempt, answer),
					'feedback',
					true
				);
				const graded = header ?? FALLBACK_HEADER;
				const next = finalNext(position.attempt, graded.next);
				const [saved] = await db()
					.insert(t.studyAnswers)
					.values({
						runId,
						...position,
						answer,
						verdict: graded.verdict,
						next,
						gap: graded.verdict === 'correct' ? '' : graded.gap,
						feedback: spoken
					})
					.onConflictDoNothing()
					.returning();
				if (saved) answers = [...answers, publicAnswer(saved)];
				await savePosition(nextPosition(position, next));
				followUpSpoken = position.attempt === 2;
			}
			state('thinking');
			await speakReply(WRAP_UP_PROMPT, 'wrapup', false);
		})();
		const outcome = await Promise.race([
			session.then(() => 'finished' as const),
			endRequested.then(() => 'ended' as const)
		]);
		if (outcome === 'ended') {
			// Stop whatever is playing or listening, then record the run as finished early.
			lifetime.abort();
			await session.catch(() => {});
		}
		await savePosition(position, true);
		state('complete');
		send(client, { type: 'complete' });
		stop(1000);
	} catch (e) {
		if (!closed) fail(e);
	}
}

function parseJson(text: string): unknown {
	try {
		return JSON.parse(text);
	} catch {
		return undefined;
	}
}

/** Starts reading a stream immediately, so the next sentence downloads while this one plays. */
function prefetch(source: AsyncIterable<Buffer>): AsyncIterator<Buffer> {
	const queue: Buffer[] = [];
	let done = false;
	let failure: unknown;
	let wake: (() => void) | undefined;
	void (async () => {
		try {
			for await (const chunk of source) {
				queue.push(chunk);
				wake?.();
			}
		} catch (error) {
			failure = error;
		}
		done = true;
		wake?.();
	})();
	return {
		async next() {
			for (;;) {
				const chunk = queue.shift();
				if (chunk) return { value: chunk, done: false };
				if (failure) throw failure;
				if (done) return { value: undefined, done: true };
				await new Promise<void>((resolve) => (wake = resolve));
				wake = undefined;
			}
		}
	};
}
