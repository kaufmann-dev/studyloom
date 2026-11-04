import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const KEY = 'sk_test_secret_key';
const fetchMock = vi.fn<typeof fetch>();
const json = (body: unknown, status = 200) =>
	new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
// Each test gets a fresh module so the voice and model caches start empty.
const load = () => import('./elevenlabs');

beforeEach(() => {
	vi.resetModules();
	vi.stubGlobal('fetch', fetchMock);
	vi.stubEnv('ELEVENLABS_API_KEY', KEY);
	fetchMock.mockReset();
});
afterEach(() => {
	vi.useRealTimers();
	vi.unstubAllGlobals();
	vi.unstubAllEnvs();
});

describe('ElevenLabs speech', () => {
	it('voices a paragraph with the chosen model, stitched to at most three earlier requests', async () => {
		fetchMock.mockResolvedValueOnce(
			new Response(new Uint8Array([1, 2, 3]), { headers: { 'request-id': 'req-5' } })
		);
		const { speak } = await load();
		const result = await speak({
			text: 'Hello there.',
			voiceId: 'voice1',
			modelId: 'eleven_v4_turbo',
			previousRequestIds: ['req-1', 'req-2', 'req-3', 'req-4'],
			nextText: 'Next paragraph.'
		});
		expect(result).toEqual({ audio: Buffer.from([1, 2, 3]), requestId: 'req-5' });
		const [url, init] = fetchMock.mock.calls[0];
		expect(url).toBe(
			'https://api.elevenlabs.io/v1/text-to-speech/voice1?output_format=mp3_44100_128'
		);
		expect(init?.method).toBe('POST');
		expect(init?.headers).toMatchObject({ 'xi-api-key': KEY });
		expect(JSON.parse(String(init?.body))).toEqual({
			text: 'Hello there.',
			model_id: 'eleven_v4_turbo',
			previous_request_ids: ['req-2', 'req-3', 'req-4'],
			next_text: 'Next paragraph.'
		});
	});
	it('asks for raw 24 kHz PCM when requested', async () => {
		fetchMock.mockResolvedValueOnce(new Response(new Uint8Array([0, 1])));
		const { speak } = await load();
		await speak({
			text: 'Hi.',
			voiceId: 'v',
			modelId: 'm',
			format: 'pcm_24000',
			previousRequestIds: []
		});
		const [url, init] = fetchMock.mock.calls[0];
		expect(url).toBe('https://api.elevenlabs.io/v1/text-to-speech/v?output_format=pcm_24000');
		expect(init?.headers).toMatchObject({ accept: 'application/octet-stream' });
	});
	it('reports used-up credits and a rejected key without echoing the key', async () => {
		const { speak } = await load();
		const request = {
			text: 'Hi.',
			voiceId: 'voice1',
			modelId: 'm',
			previousRequestIds: []
		};
		fetchMock.mockResolvedValueOnce(
			json({ detail: { status: 'quota_exceeded', message: `key ${KEY} is out` } }, 401)
		);
		await expect(speak(request)).rejects.toThrow(/credits are used up/);
		fetchMock.mockResolvedValueOnce(json({ detail: { message: KEY } }, 401));
		const message = await speak(request).then(
			() => '',
			(cause: Error) => cause.message
		);
		expect(message).toMatch(/Check ELEVENLABS_API_KEY/);
		expect(message).not.toContain(KEY);
	});
	it('retries rate limits before succeeding', async () => {
		vi.useFakeTimers();
		fetchMock
			.mockResolvedValueOnce(json({}, 429))
			.mockResolvedValueOnce(new Response(new Uint8Array([9]), { headers: { 'request-id': 'r' } }));
		const { speak } = await load();
		const pending = speak({ text: 'Hi.', voiceId: 'v', modelId: 'm', previousRequestIds: [] });
		await vi.advanceTimersByTimeAsync(2000);
		await expect(pending).resolves.toMatchObject({ requestId: 'r' });
		expect(fetchMock).toHaveBeenCalledTimes(2);
	});
	it('asks for the key when it is not configured', async () => {
		vi.stubEnv('ELEVENLABS_API_KEY', '');
		const { speechCatalog } = await load();
		await expect(speechCatalog()).rejects.toMatchObject({
			status: 503,
			message:
				'Set ELEVENLABS_API_KEY to transcribe audio and to create audio summaries and study sessions.'
		});
		expect(fetchMock).not.toHaveBeenCalled();
	});
});

