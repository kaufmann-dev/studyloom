import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import { speak, type SpeechFormat } from './elevenlabs';

/** Writes a file whole or not at all, so an interrupted job never leaves a torn file. */
export async function writeAtomic(path: string, data: string | Buffer) {
	const temporary = `${path}.${randomUUID()}.tmp`;
	await writeFile(temporary, data, { mode: 0o600 });
	await rename(temporary, path);
}
const isMissingFile = (error: unknown) =>
	error instanceof Error && 'code' in error && error.code === 'ENOENT';

/** The script a job voices and the ElevenLabs request ID of every clip already saved. */
export interface Manifest<T> {
	script: T;
	requestIds: Record<string, string>;
}
const manifestSchema = z.object({
	script: z.unknown(),
	requestIds: z.record(z.string(), z.string())
});
export const manifestPath = (directory: string) => join(directory, 'manifest.json');
export async function readManifest<S extends z.ZodType>(
	directory: string,
	script: S
): Promise<Manifest<z.infer<S>> | undefined> {
	try {
		const manifest = manifestSchema.parse(
			JSON.parse(await readFile(manifestPath(directory), 'utf8'))
		);
		return { script: script.parse(manifest.script), requestIds: manifest.requestIds };
	} catch (error) {
		if (isMissingFile(error)) return undefined;
		throw error;
	}
}
export const writeManifest = (directory: string, manifest: Manifest<unknown>) =>
	writeAtomic(manifestPath(directory), JSON.stringify(manifest));

export interface Clip {
	/** Stable file name for the clip, unique within the job. */
	key: string;
	voiceId: string;
	text: string;
}
export interface VoicingOptions {
	modelId: string;
	format: SpeechFormat;
	signal: AbortSignal;
	progress: (done: number, total: number) => void;
}
const extension = (format: SpeechFormat) => (format === 'pcm_24000' ? 'pcm' : 'mp3');
export const clipPath = (directory: string, key: string, format: SpeechFormat) =>
	join(directory, 'parts', `${key}.${extension(format)}`);

/**
 * Voices every clip in order and returns the audio. Saved clips are reused, so a retry never
 * pays twice. Each request is conditioned on the last clips in the same voice, and on the next
 * clip's text when that voice speaks again straight away.
 */
export async function voiceClips(
	directory: string,
	manifest: Manifest<unknown>,
	clips: Clip[],
	options: VoicingOptions
) {
	await mkdir(join(directory, 'parts'), { recursive: true, mode: 0o700 });
	const audio: Buffer[] = [];
	for (const [i, clip] of clips.entries()) {
		options.signal.throwIfAborted();
		const path = clipPath(directory, clip.key, options.format);
		if (manifest.requestIds[clip.key] !== undefined) {
			const saved = await readFile(path).catch((error) => {
				if (isMissingFile(error)) return undefined;
				throw error;
			});
			if (saved) {
				audio.push(saved);
				continue;
			}
		}
		options.progress(i, clips.length);
		const previousRequestIds = clips
			.slice(0, i)
			.filter((earlier) => earlier.voiceId === clip.voiceId)
			.map((earlier) => manifest.requestIds[earlier.key])
			.filter(Boolean)
			.slice(-3);
		const next = clips[i + 1];
		const result = await speak({
			text: clip.text,
			voiceId: clip.voiceId,
			modelId: options.modelId,
			format: options.format,
			previousRequestIds,
			nextText: next?.voiceId === clip.voiceId ? next.text : undefined,
			signal: options.signal
		});
		await writeAtomic(path, result.audio);
		manifest.requestIds = { ...manifest.requestIds, [clip.key]: result.requestId };
		await writeManifest(directory, manifest);
		audio.push(result.audio);
	}
	return audio;
}
