import { describe, expect, it, vi } from 'vitest';
import { PcmPlayer } from './pcm-player';

/** A clock-controlled stand-in for the audio context: sources end when the test says so. */
function context() {
	const started: { at: number; duration: number; source: { onended: (() => void) | null } }[] = [];
	const fake = {
		currentTime: 1,
		destination: {},
		createBuffer: (_channels: number, length: number, rate: number) => {
			const data = new Float32Array(length);
			return { duration: length / rate, getChannelData: () => data, data };
		},
		createBufferSource() {
			const source = {
				buffer: null as null | { duration: number },
				onended: null as (() => void) | null,
				connect: () => {},
				start: (at: number) => started.push({ at, duration: source.buffer!.duration, source }),
				stop: vi.fn()
			};
			return source;
		}
	};
	return { fake: fake as unknown as BaseAudioContext, started };
}
const pcm = (samples: number[]) => new Int16Array(samples).buffer;

describe('PCM player', () => {
	it('schedules frames back to back and reports a clip once it has played out', () => {
		const { fake, started } = context();
		const drained = vi.fn();
		const player = new PcmPlayer(fake, drained);
		player.begin('clip-1');
		player.push(pcm(new Array(2400).fill(16384)));
		player.push(pcm(new Array(4800).fill(-32768)));
		expect(started[0].at).toBeCloseTo(1.05);
		expect(started[1].at).toBeCloseTo(1.15);
		player.finish('clip-1');
		started[0].source.onended?.();
		expect(drained).not.toHaveBeenCalled();
		started[1].source.onended?.();
		expect(drained).toHaveBeenCalledExactlyOnceWith('clip-1');
	});
	it('reports an empty clip at once and ignores frames after stopping', () => {
		const { fake, started } = context();
		const drained = vi.fn();
		const player = new PcmPlayer(fake, drained);
		player.begin('empty');
		player.finish('empty');
		expect(drained).toHaveBeenCalledWith('empty');
		player.begin('skipped');
		player.push(pcm([1, 2]));
		player.stop();
		player.push(pcm([3, 4]));
		player.finish('skipped');
		expect(started).toHaveLength(1);
		expect(drained).toHaveBeenCalledTimes(1);
	});
});
