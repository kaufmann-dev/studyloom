import { ClientError } from './config';
import { imageType } from './figures';

// GEMINI_API_KEY stays in this module: never pass it to Claude, commands or the browser.
// It pays for one thing: illustrations of lesson slides that no figure of the sources covers.

const ENDPOINT = 'https://generativelanguage.googleapis.com/v1beta/interactions';
/** Nano Banana 2.1; Google lists no "newest image model" alias, so bump this with new versions. */
const IMAGE_MODEL = 'gemini-nano-banana-2.1';
const API_REVISION = '2026-05-20';
const RETRY_DELAYS_MS = [2000, 6000];
const TIMEOUT_MS = 180_000;

export const illustrationsAvailable = () => Boolean(process.env.GEMINI_API_KEY);
function apiKey() {
	const key = process.env.GEMINI_API_KEY;
	if (!key) throw new ClientError(503, 'Set GEMINI_API_KEY to generate illustrations for lessons.');
	return key;
}
/** Refuses a request that needs illustrations when none can be generated. */
export function requireIllustrations() {
	apiKey();
}
/** A safe message for a failed request; never echoes the key or the response body. */
function failure(status: number) {
	if (status === 401 || status === 403) return 'Google rejected the API key. Check GEMINI_API_KEY.';
	if (status === 429)
		return 'The Gemini image quota is used up. Images made so far are kept; retry later.';
	return `Google rejected the image request (${status}).`;
}
function pause(ms: number, signal: AbortSignal) {
	return new Promise<void>((resolve, reject) => {
		signal.throwIfAborted();
		const timer = setTimeout(resolve, ms);
		signal.addEventListener(
			'abort',
			() => {
				clearTimeout(timer);
				reject(signal.reason);
			},
			{ once: true }
		);
	});
}
/** The first image in a response: a content block of type "image" holding base64 data. */
export function imageData(value: unknown): string | undefined {
	if (!value || typeof value !== 'object') return undefined;
	if (Array.isArray(value)) {
		for (const item of value) {
			const found = imageData(item);
			if (found) return found;
		}
		return undefined;
	}
	const block = value as Record<string, unknown>;
	if (block.type === 'image' && typeof block.data === 'string' && block.data) return block.data;
	return imageData(Object.values(block));
}

/**
 * Generates one 16:9 illustration from a prompt. Rate limits, server errors and network failures
 * are retried twice; the returned type comes from the image itself.
 */
export async function generateImage(prompt: string, signal: AbortSignal) {
	const key = apiKey();
	for (let attempt = 0; ; attempt++) {
		let response: Response;
		try {
			response = await fetch(ENDPOINT, {
				method: 'POST',
				headers: {
					'content-type': 'application/json',
					'x-goog-api-key': key,
					'api-revision': API_REVISION
				},
				body: JSON.stringify({
					model: IMAGE_MODEL,
					input: [{ type: 'text', text: prompt }],
					response_format: {
						type: 'image',
						mime_type: 'image/png',
						aspect_ratio: '16:9',
						image_size: '1K'
					}
				}),
				signal: AbortSignal.any([signal, AbortSignal.timeout(TIMEOUT_MS)])
			});
		} catch (cause) {
			if (signal.aborted) throw cause;
			if (attempt >= RETRY_DELAYS_MS.length)
				throw new Error('Could not reach Google to generate an image. Retry this job.', { cause });
			await pause(RETRY_DELAYS_MS[attempt], signal);
			continue;
		}
		if (!response.ok) {
			await response.body?.cancel();
			if ((response.status === 429 || response.status >= 500) && attempt < RETRY_DELAYS_MS.length) {
				await pause(RETRY_DELAYS_MS[attempt], signal);
				continue;
			}
			throw new Error(failure(response.status));
		}
		const encoded = imageData(await response.json().catch(() => undefined));
		const data = encoded ? Buffer.from(encoded, 'base64') : Buffer.alloc(0);
		const mimeType = imageType(data);
		if (!mimeType) throw new Error('Google returned no image for a slide. Retry this job.');
		return { data, mimeType };
	}
}
