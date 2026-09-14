import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { describe, expect, it } from 'vitest';

interface Worklet {
	port: { onmessage: (event: { data: { type: string } }) => void };
	process: (inputs: Float32Array[][]) => boolean;
}

function worklet(sampleRate: number) {
	const messages: Array<{ type: string; pcm?: ArrayBuffer }> = [];
	let Processor: new () => Worklet;
	runInNewContext(readFileSync('static/audio-worklet.js', 'utf8'), {
		sampleRate,
		AudioWorkletProcessor: class {
			port = {
				postMessage: (message: { type: string; pcm?: ArrayBuffer }) => messages.push(message)
			};
		},
		registerProcessor: (_name: string, processor: new () => Worklet) => {
			Processor = processor;
		}
	});
	const processor = new Processor!();
	const command = (type: string) => processor.port.onmessage({ data: { type } });
	const feed = (samples: number, channels = [0.5]) => {
		for (let i = 0; i < samples; i += 128)
			processor.process([
				channels.map((value) => new Float32Array(Math.min(128, samples - i)).fill(value))
			]);
	};
	const frames = () =>
		messages
			.filter((message) => message.type === 'pcm')
			.map((message) => new DataView(message.pcm!));
	return { messages, command, feed, frames };
}

describe('browser PCM worklet', () => {
	it.each([24000, 44100, 48000, 96000])(
		'produces exactly 24,000 PCM samples per second from %i Hz',
		(rate) => {
			const recorder = worklet(rate);
			recorder.command('start');
			recorder.feed(rate * 3);
			recorder.command('pause');
			expect(recorder.frames().map((frame) => frame.byteLength)).toEqual([48000, 48000, 48000]);
			expect(recorder.frames()[0].getInt16(0, true)).toBe(16384);
		}
	);

	it('flushes the partial final frame before confirming pause, and omits paused audio', () => {
		const recorder = worklet(48000);
		recorder.feed(48000);
		expect(recorder.frames()).toHaveLength(0);
		recorder.command('start');
		recorder.feed(12000);
		recorder.command('pause');
		recorder.feed(48000);
		expect(recorder.messages.map((message) => message.type)).toEqual(['pcm', 'flushed']);
		expect(recorder.frames()[0].byteLength).toBe(12000);
		recorder.command('start');
		recorder.feed(48000);
		recorder.command('pause');
		expect(recorder.frames().map((frame) => frame.byteLength)).toEqual([12000, 48000]);
	});

	it('downmixes stereo and clamps signed little-endian PCM without wrapping', () => {
		const recorder = worklet(24000);
		recorder.command('start');
		recorder.feed(1, [1, -1]);
		recorder.feed(1, [2, 2]);
		recorder.feed(1, [-2, -2]);
		recorder.command('pause');
		const frame = recorder.frames()[0];
		expect([0, 2, 4].map((offset) => frame.getInt16(offset, true))).toEqual([0, 32767, -32768]);
	});
});
