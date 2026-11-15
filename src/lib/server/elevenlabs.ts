import { openAsBlob } from 'node:fs';
import { basename } from 'node:path';
import { WebSocket } from 'ws';
import { z } from 'zod';
import { ClientError, safeError } from './config';
import { MP3_FORMAT } from './audio';
import type { SpeechModel, Voice } from '../domain';
// ELEVENLABS_API_KEY stays in this module: never pass it to Claude, commands or the browser.
const BASE_URL = 'https://api.elevenlabs.io';
/** ElevenLabs lists no transcription models; bump these when a newer Scribe version ships. */
const TRANSCRIPTION_MODEL = 'scribe_v2';
const REALTIME_TRANSCRIPTION_MODEL = 'scribe_v2_realtime';
const CACHE_MS = 10 * 60_000;
const RETRY_DELAYS_MS = [2000, 6000];

function apiKey() {
	const key = process.env.ELEVENLABS_API_KEY;
	if (!key)
		throw new ClientError(
			503,
			'Set ELEVENLABS_API_KEY to transcribe audio and to voice audio summaries, study sessions and lessons.'
		);
	return key;
}
const errorSchema = z.object({
	detail: z.union([z.object({ status: z.string().optional() }).loose(), z.unknown()]).optional()
});
/** A safe message for a failed request; never echoes the key or the response body. */
async function failure(response: Response) {
	const body = errorSchema.safeParse(await response.json().catch(() => ({})));
	const detail = body.success ? body.data.detail : undefined;
	const status =
		detail && typeof detail === 'object' && 'status' in detail ? String(detail.status) : '';
	if (status === 'quota_exceeded' || response.status === 402)
		return 'ElevenLabs credits are used up. Saved audio is kept; retry after your credits renew or after upgrading.';
	if (response.status === 401) return 'ElevenLabs rejected the API key. Check ELEVENLABS_API_KEY.';
	return `ElevenLabs rejected the request (${response.status}${status ? `, ${status}` : ''}).`;
}
const retryable = (status: number) => status === 429 || status >= 500;
function pause(ms: number, signal?: AbortSignal) {
	return new Promise<void>((resolve, reject) => {
		signal?.throwIfAborted();
		const timer = setTimeout(resolve, ms);
		signal?.addEventListener(
			'abort',
			() => {
				clearTimeout(timer);
				reject(signal.reason);
			},
			{ once: true }
		);
	});
}
/** Sends one request, retrying rate limits, server errors and network failures twice. */
async function request(path: string, init: RequestInit & { timeoutMs: number }) {
	const { timeoutMs, signal, ...rest } = init;
	const headers = { ...rest.headers, 'xi-api-key': apiKey() };
	for (let attempt = 0; ; attempt++) {
		const timeout = AbortSignal.timeout(timeoutMs);
		let response: Response;
		try {
			response = await fetch(BASE_URL + path, {
				...rest,
				headers,
				signal: signal ? AbortSignal.any([signal, timeout]) : timeout
			});
		} catch (cause) {
			if (signal?.aborted) throw cause;
			if (attempt >= RETRY_DELAYS_MS.length)
				throw new Error('Could not reach ElevenLabs. Check the connection and retry.', { cause });
			await pause(RETRY_DELAYS_MS[attempt], signal ?? undefined);
			continue;
		}
		if (response.ok) return response;
		if (retryable(response.status) && attempt < RETRY_DELAYS_MS.length) {
			await response.body?.cancel();
			await pause(RETRY_DELAYS_MS[attempt], signal ?? undefined);
			continue;
		}
		throw new Error(await failure(response));
	}
}

