import type { EventEmitter } from 'node:events';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const sockets = vi.hoisted(() => [] as FakeSocket[]);
interface FakeSocket extends EventEmitter {
	url: string;
	options: { headers: Record<string, string> };
	sent: unknown[];
	readyState: number;
	bufferedAmount: number;
	send(data: unknown, callback?: (error?: Error) => void): void;
	close(code: number): void;
	terminate(): void;
}
vi.mock('ws', async () => {
	const { EventEmitter } = await import('node:events');
	class WebSocket extends EventEmitter {
		static OPEN = 1;
		sent: unknown[] = [];
		readyState = 1;
		bufferedAmount = 0;
		constructor(
			readonly url: string,
			readonly options: unknown
		) {
			super();
			sockets.push(this as unknown as FakeSocket);
		}
		send(data: unknown, callback?: (error?: Error) => void) {
			this.sent.push(data);
			callback?.();
		}
		close(code: number) {
			this.readyState = 3;
			this.emit('close', code);
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
	vi.stubEnv('ELEVENLABS_API_KEY', 'secret');
});
const message = (socket: FakeSocket, value: unknown) =>
	socket.emit('message', Buffer.from(JSON.stringify(value)));
const sent = (socket: FakeSocket, i: number) => JSON.parse(String(socket.sent.at(i)));

describe('Realtime transcription stream', () => {
	it('streams 24 kHz audio and reports committed segments in order', async () => {
		const events: unknown[] = [];
		const asr = openRealtimeAsr({
			onReady: () => events.push('ready'),
			onPartial: (turn, text) => events.push(['partial', turn, text]),
			onComplete: async (turn) => {
				await new Promise((resolve) => setTimeout(resolve, 5));
				events.push(['complete', turn]);
			},
			onError: (error) => events.push(['error', error.message]),
			onClose: (code) => events.push(['close', code])
		});
		const [socket] = sockets;
		const url = new URL(socket.url);
		expect(url.pathname).toBe('/v1/speech-to-text/realtime');
		expect(Object.fromEntries(url.searchParams)).toMatchObject({
			model_id: 'scribe_v2_realtime',
			audio_format: 'pcm_24000',
			commit_strategy: 'vad',
			include_timestamps: 'true'
		});
		expect(socket.options.headers['xi-api-key']).toBe('secret');
		message(socket, { message_type: 'session_started', session_id: 'abc' });
		message(socket, { message_type: 'partial_transcript', text: 'Water' });
		message(socket, { message_type: 'partial_transcript', text: '' });
		message(socket, { message_type: 'committed_transcript', text: 'Water moves.' });
		message(socket, {
			message_type: 'committed_transcript_with_timestamps',
			text: 'Water moves.',
			words: [
				{ text: 'Water', start: 0.12, end: 0.5, type: 'word' },
				{ text: ' ', start: 0.5, end: 0.55, type: 'spacing' },
				{ text: 'moves.', start: 0.55, end: 1.01, type: 'word' }
			]
		});
		message(socket, { message_type: 'partial_transcript', text: 'Then' });
		await asr.settled();
		expect(events).toEqual([
			'ready',
			['partial', 0, 'Water'],
			['complete', { turnId: 0, text: 'Water moves.', startMs: 120, endMs: 1010 }],
			['partial', 1, 'Then']
		]);
		await asr.send(Buffer.from([1, 2, 3, 4]));
		expect(sent(socket, -1)).toEqual({
			message_type: 'input_audio_chunk',
			audio_base_64: Buffer.from([1, 2, 3, 4]).toString('base64'),
			commit: false,
			sample_rate: 24_000
		});
		expect(asr.open).toBe(true);
	});
	it('ends by committing the last words, then closes cleanly', async () => {
		vi.useFakeTimers();
		try {
			const events: unknown[] = [];
			const asr = openRealtimeAsr({
				onReady: () => {},
				onComplete: (turn) => void events.push(turn.text),
				onError: (error) => events.push(error.message),
				onClose: (code) => events.push(['close', code])
			});
			const [socket] = sockets;
			asr.end();
			expect(sent(socket, -1)).toMatchObject({ audio_base_64: '', commit: true });
			message(socket, {
				message_type: 'committed_transcript_with_timestamps',
				text: 'Last words.',
				words: []
			});
			await asr.settled();
			expect(events).toEqual(['Last words.']);
			await vi.advanceTimersByTimeAsync(1000);
			expect(events).toEqual(['Last words.', ['close', 1000]]);
		} finally {
			vi.useRealTimers();
		}
	});
	it('closes after a short wait when the commit brings nothing', async () => {
		vi.useFakeTimers();
		try {
			const onClose = vi.fn();
			const asr = openRealtimeAsr({
				onReady: () => {},
				onComplete: () => {},
				onError: () => {},
				onClose
			});
			asr.end();
			await vi.advanceTimersByTimeAsync(3_900);
			expect(onClose).not.toHaveBeenCalled();
			await vi.advanceTimersByTimeAsync(200);
			expect(onClose).toHaveBeenCalledWith(1000);
		} finally {
			vi.useRealTimers();
		}
	});
	it('turns provider errors into safe messages', async () => {
		vi.spyOn(console, 'error').mockImplementation(() => {});
		const onError = vi.fn();
		const asr = openRealtimeAsr({
			onReady: () => {},
			onComplete: () => {},
			onError,
			onClose: () => {}
		});
		message(sockets[0], { message_type: 'auth_error', error: 'Invalid API key' });
		message(sockets[0], { message_type: 'committed_transcript_entities', entities: [] });
		await asr.settled();
		expect(onError).toHaveBeenCalledTimes(1);
		expect(onError.mock.calls[0][0].message).toBe(
			'Transcription stream interrupted: auth_error — Invalid API key.'
		);
		expect(providerErrorMessage({})).toMatch(/API key and usage limits/);
	});
});
