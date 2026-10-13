import type { Server } from 'node:http';
import { WebSocket, WebSocketServer } from 'ws';
import { and, desc, eq, inArray } from 'drizzle-orm';
import { z } from 'zod';
import { db, closeDatabase, migrateDatabase } from '../lib/server/db';
import * as t from '../lib/server/db/schema';
import { origin, safeError } from '../lib/server/config';
import { readSession } from '../lib/server/auth';
import { putChunk } from '../lib/server/storage';
import { finishRecording, startWorkers } from '../lib/server/jobs';
import {
	openRealtimeAsr,
	requireTranscription,
	type RealtimeAsr
} from '../lib/server/realtime-asr';
import { museHost } from '../lib/server/muse';
import { send, tokenFrom, watchSession } from './socket';
import { studySession } from './study-socket';
const startSchema = z.object({
	type: z.literal('start'),
	segmentId: z.uuid(),
	startSample: z.number().int().nonnegative()
});
export async function attachRuntime(server: Server) {
	// This app runs one process. Apply pending migrations before touching tables:
	// on a fresh database, or when this process starts before the post-deploy
	// migrate finishes, the recovery updates below would throw 42P01 and crash.
	await migrateDatabase();
	// Crash recovery makes unfinished live spans eligible for file transcription.
	await db()
		.update(t.recordingSegments)
		.set({ status: 'interrupted' })
		.where(eq(t.recordingSegments.status, 'live'));
	await db()
		.update(t.materials)
		.set({
			status: 'paused',
			notes: 'Recording interrupted. Resume or save from the browser that recorded it.'
		})
		.where(eq(t.materials.status, 'recording'));
	const stopWorkers = startWorkers();
	const wss = new WebSocketServer({ noServer: true, maxPayload: 96004 });
	server.on('upgrade', async (req, socket, head) => {
		try {
			const path = new URL(req.url || '/', origin()).pathname;
			const recording = /^\/api\/recordings\/([0-9a-f-]{36})\/stream$/.exec(path);
			const study = /^\/api\/outputs\/([0-9a-f-]{36})\/runs\/([0-9a-f-]{36})\/stream$/.exec(path);
			if (
				!(recording || study) ||
				req.headers.origin !== origin() ||
				!(await readSession(tokenFrom(req)))
			) {
				socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
				return;
			}
			wss.handleUpgrade(req, socket, head, (client) => {
				if (recording) void live(client, recording[1], tokenFrom(req));
				else if (study) void studySession(client, study[1], study[2], tokenFrom(req));
			});
		} catch {
			socket.end('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n');
		}
	});
	return async () => {
		for (const client of wss.clients) client.close(1001, 'Server restarting');
		await new Promise((r) => setTimeout(r, 250));
		wss.close();
		await stopWorkers();
		museHost.close();
		await closeDatabase();
	};
}
async function live(client: WebSocket, id: string, sessionToken: string | undefined) {
	let provider: RealtimeAsr | undefined,
		segmentId: string | undefined,
		startSample = 0,
		cursor = 0,
		nextSequence = 0,
		ready = false,
		finishing = false,
		completed = false;
	let fatal: Error | undefined;
	let chain = Promise.resolve();
	let queuedBytes = 0;
	let liveStart = 0;
	let currentTurn: number | undefined;
	const turns = new Map<number, { start: number; end?: number; speaker?: string }>();
	let providerDoneResolve: (() => void) | undefined,
		providerDoneReject: ((e: Error) => void) | undefined;
	const providerDone = new Promise<void>((resolve, reject) => {
		providerDoneResolve = resolve;
		providerDoneReject = reject;
	});
	void providerDone.catch(() => {});
	const timer = setTimeout(() => {
		if (!ready) fail(new Error('Recording handshake timed out.'));
	}, 18000);
	const stopWatching = watchSession(
		client,
		sessionToken,
		'Your session expired. Sign in to save or resume recording.',
		(e) => fail(e)
	);
	const fail = (e: unknown) => {
		fatal = e instanceof Error ? e : new Error('Transcription failed.');
		send(client, { type: 'error', message: safeError(e) });
		client.close(1011, 'Recording interrupted');
		provider?.terminate();
	};
	async function markInterrupted() {
		if (segmentId && !completed) {
			await db()
				.update(t.recordingSegments)
				.set({ status: 'interrupted', endSample: cursor })
				.where(and(eq(t.recordingSegments.id, segmentId), eq(t.recordingSegments.status, 'live')));
			await db()
				.update(t.materials)
				.set({ status: 'paused', updatedAt: new Date() })
				.where(and(eq(t.materials.id, id), eq(t.materials.status, 'recording')));
		}
	}
	client.on('close', () => {
		clearTimeout(timer);
		stopWatching();
		provider?.terminate();
		void chain.finally(() => markInterrupted()).catch(() => {});
	});
	client.on('error', () => {});
	client.on('message', (raw, isBinary) => {
		const rawSize =
			raw instanceof ArrayBuffer
				? raw.byteLength
				: Array.isArray(raw)
					? raw.reduce((n, b) => n + b.length, 0)
					: raw.length;
		queuedBytes += rawSize;
		if (queuedBytes > 48000 * 5) {
			fail(new Error('Connection cannot keep up with audio. Recording paused for recovery.'));
			return;
		}
		chain = chain
			.then(async () => {
				if (isBinary) {
					const bytes = Buffer.from(raw as Buffer);
					if (!ready || finishing || bytes.length < 6)
						throw new Error('Audio arrived outside a recording segment.');
					const sequence = bytes.readUInt32LE(0);
					const pcm = bytes.subarray(4);
					if (sequence !== nextSequence || pcm.length % 2 || pcm.length > 96000)
						throw new Error('Audio sequence is out of order.');
					if ((cursor - startSample + pcm.length / 2) / 24 > Date.now() - liveStart + 4000)
						throw new Error('Audio is arriving too quickly. Save the backlog before resuming.');
					const result = await putChunk(id, sequence, pcm, cursor);
					if (result.duplicate)
						throw new Error('Duplicate live audio must be recovered before resuming.');
					cursor += pcm.length / 2;
					nextSequence++;
					if (!provider?.open || provider.bufferedAmount > 48000 * 4)
						throw new Error('Transcription connection interrupted.');
					await provider.send(pcm);
					send(client, { type: 'ack', sequence });
					return;
				}
				const event = JSON.parse(raw.toString());
				if (event.type === 'start') {
					if (segmentId) throw new Error('Already recording.');
					const input = startSchema.parse(event);
					requireTranscription();
					await db().transaction(async (tx) => {
						const [material] = await tx
							.select()
							.from(t.materials)
							.where(eq(t.materials.id, id))
							.for('update');
						if (!material || material.kind !== 'recording' || material.status !== 'paused')
							throw new Error('This recording is active or still recovering.');
						const [activeJob] = await tx
							.select()
							.from(t.jobs)
							.where(and(eq(t.jobs.materialId, id), inArray(t.jobs.status, ['queued', 'running'])))
							.limit(1);
						if (activeJob) throw new Error('Wait for saved audio to finish recovering.');
						const [last] = await tx
							.select()
							.from(t.uploadChunks)
							.where(eq(t.uploadChunks.materialId, id))
							.orderBy(desc(t.uploadChunks.sequence))
							.limit(1);
						const expected = last ? (last.startSample ?? 0) + last.size / 2 : 0;
						if (expected !== input.startSample)
							throw new Error('Save pending audio chunks before resuming.');
						const [interrupted] = await tx
							.select()
							.from(t.recordingSegments)
							.where(
								and(
									eq(t.recordingSegments.materialId, id),
									eq(t.recordingSegments.status, 'interrupted')
								)
							)
							.limit(1);
						if (interrupted)
							throw new Error('Recover interrupted audio before starting a fresh segment.');
						await tx.insert(t.recordingSegments).values({
							id: input.segmentId,
							materialId: id,
							startSample: input.startSample,
							status: 'live'
						});
						await tx
							.update(t.materials)
							.set({ status: 'recording', updatedAt: new Date() })
							.where(eq(t.materials.id, id));
						nextSequence = last ? last.sequence + 1 : 0;
					});
					segmentId = input.segmentId;
					startSample = input.startSample;
					cursor = startSample;
					const msAt = (offsetMs: number | undefined) =>
						offsetMs !== undefined
							? Math.round(startSample / 24 + offsetMs)
							: Math.round(cursor / 24);
					provider = openRealtimeAsr({
						onReady() {
							ready = true;
							clearTimeout(timer);
							liveStart = Date.now();
							send(client, { type: 'ready', nextSequence });
						},
						onSpeechStart(turnId, offsetMs) {
							currentTurn = turnId;
							turns.set(turnId, { start: msAt(offsetMs) });
						},
						onSpeechEnd(turnId, offsetMs) {
							const turn = turns.get(turnId);
							if (turn) turn.end = msAt(offsetMs);
						},
						onSpeaker(label) {
							const turn = currentTurn !== undefined ? turns.get(currentTurn) : undefined;
							if (turn) turn.speaker = label;
						},
						onPartial(text) {
							send(client, {
								type: 'transcript',
								text,
								final: false,
								turnId: `${segmentId}:${currentTurn ?? 'pending'}`,
								speaker: currentTurn !== undefined ? turns.get(currentTurn)?.speaker : undefined
							});
						},
						async onComplete(turnId, text, offsetMs) {
							const turn = turns.get(turnId) ?? { start: Math.round(startSample / 24) };
							const values = {
								materialId: id,
								segmentId: segmentId!,
								turnId,
								startMs: turn.start,
								endMs: turn.end ?? msAt(offsetMs),
								text,
								speaker: turn.speaker ?? null
							};
							if (text.trim())
								await db()
									.insert(t.transcriptTurns)
									.values(values)
									.onConflictDoUpdate({
										target: [t.transcriptTurns.segmentId, t.transcriptTurns.turnId],
										set: { text: values.text, endMs: values.endMs, speaker: values.speaker }
									});
							send(client, {
								type: 'transcript',
								text,
								final: true,
								turnId: `${segmentId}:${turnId}`,
								speaker: turn.speaker,
								startMs: values.startMs,
								endMs: values.endMs
							});
							turns.delete(turnId);
						},
						onError(e) {
							providerDoneReject?.(new Error('Transcription connection failed.'));
							fail(e);
						},
						onClose(code) {
							if (finishing && code === 1000) providerDoneResolve?.();
							else {
								providerDoneReject?.(new Error('Transcription stream ended unexpectedly.'));
								if (!completed)
									fail(new Error('Transcription disconnected. Audio is saved for recovery.'));
							}
						}
					});
					return;
				}
				if (event.type === 'pause' || event.type === 'stop') {
					if (!ready || finishing) throw new Error('Recording is not active.');
					finishing = true;
					provider!.end();
					let timeout: NodeJS.Timeout | undefined;
					try {
						await Promise.race([
							providerDone,
							new Promise<never>((_, reject) => {
								timeout = setTimeout(
									() => reject(new Error('Final transcription timed out. Save to recover it.')),
									15000
								);
							})
						]);
					} finally {
						clearTimeout(timeout);
					}
					await provider!.settled();
					if (fatal) throw fatal;
					await db()
						.update(t.recordingSegments)
						.set({ status: 'complete', endSample: cursor })
						.where(eq(t.recordingSegments.id, segmentId!));
					if (event.type === 'stop') await finishRecording(id);
					else
						await db()
							.update(t.materials)
							.set({ status: 'paused', updatedAt: new Date() })
							.where(eq(t.materials.id, id));
					completed = true;
					send(client, { type: event.type === 'stop' ? 'stopped' : 'paused' });
					client.close(1000);
					return;
				}
				throw new Error('Unknown recording message.');
			})
			.catch(fail)
			.finally(() => {
				queuedBytes -= rawSize;
			});
	});
}
