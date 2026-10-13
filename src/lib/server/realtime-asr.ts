import { WebSocket } from 'ws';
import { required } from './config';
import { TRANSCRIPTION_MODEL } from '../domain';

// TRANSCRIPTION_API_KEY stays in this broker: never pass it to Muse, commands or the browser.
const ASR_URL = 'wss://api.meta.ai/v1/asr/realtime';

/** Fails before any state changes when transcription is not configured. */
export const requireTranscription = () => void required('TRANSCRIPTION_API_KEY');

export function providerErrorMessage(event: unknown): string {
	const detail =
		event && typeof event === 'object'
			? (['errorType', 'message'] as const)
					.map((key) => (event as Record<string, unknown>)[key])
					.filter((value): value is string => typeof value === 'string' && value.length > 0)
					.join(' — ')
					.slice(0, 300)
			: '';
	return detail
		? `Transcription stream interrupted: ${detail}.`
		: 'Transcription API rejected the stream. Check the API key and usage limits.';
}

/**
 * Provider events, handled one at a time in arrival order. `offsetMs` is the audio processed
 * so far in this stream, when the provider reports it.
 */
export interface AsrEvents {
	onReady(): void;
	onSpeechStart?(turnId: number, offsetMs: number | undefined): void;
	onSpeechEnd?(turnId: number, offsetMs: number | undefined): void;
	onSpeaker?(label: string): void;
	/** The whole current turn so far. */
	onPartial?(text: string): void;
	onComplete(turnId: number, text: string, offsetMs: number | undefined): void | Promise<void>;
	/** The connection failed, the provider reported an error, or a handler threw. */
	onError(error: Error): void;
	onClose(code: number): void;
}
export interface RealtimeAsr {
	/** Sends 24 kHz signed 16-bit mono PCM; streams must arrive at recording speed. */
	send(pcm: Buffer): Promise<void>;
	/** Asks the provider to finish the last turn and close the stream cleanly (code 1000). */
	end(): void;
	terminate(): void;
	/** Resolves once every event received so far has been handled. */
	settled(): Promise<void>;
	readonly open: boolean;
	readonly bufferedAmount: number;
}

/** Opens one realtime transcription stream with speech-turn detection and speaker labels. */
export function openRealtimeAsr(events: AsrEvents): RealtimeAsr {
	const provider = new WebSocket(ASR_URL, { maxPayload: 4 * 1024 * 1024, handshakeTimeout: 10000 });
	let chain = Promise.resolve();
	provider.on('open', () =>
		provider.send(
			JSON.stringify({
				authorization: { accessToken: 'Bearer ' + required('TRANSCRIPTION_API_KEY') },
				audioEncoding: 'PCM_24KHZ',
				model: TRANSCRIPTION_MODEL,
				mode: 'DIARIZATION',
				partialMode: 'CUMULATIVE',
				emitAudioProgress: true
			})
		)
	);
	provider.on('error', (e) => events.onError(e));
	provider.on('close', (code) => events.onClose(code));
	provider.on('message', (raw) => {
		chain = chain
			.then(async () => {
				const event = JSON.parse(raw.toString());
				if (typeof event.sessionId === 'string' && !event.type) return events.onReady();
				if (event.type === 'error') {
					console.error('Transcription provider error:', JSON.stringify(event).slice(0, 1000));
					throw new Error(providerErrorMessage(event));
				}
				const processed = Number(event.audioProcessedMs);
				const offsetMs = Number.isFinite(processed) ? processed : undefined;
				const turn = Number.isInteger(event.turnId) ? (event.turnId as number) : undefined;
				if (event.type === 'speechStart' && turn !== undefined)
					events.onSpeechStart?.(turn, offsetMs);
				if (event.type === 'speechEnd' && turn !== undefined) events.onSpeechEnd?.(turn, offsetMs);
				if (event.type === 'speaker' && typeof event.label === 'string')
					events.onSpeaker?.(event.label);
				if (event.type === 'transcript' && typeof event.transcript === 'string')
					events.onPartial?.(event.transcript);
				if (
					event.type === 'speechComplete' &&
					typeof event.transcript === 'string' &&
					turn !== undefined
				)
					await events.onComplete(turn, event.transcript, offsetMs);
			})
			.catch((e) => events.onError(e instanceof Error ? e : new Error('Transcription failed.')));
	});
	return {
		send: (pcm) =>
			new Promise<void>((resolve, reject) =>
				provider.send(pcm, (error) => (error ? reject(error) : resolve()))
			),
		end: () => provider.send(JSON.stringify({ type: 'endStream' })),
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
