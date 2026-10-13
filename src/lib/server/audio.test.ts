import { describe, expect, it } from 'vitest';
import { concatMp3, firstFrameHeader, mp3DurationMs, silenceMp3, stripId3 } from './audio';

function id3(body: Buffer, footer = false) {
	const header = Buffer.from([0x49, 0x44, 0x33, 4, 0, footer ? 0x10 : 0, 0, 0, 0, 0]);
	// Syncsafe size: seven bits per byte.
	header[8] = body.length >> 7;
	header[9] = body.length & 0x7f;
	return Buffer.concat([header, body, footer ? Buffer.alloc(10) : Buffer.alloc(0)]);
}
const frames = (byte: number, length = 8) => Buffer.alloc(length, byte);

describe('MP3 assembly', () => {
	it('drops a leading ID3v2 tag, including its footer', () => {
		expect(stripId3(Buffer.concat([id3(Buffer.alloc(200)), frames(0xff)]))).toEqual(frames(0xff));
		expect(stripId3(Buffer.concat([id3(Buffer.alloc(3), true), frames(0xfb)]))).toEqual(
			frames(0xfb)
		);
	});
	it('leaves untagged audio and short buffers alone', () => {
		expect(stripId3(frames(0xff))).toEqual(frames(0xff));
		expect(stripId3(Buffer.from('ID3'))).toEqual(Buffer.from('ID3'));
	});
	it('joins parts in order without their tags', () => {
		const joined = concatMp3([
			Buffer.concat([id3(Buffer.alloc(5)), frames(1)]),
			frames(2),
			Buffer.concat([id3(Buffer.alloc(1)), frames(3)])
		]);
		expect(joined).toEqual(Buffer.concat([frames(1), frames(2), frames(3)]));
	});
	it('derives the duration from the constant 128 kbps bitrate', () => {
		expect(mp3DurationMs(16_000)).toBe(1000);
		expect(mp3DurationMs(0)).toBe(0);
	});
});

describe('MP3 silence', () => {
	// MPEG-1 Layer III, no CRC, 128 kbps, 44.1 kHz, mono.
	const header = Buffer.from([0xff, 0xfb, 0x90, 0xc4]);
	it('reads the first frame header after a tag and rejects other formats', () => {
		const part = Buffer.concat([id3(Buffer.alloc(4)), header, Buffer.alloc(413)]);
		expect(firstFrameHeader(part)).toEqual(header);
		expect(() => firstFrameHeader(Buffer.from([0xff, 0xfb, 0xb0, 0xc4]))).toThrow(
			/cannot be joined/
		);
		expect(() => firstFrameHeader(Buffer.alloc(20))).toThrow(/cannot be joined/);
	});
	it('writes padded zero frames in the stream format with an exact duration', () => {
		const silence = silenceMp3(4000, Buffer.from([0xff, 0xfa, 0x92, 0xc4]));
		const frames: number[] = [];
		for (let at = 0; at < silence.length;) {
			expect(silence.subarray(at, at + 4)).toEqual(
				Buffer.from([0xff, 0xfb, silence[at + 2], 0xc4])
			);
			const size = 417 + ((silence[at + 2] >> 1) & 1);
			expect(silence[at + 2] & 0xfd).toBe(0x90);
			expect(silence.subarray(at + 4, at + size).every((byte) => byte === 0)).toBe(true);
			frames.push(size);
			at += size;
		}
		expect(frames).toHaveLength(153);
		expect(new Set(frames)).toEqual(new Set([417, 418]));
		expect(Math.abs(mp3DurationMs(silence.length) - 4000)).toBeLessThan(15);
		expect(silenceMp3(0, header)).toHaveLength(0);
	});
});
