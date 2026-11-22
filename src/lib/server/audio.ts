import { readdir, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { dataDir } from './config';
import { idSchema } from '../domain';
import { writeAtomic } from './voicing';
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
const BITRATES = [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320];
const SAMPLE_RATES = [44_100, 48_000, 32_000];
/** The byte length of the MPEG-1 Layer III frame starting at `i`, or 0 when none starts there. */
function frameLength(data: Buffer, i: number) {
	if (i + 4 > data.length || data[i] !== 0xff || (data[i + 1] & 0xfe) !== 0xfa) return 0;
	const kbps = BITRATES[data[i + 2] >> 4];
	const rate = SAMPLE_RATES[(data[i + 2] >> 2) & 3];
	if (!kbps || !rate) return 0;
	return Math.floor((144_000 * kbps) / rate) + ((data[i + 2] >> 1) & 1);
}
/** Whether a frame is an encoder's Xing, Info or VBRI header rather than audio. */
function isHeaderFrame(frame: Buffer) {
	const crc = frame[1] & 1 ? 0 : 2;
	const xing = 4 + crc + (frame[3] >> 6 === 3 ? 17 : 32);
	const tag = (at: number) => frame.toString('latin1', at, at + 4);
	return tag(xing) === 'Xing' || tag(xing) === 'Info' || tag(36) === 'VBRI';
}
/**
 * Drops Xing, Info and VBRI frames. Each describes only the part it came from, and Safari takes
 * the first one as the length of a whole joined file; without them the length follows from the
 * constant bitrate. Bytes after anything that is not a frame are kept unchanged.
 */
export function stripHeaderFrames(data: Buffer) {
	const kept: Buffer[] = [];
	let start = 0;
	let i = 0;
	for (let length = frameLength(data, 0); length; length = frameLength(data, i)) {
		const frame = data.subarray(i, i + length);
		if (isHeaderFrame(frame)) {
			kept.push(data.subarray(start, i));
			start = i + length;
		}
		i += length;
	}
	if (!kept.length) return data;
	kept.push(data.subarray(start));
	return Buffer.concat(kept);
}
/** Constant-bitrate MP3 frames play back to back, so parts join byte for byte. */
export const concatMp3 = (parts: Buffer[]) => stripHeaderFrames(Buffer.concat(parts.map(stripId3)));
/**
 * Removes the header frames that summaries joined before `stripHeaderFrames` existed still hold,
 * so iOS shows their whole length. Files without one are left untouched.
 */
export async function repairAudioSummaries() {
	const ids = await readdir(join(dataDir(), 'audio')).catch(() => []);
	for (const id of ids) {
		if (!idSchema.safeParse(id).success) continue;
		const file = audioFile(id);
		const data = await readFile(file).catch(() => undefined);
		if (!data) continue;
		const repaired = stripHeaderFrames(data);
		if (repaired !== data) await writeAtomic(file, repaired);
	}
}
export const mp3DurationMs = (bytes: number) => Math.round((bytes * 8) / MP3_KBPS);
/** Average bytes per MPEG-1 Layer III frame at 128 kbps and 44.1 kHz (1152 samples). */
const FRAME_BYTES = (144 * MP3_KBPS * 1000) / 44_100;
const FRAME_MS = (1152 / 44_100) * 1000;
/** The header of the first frame, checked to be the constant-bitrate format every part uses. */
export function firstFrameHeader(part: Buffer) {
	const data = stripId3(part);
	for (let i = 0; i + 4 <= data.length; i++) {
		if (data[i] !== 0xff || (data[i + 1] & 0xe0) !== 0xe0) continue;
		const header = data.subarray(i, i + 4);
		// MPEG-1 Layer III, bitrate index 9 (128 kbps), sample rate index 0 (44.1 kHz).
		if ((header[1] & 0xfe) === 0xfa && header[2] >> 4 === 9 && ((header[2] >> 2) & 3) === 0)
			return Buffer.from(header);
		break;
	}
	throw new Error('ElevenLabs returned audio that cannot be joined.');
}
/**
 * Digital silence in the stream's own format: frames whose side information and main data are
 * all zero decode to silence without depending on neighbouring frames. Padding alternates like
 * an encoder's, so the duration stays exact at the constant bitrate.
 */
export function silenceMp3(ms: number, header: Buffer) {
	const count = Math.round(ms / FRAME_MS);
	const frames: Buffer[] = [];
	for (let k = 0; k < count; k++) {
		const size = Math.floor((k + 1) * FRAME_BYTES) - Math.floor(k * FRAME_BYTES);
		const frame = Buffer.alloc(size);
		frame[0] = 0xff;
		frame[1] = 0xfb; // No CRC, so the body directly follows the header.
		frame[2] = 0x90 | (size > Math.floor(FRAME_BYTES) ? 0x02 : 0);
		frame[3] = header[3];
		frames.push(frame);
	}
	return Buffer.concat(frames);
}