const voicesSchema = z.object({
	voices: z.array(
		z.object({
			voice_id: z.string(),
			name: z.string().default(''),
			description: z.string().nullish(),
			labels: z.record(z.string(), z.string()).nullish()
		})
	)
});
const modelsSchema = z.array(
	z.object({
		model_id: z.string(),
		name: z.string().default(''),
		can_do_text_to_speech: z.boolean().default(false),
		requires_alpha_access: z.boolean().default(false),
		maximum_text_length_per_request: z.number().int().positive().nullish(),
		model_rates: z.object({ character_cost_multiplier: z.number().nullish() }).nullish()
	})
);
function cached<T>(load: () => Promise<T>) {
	let entry: { value: Promise<T>; until: number } | undefined;
	return () => {
		if (!entry || entry.until < Date.now()) {
			const value = load().catch((cause) => {
				entry = undefined;
				throw cause;
			});
			entry = { value, until: Date.now() + CACHE_MS };
		}
		return entry.value;
	};
}
/** The voices this account can use, in ElevenLabs' order. */
export const listVoices = cached(async (): Promise<Voice[]> => {
	const response = await request('/v2/voices?page_size=100&include_total_count=false', {
		timeoutMs: 20_000
	});
	return voicesSchema.parse(await response.json()).voices.map((voice) => {
		const labels = voice.labels ?? {};
		const traits = ['gender', 'age', 'accent', 'descriptive', 'use_case']
			.map((key) => labels[key]?.replaceAll('_', ' '))
			.filter(Boolean);
		return {
			voiceId: voice.voice_id,
			name: voice.name || voice.voice_id,
			description: traits.join(', ') || voice.description?.slice(0, 120) || ''
		};
	});
});
/** Text-to-speech models this account can call, in ElevenLabs' order. */
export const listSpeechModels = cached(async (): Promise<SpeechModel[]> => {
	const response = await request('/v1/models', { timeoutMs: 20_000 });
	return modelsSchema
		.parse(await response.json())
		.filter((model) => model.can_do_text_to_speech && !model.requires_alpha_access)
		.map((model) => ({
			modelId: model.model_id,
			name: model.name || model.model_id,
			costMultiplier: model.model_rates?.character_cost_multiplier ?? 1,
			maxCharacters: model.maximum_text_length_per_request ?? 10_000
		}));
});

export type SpeechFormat = typeof MP3_FORMAT | 'pcm_24000';
export interface SpeechRequest {
	text: string;
	voiceId: string;
	modelId: string;
	/** Constant-bitrate MP3 by default; raw 24 kHz signed 16-bit mono PCM on request. */
	format?: SpeechFormat;
	/** Request IDs of the clips voiced just before this one in the same voice, oldest first. */
	previousRequestIds: string[];
	nextText?: string;
	signal?: AbortSignal;
}
/** Voices one clip, conditioned on the previous requests for smooth joins. */
export async function speak(input: SpeechRequest) {
	const format = input.format ?? MP3_FORMAT;
	const response = await request(
		`/v1/text-to-speech/${encodeURIComponent(input.voiceId)}?output_format=${format}`,
		{
			method: 'POST',
			headers: {
				'content-type': 'application/json',
				accept: format === MP3_FORMAT ? 'audio/mpeg' : 'application/octet-stream'
			},
			body: JSON.stringify({
				text: input.text,
				model_id: input.modelId,
				previous_request_ids: input.previousRequestIds.slice(-3),
				...(input.nextText ? { next_text: input.nextText } : {})
			}),
			signal: input.signal,
			timeoutMs: 120_000
		}
	);
	const audio = Buffer.from(await response.arrayBuffer());
	if (!audio.length) throw new Error('ElevenLabs returned no audio. Retry this job.');
	return { audio, requestId: response.headers.get('request-id') ?? '' };
}
/**
 * Streams one sentence of live speech as 24 kHz signed 16-bit mono PCM. Failures before the
 * first byte are retried like every request; a broken stream is not, because part of the
 * sentence has already played.
 */
export async function* speakStream(input: {
	text: string;
	voiceId: string;
	modelId: string;
	previousText?: string;
	signal?: AbortSignal;
}) {
	const response = await request(
		`/v1/text-to-speech/${encodeURIComponent(input.voiceId)}/stream?output_format=pcm_24000`,
		{
			method: 'POST',
			headers: { 'content-type': 'application/json', accept: 'application/octet-stream' },
			body: JSON.stringify({
				text: input.text,
				model_id: input.modelId,
				...(input.previousText ? { previous_text: input.previousText } : {})
			}),
			signal: input.signal,
			timeoutMs: 60_000
		}
	);
	if (!response.body) throw new Error('ElevenLabs returned no audio.');
	for await (const chunk of response.body) yield Buffer.from(chunk);
}
/** Voices and speech models for the Audio tab; failures become a safe 503. */
export async function speechCatalog() {
	try {
		const [voices, models] = await Promise.all([listVoices(), listSpeechModels()]);
		return { voices, models };
	} catch (cause) {
		if (cause instanceof ClientError) throw cause;
		const reason =
			cause instanceof z.ZodError
				? 'ElevenLabs returned an unexpected response.'
				: safeError(cause);
		throw new ClientError(503, `Could not load ElevenLabs voices and models. ${reason}`);
	}
}

