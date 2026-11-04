import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

type Step = 'reply' | 'fail' | 'failAfterDelta' | 'hang';
const fake = vi.hoisted(() => ({
	systems: [] as string[],
	prompts: [] as string[],
	closed: 0,
	/** What the stand-in model does for each turn, in order. */
	script: [] as Step[]
}));
vi.mock('./claude', () => ({
	ClaudeConversation: {
		async start({ system }: { system: string }) {
			fake.systems.push(system);
			return {
				async send(prompt: string, onDelta: (delta: string) => void) {
					fake.prompts.push(prompt);
					const step = fake.script.shift() ?? 'reply';
					if (step === 'fail') throw new Error('Claude could not complete this task.');
					if (step === 'hang') return new Promise<string>(() => {});
					onDelta('Feed');
					if (step === 'failAfterDelta') throw new Error('The tutor session closed.');
					onDelta('back.');
					return 'Feedback.';
				},
				close: () => void fake.closed++
			};
		}
	}
}));
const { TutorConversation } = await import('./tutor');

let data = '';
beforeAll(async () => {
	data = await mkdtemp(join(tmpdir(), 'studyloom-tutor-'));
	vi.stubEnv('DATA_DIR', data);
});
afterAll(async () => {
	vi.unstubAllEnvs();
	await rm(data, { recursive: true, force: true });
});
beforeEach(() => {
	fake.systems.length = 0;
	fake.prompts.length = 0;
	fake.closed = 0;
	fake.script.length = 0;
});

describe('Tutor conversation', () => {
	it('starts one session primed through its system prompt and streams each reply', async () => {
		let answers = 0;
		const tutor = new TutorConversation('run-1', 'opus', async () => `PRIME ${answers}`);
		await tutor.warm();
		const deltas: string[] = [];
		expect(await tutor.ask('Answer one.', (delta) => deltas.push(delta))).toBe('Feedback.');
		answers++;
		expect(await tutor.ask('Answer two.')).toBe('Feedback.');
		expect(deltas).toEqual(['Feed', 'back.']);
		expect(fake.systems).toEqual(['PRIME 0']);
		expect(fake.prompts).toEqual(['Answer one.', 'Answer two.']);
		await tutor.close();
		expect(fake.closed).toBe(1);
	});
	it('retries once in a fresh session, primed with the answers so far, when nothing was said', async () => {
		let answers = 0;
		const tutor = new TutorConversation('run-2', 'opus', async () => `PRIME ${answers}`);
		await tutor.warm();
		answers = 2;
		fake.script.push('fail');
		expect(await tutor.ask('Answer.')).toBe('Feedback.');
		expect(fake.systems).toEqual(['PRIME 0', 'PRIME 2']);
		expect(fake.prompts).toEqual(['Answer.', 'Answer.']);
		expect(fake.closed).toBe(1);
		fake.script.push('fail', 'fail');
		await expect(tutor.ask('Again.')).rejects.toThrow('could not complete');
		await tutor.close();
	});
	it('does not retry once part of the reply has been spoken', async () => {
		const tutor = new TutorConversation('run-3', 'opus', async () => 'PRIME');
		fake.script.push('failAfterDelta');
		const deltas: string[] = [];
		await expect(tutor.ask('Answer.', (delta) => deltas.push(delta))).rejects.toThrow('closed');
		expect(deltas).toEqual(['Feed']);
		expect(fake.prompts).toEqual(['Answer.']);
		await tutor.close();
	});
	it('gives up on a reply that takes too long and starts over on the next turn', async () => {
		vi.useFakeTimers();
		try {
			const tutor = new TutorConversation('run-4', 'opus', async () => 'PRIME');
			fake.script.push('hang', 'hang');
			const reply = tutor.ask('Answer.');
			const failed = expect(reply).rejects.toThrow('took too long');
			await vi.advanceTimersByTimeAsync(91_000);
			await failed;
			expect(fake.systems).toHaveLength(2);
			expect(await tutor.ask('Next.')).toBe('Feedback.');
			expect(fake.systems).toHaveLength(3);
			await tutor.close();
		} finally {
			vi.useRealTimers();
		}
	});
});
