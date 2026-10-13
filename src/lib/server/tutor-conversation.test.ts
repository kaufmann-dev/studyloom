import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

type Listener = (params: Record<string, unknown>) => void;
const host = vi.hoisted(() => ({
	listeners: new Map<string, Set<Listener>>(),
	prompts: [] as string[],
	interrupts: 0,
	/** What the stand-in model does for each turn, in order. */
	script: [] as ('reply' | 'reminderThenReply' | 'tool')[]
}));
vi.mock('./muse', () => {
	const emit = (method: string, params: Record<string, unknown>) =>
		setTimeout(() => host.listeners.get(method)?.forEach((listener) => listener(params)), 1);
	let turns = 0;
	return {
		HOST_EXIT: 'exit',
		uuidv7: () => crypto.randomUUID(),
		museHost: {
			on(method: string, listener: Listener) {
				const set = host.listeners.get(method) ?? new Set();
				set.add(listener);
				host.listeners.set(method, set);
				return () => void set.delete(listener);
			},
			async call(method: string, params: Record<string, unknown>) {
				if (method === 'session/start') return { session: { sessionId: 's1' } };
				if (method === 'turn/interrupt') {
					host.interrupts++;
					return {};
				}
				if (method !== 'turn/start') throw new Error(method);
				const text = (params.input as { text: string }[])[0].text;
				host.prompts.push(text);
				const turnId = `t${++turns}`;
				const step = host.script.shift() ?? 'reply';
				const sessionId = 's1';
				if (step === 'tool') {
					emit('item/started', {
						sessionId,
						item: { itemId: 'x', kind: 'toolCall', tool: 'run_command' }
					});
					return { turnId };
				}
				if (step === 'reminderThenReply')
					emit('item/started', { sessionId, item: { itemId: 'r', kind: 'reminderChild' } });
				emit('item/started', { sessionId, item: { itemId: `m${turns}`, kind: 'agentMessage' } });
				emit('item/delta', {
					sessionId,
					itemId: `m${turns}`,
					delta: text.startsWith('PRIME') ? 'READY' : 'Feedback.'
				});
				emit('turn/completed', { sessionId, turnId, terminal: 'completed' });
				return { turnId };
			}
		}
	};
});
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

describe('Tutor conversation', () => {
	it("ignores Muse's own items but retries text-only after a tool call", async () => {
		vi.spyOn(console, 'error').mockImplementation(() => {});
		const tutor = new TutorConversation('run-1', 'model', async () => 'PRIME');
		host.script.push('reminderThenReply', 'tool');
		await tutor.warm();
		const reply = await tutor.ask('Answer: water moves.');
		expect(reply).toBe('Feedback.');
		expect(host.interrupts).toBe(1);
		// The retry starts a fresh session, primes it again and forbids tools from then on.
		expect(host.prompts).toEqual([
			'PRIME',
			'Answer: water moves.',
			expect.stringMatching(/^Answer in plain text only[\s\S]*PRIME$/),
			expect.stringMatching(/^Answer in plain text only[\s\S]*Answer: water moves\.$/)
		]);
		expect(console.error).toHaveBeenCalledWith('Study tutor turn used toolCall (run_command).');
		await tutor.close();
	});
});
