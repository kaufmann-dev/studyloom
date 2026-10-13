import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import { dataDir } from './config';
import { idSchema } from '../domain';
/** Every speech request asks for constant-bitrate MP3 at this rate. */
export const MP3_FORMAT = 'mp3_44100_128';
const MP3_KBPS = 128;
export const audioDir = (id: string) => join(dataDir(), 'audio', idSchema.parse(id));
export const audioFile = (id: string) => join(audioDir(id), 'summary.mp3');
export const removeAudioFiles = (id: string) => rm(audioDir(id), { recursive: true, force: true });
/** Drops a leading ID3v2 tag so tags never end up in the middle of a joined file. */
export function stripId3(data: Buffer) {
	if (data.length < 10 || data.toString('latin1', 0, 3) !== 'ID3') return data;
	// The tag size is "syncsafe": four bytes carrying seven bits each.
	const size = [6, 7, 8, 9].reduce((total, i) => (total << 7) | (data[i] & 0x7f), 0);
	const footer = data[5] & 0x10 ? 10 : 0;
	return data.subarray(Math.min(data.length, 10 + size + footer));
}
/** Constant-bitrate MP3 frames play back to back, so parts join byte for byte. */
export const concatMp3 = (parts: Buffer[]) => Buffer.concat(parts.map(stripId3));
export const mp3DurationMs = (bytes: number) => Math.round((bytes * 8) / MP3_KBPS);
