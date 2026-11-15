import { afterEach, describe, expect, it, vi } from 'vitest';
import { generateImage, illustrationsAvailable, imageData, requireIllustrations } from './gemini';

const png = Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), Buffer.alloc(16)]);
const interaction = {
	id: 'i1',
	steps: [
		{ type: 'thought', content: [{ type: 'text', text: 'planning' }] },
		{
			type: 'model_output',
			content: [{ type: 'image', mime_type: 'image/png', data: png.toString('base64') }]
		}
	]
};

describe('Gemini illustrations', () => {
	afterEach(() => {
		vi.unstubAllGlobals();
		vi.unstubAllEnvs();
	});
	it('needs its key and keeps it out of error messages', async () => {
		vi.stubEnv('GEMINI_API_KEY', '');
		expect(illustrationsAvailable()).toBe(false);
		expect(() => requireIllustrations()).toThrow('GEMINI_API_KEY');
		vi.stubEnv('GEMINI_API_KEY', 'secret-key');
		vi.stubGlobal(
			'fetch',
			vi.fn(async () => new Response('{"error":"secret-key is invalid"}', { status: 403 }))
		);
		const failed = await generateImage('A cycle', AbortSignal.timeout(5000)).catch(
			(cause) => cause
		);
		expect(failed.message).toBe('Google rejected the API key. Check GEMINI_API_KEY.');
		expect(failed.message).not.toContain('secret-key');
	});
	it('asks for one 16:9 image and reads it from the model output', async () => {
		vi.stubEnv('GEMINI_API_KEY', 'secret-key');
		const fetchMock = vi.fn(async () => Response.json(interaction));
		vi.stubGlobal('fetch', fetchMock);
		const image = await generateImage('A cycle', AbortSignal.timeout(5000));
		expect(image).toEqual({ data: png, mimeType: 'image/png' });
		const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
		expect(url).toBe('https://generativelanguage.googleapis.com/v1beta/interactions');
		expect(url).not.toContain('secret-key');
		expect((init.headers as Record<string, string>)['x-goog-api-key']).toBe('secret-key');
		expect(JSON.parse(String(init.body))).toMatchObject({
			model: 'gemini-nano-banana-2.1',
			input: [{ type: 'text', text: 'A cycle' }],
			response_format: { type: 'image', aspect_ratio: '16:9' }
		});
	});
	it('rejects a response without an image', async () => {
		vi.stubEnv('GEMINI_API_KEY', 'secret-key');
		vi.stubGlobal(
			'fetch',
			vi.fn(async () => Response.json({ steps: [{ type: 'model_output', content: [] }] }))
		);
		await expect(generateImage('A cycle', AbortSignal.timeout(5000))).rejects.toThrow('no image');
		expect(imageData({ steps: [{ content: [{ type: 'text', data: 'x' }] }] })).toBeUndefined();
	});
});
