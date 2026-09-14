import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AudioChunk, LocalRecording } from './storage';

const storage = vi.hoisted(() => ({
	chunks: [] as AudioChunk[],
	remove: vi.fn(),
	acknowledge: vi.fn()
}));

vi.mock('./storage', () => ({
	listRecordings: vi.fn(async () => []),
	saveRecording: vi.fn(),
	storeChunk: vi.fn(),
	countPendingChunks: async () => storage.chunks.length,
	firstPendingChunk: async () => storage.chunks[0],
	acknowledgeChunk: async (id: string, sequence: number) => {
		storage.acknowledge(id, sequence);
		storage.chunks = storage.chunks.filter((chunk) => chunk.sequence !== sequence);
	},
	removeRecording: storage.remove
}));

import { BrowserRecorder, waitForRecoveryJob } from './recorder.svelte';

const recording: LocalRecording = {
	id: 'recording-id',
	projectId: 'project-id',
	name: 'Lecture',
	source: 'microphone',
	createdAt: '2026-09-14T10:00:00Z',
	nextSequence: 3,
	samples: 50000
};

describe('recording recovery', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		storage.chunks = [
			{ recordingId: recording.id, sequence: 1, startSample: 24000, pcm: new ArrayBuffer(4000) },
			{ recordingId: recording.id, sequence: 2, startSample: 26000, pcm: new ArrayBuffer(48000) }
		];
	});
	afterEach(() => {
		vi.unstubAllGlobals();
		vi.useRealTimers();
	});

	it('uploads pending audio with exact sample offsets, acknowledges it, then finalizes', async () => {
		const requests = vi.fn(async () => new Response('{}'));
		vi.stubGlobal('fetch', requests);
		const recorder = new BrowserRecorder();
		expect(await recorder.recover(recording)).toBe(recording.id);
		expect(requests.mock.calls).toHaveLength(3);
		const calls = requests.mock.calls as unknown as Array<[string, RequestInit]>;
		expect(calls.map(([url]) => url)).toEqual([
			'/api/recordings/recording-id/chunks/1',
			'/api/recordings/recording-id/chunks/2',
			'/api/recordings/recording-id/recover'
		]);
		expect(calls[1][1].headers).toMatchObject({ 'x-start-sample': '26000' });
		expect(calls[2][1].body).toBe(JSON.stringify({ finalize: true }));
		expect(calls[2][1].headers).toMatchObject({ 'x-studyloom-interaction': '1' });
		expect(calls[0][1].headers).not.toHaveProperty('x-studyloom-interaction');
		expect(storage.acknowledge).toHaveBeenCalledTimes(2);
		expect(storage.remove).toHaveBeenCalledWith(recording.id);
		expect(recorder.state).toBe('complete');
	});

	it('retains unacknowledged audio after an upload failure and resumes from that sequence', async () => {
		const requests = vi
			.fn()
			.mockResolvedValueOnce(new Response('{}'))
			.mockResolvedValueOnce(new Response('{"message":"Offline"}', { status: 503 }))
			.mockImplementation(async () => new Response('{}'));
		vi.stubGlobal('fetch', requests);
		const recorder = new BrowserRecorder();
		expect(await recorder.recover(recording)).toBeUndefined();
		expect(recorder.state).toBe('interrupted');
		expect(recorder.error).toBe('Offline');
		expect(storage.remove).not.toHaveBeenCalled();
		expect(storage.chunks.map((chunk) => chunk.sequence)).toEqual([2]);
		expect(await recorder.stop()).toBe(recording.id);
		expect(requests.mock.calls[2][0]).toBe('/api/recordings/recording-id/chunks/2');
		expect(storage.remove).toHaveBeenCalledOnce();
	});

	it('keeps recovery metadata when finalization fails even after all audio is acknowledged', async () => {
		storage.chunks = [];
		vi.stubGlobal(
			'fetch',
			vi.fn(async () => new Response('{"message":"Try later"}', { status: 503 }))
		);
		const recorder = new BrowserRecorder();
		expect(await recorder.recover(recording)).toBeUndefined();
		expect(storage.remove).not.toHaveBeenCalled();
		expect(recorder.needsAttention).toBe(true);
	});

	it('waits through queued and running recovery jobs without extending the session', async () => {
		vi.useFakeTimers();
		const requests = vi
			.fn()
			.mockResolvedValueOnce(new Response(JSON.stringify({ job: { status: 'queued' } })))
			.mockResolvedValueOnce(
				new Response(JSON.stringify({ job: { status: 'running', progress: 'Transcribing audio' } }))
			)
			.mockResolvedValueOnce(new Response(JSON.stringify({ job: { status: 'succeeded' } })));
		vi.stubGlobal('fetch', requests);
		const progress = vi.fn();
		let finished = false;
		const completion = waitForRecoveryJob('job-id', progress, new AbortController().signal).then(
			() => {
				finished = true;
			}
		);
		await vi.advanceTimersByTimeAsync(1000);
		expect(finished).toBe(false);
		expect(progress).toHaveBeenCalledWith('Transcribing audio');
		await vi.advanceTimersByTimeAsync(1000);
		await completion;
		expect(finished).toBe(true);
		expect(requests).toHaveBeenCalledTimes(3);
		expect(
			requests.mock.calls.every(([url, options]) => url === '/api/jobs/job-id' && !options.headers)
		).toBe(true);
	});

	it.each(['failed', 'cancelled'])('rejects a %s recovery job', async (status) => {
		vi.stubGlobal(
			'fetch',
			vi.fn(async () => new Response(JSON.stringify({ job: { status, error: 'Recovery failed' } })))
		);
		await expect(
			waitForRecoveryJob('job-id', vi.fn(), new AbortController().signal)
		).rejects.toThrow('Recovery failed');
	});
});
