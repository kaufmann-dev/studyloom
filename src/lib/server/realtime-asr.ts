import { WebSocket } from 'ws';
import { openTranscriptionSocket } from './elevenlabs';

export { requireTranscription } from './elevenlabs';

/** After "end", a commit result closes the stream once nothing else arrives for this long. */
const END_QUIET_MS = 700;
/** "end" closes the stream after this long even when the provider sends nothing more. */
const END_MAX_MS = 4_000;
const TRANSCRIPT_EVENTS = new Set([
	'session_started',
	'partial_transcript',
	'committed_transcript',
	'committed_transcript_with_timestamps'
]);

export function providerErrorMessage(event: unknown): string {
	const detail =
		event && typeof event === 'object'
			? (['message_type', 'error'] as const)
					.map((key) => (event as Record<string, unknown>)[key])
					.filter((value): value is string => typeof value === 'string' && value.length > 0)
					.join(' — ')
					.slice(0, 300)
			: '';
	return detail
		? `Transcription stream interrupted: ${detail}.`
		: 'ElevenLabs rejected the transcription stream. Check the API key and usage limits.';
}

/** A finished segment of speech; times are milliseconds from the start of this stream. */
export interface AsrTurn {
	turnId: number;
	text: string;
	startMs?: number;
	endMs?: number;
}
/** Provider events, handled one at a time in arrival order. */
export interface AsrEvents {
	onReady(): void;
	/** The current, not yet committed segment so far. */
	onPartial?(turnId: number, text: string): void;
	onComplete(turn: AsrTurn): void | Promise<void>;
	/** The connection failed, the provider reported an error, or a handler threw. */
	onError(error: Error): void;
	onClose(code: number): void;
}
export interface RealtimeAsr {
	/** Sends 24 kHz signed 16-bit mono PCM; streams must arrive at recording speed. */
	send(pcm: Buffer): Promise<void>;
	/** Commits the last words and closes the stream cleanly (code 1000) once they arrived. */
	end(): void;
	terminate(): void;
	/** Resolves once every event received so far has been handled. */
	settled(): Promise<void>;
	readonly open: boolean;
	readonly bufferedAmount: number;
}

const audioChunk = (pcm: Buffer, commit: boolean) =>
	JSON.stringify({
		message_type: 'input_audio_chunk',
		audio_base_64: pcm.toString('base64'),
		commit,
		sample_rate: 24_000
	});

/** Opens one ElevenLabs realtime transcription stream that commits segments at pauses. */
export function openRealtimeAsr(events: AsrEvents): RealtimeAsr {
	const provider = openTranscriptionSocket();
	let chain = Promise.resolve();
	let turnId = 0;
	let ending: { quiet?: NodeJS.Timeout; max: NodeJS.Timeout } | undefined;
	const close = () => {
		if (ending) {
			clearTimeout(ending.quiet);
			clearTimeout(ending.max);
		}
		if (provider.readyState === WebSocket.OPEN) provider.close(1000);
	};
	provider.on('error', (e) => events.onError(e));
	provider.on('close', (code) => {
		if (ending) {
			clearTimeout(ending.quiet);
			clearTimeout(ending.max);
		}
		events.onClose(code);
	});
	provider.on('message', (raw) => {
		chain = chain
			.then(async () => {
				const event = JSON.parse(raw.toString());
				const type = String(event.message_type ?? '');
				if (!TRANSCRIPT_EVENTS.has(type)) {
					if (typeof event.error !== 'string' && !type.endsWith('error')) return;
					console.error('Transcription provider error:', JSON.stringify(event).slice(0, 1000));
					throw new Error(providerErrorMessage(event));
				}
				if (type === 'session_started') return events.onReady();
				if (type === 'partial_transcript') {
					// Keepalives repeat the partial or send it empty; only real text is worth showing.
					if (typeof event.text === 'string' && event.text.trim())
						events.onPartial?.(turnId, event.text);
					return;
				}
				if (type !== 'committed_transcript_with_timestamps') return;
				const text = typeof event.text === 'string' ? event.text.trim() : '';
				const words = (Array.isArray(event.words) ? event.words : []).filter(
					(word: { type?: string }) => (word.type ?? 'word') === 'word'
				);
				const seconds = (value: unknown) =>
					typeof value === 'number' && Number.isFinite(value)
						? Math.round(value * 1000)
						: undefined;
				if (text)
					await events.onComplete({
						turnId: turnId++,
						text,
						startMs: seconds(words[0]?.start),
						endMs: seconds(words.at(-1)?.end)
					});
				if (ending) {
					clearTimeout(ending.quiet);
					ending.quiet = setTimeout(close, END_QUIET_MS);
				}
			})
			.catch((e) => events.onError(e instanceof Error ? e : new Error('Transcription failed.')));
	});
	return {
		send: (pcm) =>
			new Promise<void>((resolve, reject) =>
				provider.send(audioChunk(pcm, false), (error) => (error ? reject(error) : resolve()))
			),
		end: () => {
			if (ending) return;
			ending = { max: setTimeout(close, END_MAX_MS) };
			provider.send(audioChunk(Buffer.alloc(0), true));
		},
		terminate: () => provider.terminate(),
		settled: () => chain,
		get open() {
			return provider.readyState === WebSocket.OPEN;
		},
		get bufferedAmount() {
			return provider.bufferedAmount;
		}
	};
}