const transcriptWordSchema = z.object({
	text: z.string(),
	start: z.number().nullish(),
	end: z.number().nullish(),
	type: z.string().default('word'),
	speaker_id: z.string().nullish()
});
const transcriptSchema = z.object({
	text: z.string().default(''),
	words: z.array(transcriptWordSchema).default([])
});
export type TranscriptWord = z.input<typeof transcriptWordSchema>;
export interface TranscriptTurn {
	turnId: number;
	startMs: number;
	endMs: number;
	transcript: string;
	speaker?: string;
}
/** A pause this long between words starts a new turn. */
const TURN_PAUSE_S = 1.5;
/** A turn is closed at the next word once it has run this long. */
const TURN_MAX_S = 60;
const speakerLabel = (id: string | null | undefined) => {
	const match = /^speaker_(\d+)$/.exec(id ?? '');
	return match ? `Speaker ${Number(match[1]) + 1}` : id || undefined;
};
/**
 * Groups transcribed words into turns: a new turn starts when the speaker changes, after a pause,
 * or once a turn has run a minute. Times are in milliseconds from the start of the audio.
 */
export function wordsToTurns(words: TranscriptWord[]): TranscriptTurn[] {
	const turns: TranscriptTurn[] = [];
	let current: { start: number; end: number; speaker?: string; text: string } | undefined;
	const flush = () => {
		const text = current?.text.replace(/\s+/g, ' ').trim();
		if (current && text)
			turns.push({
				turnId: turns.length,
				startMs: Math.round(current.start * 1000),
				endMs: Math.round(current.end * 1000),
				transcript: text,
				...(current.speaker && { speaker: current.speaker })
			});
		current = undefined;
	};
	for (const word of words) {
		if ((word.type ?? 'word') === 'spacing') {
			if (current) current.text += word.text;
			continue;
		}
		// Audio events such as (laughter) are not speech.
		if ((word.type ?? 'word') !== 'word') continue;
		const start = word.start ?? current?.end ?? 0;
		const end = Math.max(word.end ?? start, start);
		const speaker = speakerLabel(word.speaker_id);
		if (
			current &&
			(speaker !== current.speaker ||
				start - current.end >= TURN_PAUSE_S ||
				start - current.start >= TURN_MAX_S)
		)
			flush();
		current ??= { start, end, speaker, text: '' };
		current.text += word.text;
		current.end = end;
	}
	flush();
	return turns;
}
/**
 * Transcribes an audio or video file of any common format with speaker labels. The file is
 * streamed from disk; turn times are relative to the start of the file.
 */
export async function transcribeFile(path: string, signal?: AbortSignal) {
	const form = new FormData();
	form.set('model_id', TRANSCRIPTION_MODEL);
	form.set('diarize', 'true');
	form.set('timestamps_granularity', 'word');
	form.set('tag_audio_events', 'false');
	form.set('file', await openAsBlob(path), basename(path));
	const response = await request('/v1/speech-to-text', {
		method: 'POST',
		body: form,
		signal,
		timeoutMs: 30 * 60_000
	});
	const result = transcriptSchema.parse(await response.json());
	const last = result.words.findLast((word) => word.type === 'word');
	return {
		transcript: result.text,
		audioDurationMs: Math.round((last?.end ?? 0) * 1000),
		turns: wordsToTurns(result.words)
	};
}
/** Fails before any state changes when transcription is not configured. */
export const requireTranscription = () => void apiKey();
/** Opens a realtime transcription socket for 24 kHz signed 16-bit mono PCM with VAD commits. */
export function openTranscriptionSocket() {
	const query = new URLSearchParams({
		model_id: REALTIME_TRANSCRIPTION_MODEL,
		audio_format: 'pcm_24000',
		commit_strategy: 'vad',
		include_timestamps: 'true',
		keepalive_interval_ms: '5000'
	});
	return new WebSocket(`wss://api.elevenlabs.io/v1/speech-to-text/realtime?${query}`, {
		headers: { 'xi-api-key': apiKey() },
		maxPayload: 4 * 1024 * 1024,
		handshakeTimeout: 10_000
	});
}
