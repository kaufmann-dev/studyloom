import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import { speak } from './elevenlabs';
import { clipPath, readManifest, voiceClips, writeManifest, type Manifest } from './voicing';

vi.mock('./elevenlabs', () => ({ speak: vi.fn() }));

let directory = '';
beforeEach(async () => {
	directory = await mkdtemp(join(tmpdir(), 'studyloom-voicing-'));
	vi.mocked(speak).mockReset();
	vi.mocked(speak).mockImplementation(async ({ text }) => ({
		audio: Buffer.from(text),
		requestId: `req-${text}`
	}));
});
afterEach(() => rm(directory, { recursive: true, force: true }));

const options = (progress = vi.fn()) => ({
	modelId: 'model',
	format: 'mp3_44100_128' as const,
	signal: new AbortController().signal,
	progress
});
const clips = [
	{ key: '000', voiceId: 'tutor', text: 'a' },
	{ key: '001', voiceId: 'tutor', text: 'b' },
	{ key: '002', voiceId: 'learner', text: 'c' },
	{ key: '003', voiceId: 'tutor', text: 'd' },
	{ key: '004', voiceId: 'learner', text: 'e' }
];

describe('Voicing clips', () => {
	it('stitches each clip to earlier clips in the same voice only', async () => {
		const manifest: Manifest<unknown> = { script: {}, requestIds: {} };
		const audio = await voiceClips(directory, manifest, clips, options());
		expect(audio.map(String)).toEqual(['a', 'b', 'c', 'd', 'e']);
		const calls = vi.mocked(speak).mock.calls.map(([input]) => input);
		expect(calls.map((c) => c.previousRequestIds)).toEqual([
			[],
			['req-a'],
			[],
			['req-a', 'req-b'],
			['req-c']
		]);
		// The next text only helps when the same voice continues.
		expect(calls.map((c) => c.nextText)).toEqual(['b', undefined, undefined, undefined, undefined]);
		expect(String(await readFile(clipPath(directory, '003', 'mp3_44100_128')))).toBe('d');
	});
	it('reuses saved clips after an interruption and never voices them twice', async () => {
		const schema = z.object({ title: z.string() });
		await writeManifest(directory, { script: { title: 'T' }, requestIds: {} });
		const first = await readManifest(directory, schema);
		vi.mocked(speak).mockImplementationOnce(async () => ({
			audio: Buffer.from('a'),
			requestId: 'r0'
		}));
		vi.mocked(speak).mockRejectedValueOnce(new Error('credits'));
		await expect(voiceClips(directory, first!, clips, options())).rejects.toThrow('credits');
		const resumed = await readManifest(directory, schema);
		expect(resumed).toEqual({ script: { title: 'T' }, requestIds: { '000': 'r0' } });
		vi.mocked(speak).mockClear();
		const progress = vi.fn();
		const audio = await voiceClips(directory, resumed!, clips, options(progress));
		expect(audio.map(String)).toEqual(['a', 'b', 'c', 'd', 'e']);
		expect(vi.mocked(speak)).toHaveBeenCalledTimes(4);
		expect(vi.mocked(speak).mock.calls[0][0].previousRequestIds).toEqual(['r0']);
		expect(progress).toHaveBeenNthCalledWith(1, 1, 5);
	});
	it('reports a missing manifest as none', async () => {
		expect(await readManifest(directory, z.unknown())).toBeUndefined();
	});
});
