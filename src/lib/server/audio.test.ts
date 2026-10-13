import { describe, expect, it } from 'vitest';
import { concatMp3, mp3DurationMs, stripId3 } from './audio';

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