describe('ElevenLabs catalog', () => {
	it('lists voices and text-to-speech models in ElevenLabs order', async () => {
		fetchMock.mockImplementation(async (url) =>
			String(url).includes('/v2/voices')
				? json({
						voices: [
							{
								voice_id: 'v1',
								name: 'Rachel',
								labels: { gender: 'female', accent: 'american', use_case: 'narrative_story' }
							},
							{ voice_id: 'v2', name: 'Plain', description: 'A calm voice.' }
						]
					})
				: json([
						{
							model_id: 'eleven_v4_turbo',
							name: 'Eleven v4 Turbo',
							can_do_text_to_speech: true,
							maximum_text_length_per_request: 10000,
							model_rates: { character_cost_multiplier: 0.5 }
						},
						{ model_id: 'sts', name: 'Speech to speech', can_do_text_to_speech: false },
						{
							model_id: 'alpha',
							name: 'Alpha',
							can_do_text_to_speech: true,
							requires_alpha_access: true
						},
						{ model_id: 'eleven_v4', name: 'Eleven v4', can_do_text_to_speech: true }
					])
		);
		const { speechCatalog } = await load();
		expect(await speechCatalog()).toEqual({
			voices: [
				{ voiceId: 'v1', name: 'Rachel', description: 'female, american, narrative story' },
				{ voiceId: 'v2', name: 'Plain', description: 'A calm voice.' }
			],
			models: [
				{
					modelId: 'eleven_v4_turbo',
					name: 'Eleven v4 Turbo',
					costMultiplier: 0.5,
					maxCharacters: 10000
				},
				{ modelId: 'eleven_v4', name: 'Eleven v4', costMultiplier: 1, maxCharacters: 10000 }
			]
		});
		// Cached: a second call does not ask ElevenLabs again.
		await speechCatalog();
		expect(fetchMock).toHaveBeenCalledTimes(2);
	});
	it('turns an unexpected response into a safe 503', async () => {
		fetchMock.mockImplementation(async () => json({ unexpected: true }));
		const { speechCatalog } = await load();
		await expect(speechCatalog()).rejects.toMatchObject({
			status: 503,
			message:
				'Could not load ElevenLabs voices and models. ElevenLabs returned an unexpected response.'
		});
	});
});

describe('ElevenLabs transcription', () => {
	const word = (text: string, start: number, end: number, speaker = 'speaker_0') => ({
		text,
		start,
		end,
		type: 'word',
		speaker_id: speaker
	});
	const space = { text: ' ', type: 'spacing' };
	it('groups words into turns by speaker, pause and length', async () => {
		const { wordsToTurns } = await load();
		const long = Array.from({ length: 70 }, (_, i) => [word(`w${i}`, 10 + i, 10.5 + i), space]);
		const turns = wordsToTurns([
			word('Water', 0, 0.4),
			space,
			word('moves.', 0.5, 0.9),
			space,
			{ text: '(laughter)', start: 1, end: 1.5, type: 'audio_event' },
			word('Why?', 1.2, 1.6, 'speaker_1'),
			space,
			word('Because', 4, 4.4, 'speaker_1'),
			...long.flat()
		]);
		expect(turns.slice(0, 3)).toEqual([
			{ turnId: 0, startMs: 0, endMs: 900, transcript: 'Water moves.', speaker: 'Speaker 1' },
			{ turnId: 1, startMs: 1200, endMs: 1600, transcript: 'Why?', speaker: 'Speaker 2' },
			{ turnId: 2, startMs: 4000, endMs: 4400, transcript: 'Because', speaker: 'Speaker 2' }
		]);
		// Seventy words a second apart: the word starting a minute into the turn opens the next one.
		expect(turns.slice(3).map((turn) => turn.transcript.split(' ').length)).toEqual([60, 10]);
		expect(turns.map((turn) => turn.turnId)).toEqual([0, 1, 2, 3, 4]);
	});
	it('uploads the file with diarization and word timestamps', async () => {
		const dir = await mkdtemp(join(tmpdir(), 'studyloom-stt-'));
		try {
			const path = join(dir, 'lecture.flac');
			await writeFile(path, Buffer.from('audio'));
			fetchMock.mockResolvedValueOnce(
				json({
					text: 'Water moves.',
					words: [word('Water', 0, 0.4), space, word('moves.', 0.5, 0.9)]
				})
			);
			const { transcribeFile } = await load();
			expect(await transcribeFile(path)).toEqual({
				transcript: 'Water moves.',
				audioDurationMs: 900,
				turns: [
					{ turnId: 0, startMs: 0, endMs: 900, transcript: 'Water moves.', speaker: 'Speaker 1' }
				]
			});
			const [url, init] = fetchMock.mock.calls[0];
			expect(url).toBe('https://api.elevenlabs.io/v1/speech-to-text');
			expect(init?.headers).toMatchObject({ 'xi-api-key': KEY });
			const form = init?.body as FormData;
			expect(form.get('model_id')).toBe('scribe_v2');
			expect(form.get('diarize')).toBe('true');
			expect(form.get('timestamps_granularity')).toBe('word');
			expect((form.get('file') as File).name).toBe('lecture.flac');
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});
});
