import type { EventEmitter } from 'node:events';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const sockets = vi.hoisted(() => [] as FakeSocket[]);
interface FakeSocket extends EventEmitter {
	sent: unknown[];
	readyState: number;
	bufferedAmount: number;
	send(data: unknown, callback?: (error?: Error) => void): void;
	terminate(): void;
}
vi.mock('ws', async () => {
	const { EventEmitter } = await import('node:events');
	class WebSocket extends EventEmitter {
		static OPEN = 1;
		sent: unknown[] = [];
		readyState = 1;
		bufferedAmount = 0;
		constructor(readonly url: string) {
			super();
			sockets.push(this as unknown as FakeSocket);
		}
		send(data: unknown, callback?: (error?: Error) => void) {
			this.sent.push(data);
			callback?.();
		}
		terminate() {
			this.emit('close', 1006);
		}
	}
	return { WebSocket };
});
const { openRealtimeAsr, providerErrorMessage } = await import('./realtime-asr');

beforeEach(() => {
	sockets.length = 0;
	vi.stubEnv('TRANSCRIPTION_API_KEY', 'secret');
});
const message = (socket: FakeSocket, value: unknown) =>
	socket.emit('message', Buffer.from(JSON.stringify(value)));

describe('Realtime transcription stream', () => {
	it('authenticates, then reports turns in order', async () => {
		const events: unknown[] = [];
		const asr = openRealtimeAsr({
			onReady: () => events.push('ready'),
			onSpeechStart: (turn, ms) => events.push(['start', turn, ms]),
			onSpeechEnd: (turn, ms) => events.push(['end', turn, ms]),
			onSpeaker: (label) => events.push(['speaker', label]),
			onPartial: (text) => events.push(['partial', text]),
			onComplete: async (turn, text) => {
				await new Promise((resolve) => setTimeout(resolve, 5));
				events.push(['complete', turn, text]);
			},
			onError: (error) => events.push(['error', error.message]),
			onClose: (code) => events.push(['close', code])
		});
		const [socket] = sockets;
		socket.emit('open');
		expect(JSON.parse(String(socket.sent[0]))).toMatchObject({
			authorization: { accessToken: 'Bearer secret' },
			audioEncoding: 'PCM_24KHZ',
			partialMode: 'CUMULATIVE'
		});
		message(socket, { sessionId: 'abc' });
		message(socket, { type: 'speechStart', turnId: 1, audioProcessedMs: 120 });
		message(socket, { type: 'speaker', label: 'A' });
		message(socket, { type: 'transcript', transcript: 'Water' });
		message(socket, { type: 'speechComplete', turnId: 1, transcript: 'Water moves.' });
		message(socket, { type: 'speechEnd', turnId: 1 });
		await asr.settled();
		expect(events).toEqual([
			'ready',
			['start', 1, 120],
			['speaker', 'A'],
			['partial', 'Water'],
			['complete', 1, 'Water moves.'],
			['end', 1, undefined]
		]);
		await asr.send(Buffer.alloc(4));
		asr.end();
		expect(socket.sent.at(-1)).toBe(JSON.stringify({ type: 'endStream' }));
		expect(asr.open).toBe(true);
	});
	it('turns provider errors into safe messages', async () => {
		const onError = vi.fn();
		const asr = openRealtimeAsr({
			onReady: () => {},
			onComplete: () => {},
			onError,
			onClose: () => {}
		});
		message(sockets[0], { type: 'error', errorType: 'invalid_request_error', message: 'Too slow' });
		await asr.settled();
		vi.spyOn(console, 'error').mockImplementation(() => {});
		expect(onError.mock.calls[0][0].message).toBe(
			'Transcription stream interrupted: invalid_request_error — Too slow.'
		);
		expect(providerErrorMessage({})).toMatch(/API key and usage limits/);
	});
});
