import { readFile, stat } from 'node:fs/promises';
import { z } from 'zod';
import { required } from './config';
import { TRANSCRIPTION_MODEL } from '../domain';
export function validateWav(data: Buffer) {
	if (
		data.length > 32 * 1024 * 1024 ||
		data.length < 44 ||
		data.toString('ascii', 0, 4) !== 'RIFF' ||
		data.toString('ascii', 8, 12) !== 'WAVE'
	)
		throw new Error('Supply a WAV file up to 32 MiB.');
	let format = false,
		audioBytes = 0,
		sampleRate = 0;
	for (let p = 12; p + 8 <= data.length;) {
		const size = data.readUInt32LE(p + 4);
		if (p + 8 + size > data.length) throw new Error('Truncated WAV file.');
		const name = data.toString('ascii', p, p + 4);
		if (name === 'fmt ') {
			if (
				size < 16 ||
				data.readUInt16LE(p + 8) !== 1 ||
				data.readUInt16LE(p + 10) !== 1 ||
				data.readUInt16LE(p + 22) !== 16
			)
				throw new Error('WAV must be mono, signed 16-bit PCM.');
			sampleRate = data.readUInt32LE(p + 12);
			format = sampleRate === 16000 || sampleRate === 24000;
		}
		if (name === 'data') audioBytes += size;
		p += 8 + size + (size % 2);
	}
	if (!format || !audioBytes || audioBytes % 2 || audioBytes / (sampleRate * 2) > 600)
		throw new Error('WAV must be mono 16-bit PCM at 16 or 24 kHz and at most ten minutes.');
}
const responseSchema = z.object({
	transcript: z.string(),
	audioDurationMs: z.number().nonnegative(),
	turns: z.array(
		z.object({
			turnId: z.number().int(),
			startMs: z.number().nonnegative(),
			endMs: z.number().nonnegative(),
			transcript: z.string(),
			speaker: z.string().optional()
		})
	)
});
export async function transcribeFile(path: string, signal?: AbortSignal) {
	if ((await stat(path)).size > 32 * 1024 * 1024)
		throw new Error('Split audio into WAV files at most ten minutes and 32 MiB each.');
	const bytes = await readFile(path);
	validateWav(bytes);
	const form = new FormData();
	form.set(
		'request',
		JSON.stringify({ model: TRANSCRIPTION_MODEL, audioEncoding: 'WAV', mode: 'DIARIZATION' })
	);
	form.set('audio', new Blob([new Uint8Array(bytes)], { type: 'audio/wav' }), 'audio.wav');
	const response = await fetch('https://api.meta.ai/v1/asr/transcribe', {
		method: 'POST',
		headers: {
			Authorization: 'Bearer ' + required('TRANSCRIPTION_API_KEY'),
			Accept: 'application/json'
		},
		body: form,
		signal: signal
			? AbortSignal.any([signal, AbortSignal.timeout(180000)])
			: AbortSignal.timeout(180000)
	});
	if (!response.ok)
		throw new Error(
			`Transcription API returned ${response.status}. Check the transcription key and API limits.`
		);
	return responseSchema.parse(await response.json());
}
