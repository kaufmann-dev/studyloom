import { z } from 'zod';
import { ClientError, safeError } from './config';
import { MP3_FORMAT } from './audio';
import type { SpeechModel, Voice } from '../domain';
// ELEVENLABS_API_KEY stays in this module: never pass it to Muse, commands or the browser.
const BASE_URL = 'https://api.elevenlabs.io';
const CACHE_MS = 10 * 60_000;
const RETRY_DELAYS_MS = [2000, 6000];

function apiKey() {
	const key = process.env.ELEVENLABS_API_KEY;
	if (!key) throw new ClientError(503, 'Set ELEVENLABS_API_KEY to create audio summaries.');
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

export interface SpeechRequest {
	text: string;
	voiceId: string;
	modelId: string;
	/** Request IDs of the paragraphs voiced just before this one, oldest first. */
	previousRequestIds: string[];
	nextText?: string;
	signal?: AbortSignal;
}
/** Voices one paragraph as MP3, conditioned on the previous requests for smooth joins. */
export async function speak(input: SpeechRequest) {
	const response = await request(
		`/v1/text-to-speech/${encodeURIComponent(input.voiceId)}?output_format=${MP3_FORMAT}`,
		{
			method: 'POST',
			headers: { 'content-type': 'application/json', accept: 'audio/mpeg' },
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
