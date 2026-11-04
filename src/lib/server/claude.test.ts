import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import type { Options, SDKMessage } from '@anthropic-ai/claude-agent-sdk';

const sdk = vi.hoisted(() => ({
	calls: [] as { prompt: unknown; options: Options }[],
	messages: [] as SDKMessage[]
}));
vi.mock('@anthropic-ai/claude-agent-sdk', async (importOriginal) => ({
	...(await importOriginal<typeof import('@anthropic-ai/claude-agent-sdk')>()),
	query: ({ prompt, options }: { prompt: unknown; options: Options }) => {
		sdk.calls.push({ prompt, options });
		const messages = [...sdk.messages];
		return {
			async *[Symbol.asyncIterator]() {
				yield* messages;
			},
			supportedModels: async () => [
				{
					value: 'default',
					displayName: 'Default (recommended)',
					description: 'Use the default model (currently Opus 5.5) · $4/$20 per Mtok',
					supportedEffortLevels: ['low', 'high']
				},
				{
					value: 'haiku',
					displayName: 'Haiku',
					description: 'Haiku 5.5 · Fastest for quick answers · $0.10/$0.50 per Mtok'
				}
			],
			close: () => {}
		};
	}
}));
const {
	boundedOutput,
	claudeRun,
	claudeStatus,
	describeModel,
	gradingModel,
	runFailure,
	validateModel
} = await import('./claude');

let data = '';
beforeAll(async () => {
	data = await mkdtemp(join(tmpdir(), 'studyloom-claude-'));
	vi.stubEnv('DATA_DIR', data);
});
afterAll(async () => {
	vi.unstubAllEnvs();
	await rm(data, { recursive: true, force: true });
});
beforeEach(() => {
	sdk.calls.length = 0;
	sdk.messages.length = 0;
	vi.stubEnv('CLAUDE_CODE_OAUTH_TOKEN', 'sk-ant-oat01-test');
});

/** The run's own query; the model list may have needed one before it. */
const runCall = () => sdk.calls.find((call) => call.options.systemPrompt)!;
const success = (extra: object = {}) =>
	({ type: 'result', subtype: 'success', is_error: false, result: 'Done.', ...extra }) as never;

describe('Claude models', () => {
	it('labels the live list readably and leaves out API prices', () => {
		expect(
			describeModel({
				value: 'default',
				displayName: 'Default (recommended)',
				description: 'Use the default model (currently Opus 5.5) · $4/$20 per Mtok'
			})
		).toEqual({
			modelId: 'default',
			displayLabel: 'Default (recommended) · Opus 5.5',
			description: ''
		});
		expect(
			describeModel({
				value: 'opus',
				displayName: 'Opus',
				description: 'Opus 5.5 · Best for everyday, complex tasks · $4/$20 per Mtok'
			})
		).toEqual({
			modelId: 'opus',
			displayLabel: 'Opus 5.5',
			description: 'Best for everyday, complex tasks'
		});
	});
	it('accepts offered models and falls back to the default for retired ones', async () => {
		expect((await claudeStatus()).models.map((model) => model.modelId)).toEqual([
			'default',
			'haiku'
		]);
		await expect(validateModel('haiku')).resolves.toBeUndefined();
		await expect(validateModel('muse-spark-1.3-contributor')).rejects.toMatchObject({
			status: 409
		});
		expect(await gradingModel('haiku')).toBe('haiku');
		expect(await gradingModel('muse-spark-1.3-contributor')).toBe('default');
	});
	it('reports a missing token instead of failing later', async () => {
		vi.stubEnv('CLAUDE_CODE_OAUTH_TOKEN', '');
		expect(await claudeStatus()).toEqual({ configured: false, models: [] });
		await expect(validateModel('default')).rejects.toMatchObject({
			status: 409,
			message: 'Claude is not set up. See Settings.'
		});
	});
});

describe('Claude runs', () => {
	const run = (overrides: Partial<Parameters<typeof claudeRun>[0]> = {}) =>
		claudeRun({
			workspace: join(data, 'jobs', 'job-1'),
			modelId: 'default',
			system: 'You are Studyloom.',
			prompt: 'Summarise sources.json.',
			signal: AbortSignal.timeout(5000),
			progress: () => {},
			...overrides
		});
	it('runs without built-in tools, settings or prompts, and returns the structured result', async () => {
		const progress = vi.fn();
		sdk.messages.push(
			{
				type: 'assistant',
				message: {
					content: [
						{ type: 'text', text: 'Reading the sources.' },
						{ type: 'tool_use', id: 't1', name: 'mcp__studyloom__run_command', input: {} }
					]
				}
			} as never,
			success({ structured_output: { title: 'Summary' } })
		);
		const result = await run({
			modelId: 'haiku',
			schema: z.object({ title: z.string() }),
			progress
		});
		expect(result).toMatchObject({ text: 'Done.', structured: { title: 'Summary' } });
		expect(progress.mock.calls).toEqual([['Reading the sources.'], ['Running run_command']]);
		const { options } = runCall();
		expect(options).toMatchObject({
			model: 'haiku',
			systemPrompt: 'You are Studyloom.',
			tools: [],
			allowedTools: ['mcp__studyloom__*', 'StructuredOutput'],
			settingSources: [],
			strictMcpConfig: true,
			persistSession: false,
			permissionMode: 'dontAsk',
			cwd: join(data, 'jobs', 'job-1', 'files'),
			outputFormat: { type: 'json_schema' }
		});
		expect(Object.keys(options.mcpServers ?? {})).toEqual(['studyloom']);
		expect(options.env?.CLAUDE_CODE_OAUTH_TOKEN).toBe('sk-ant-oat01-test');
		// The prompt goes in as written: no slash commands or file mentions are expanded.
		const sent = [];
		for await (const message of runCall().prompt as AsyncIterable<unknown>) sent.push(message);
		expect(sent).toEqual([
			{
				type: 'user',
				message: { role: 'user', content: 'Summarise sources.json.' },
				parent_tool_use_id: null,
				client_composed: true
			}
		]);
	});
	it('leaves the model to Claude Code for the default', async () => {
		sdk.messages.push(success());
		await run();
		expect(runCall().options).not.toHaveProperty('model');
		expect(runCall().options).not.toHaveProperty('outputFormat');
		expect(runCall().options.allowedTools).toEqual(['mcp__studyloom__*']);
	});
	it('explains usage limits and other failures', async () => {
		sdk.messages.push(
			{
				type: 'rate_limit_event',
				rate_limit_info: { status: 'rejected', resetsAt: 1_800_000_000 }
			} as never,
			success({ is_error: true, result: 'Rate limited' })
		);
		await expect(run()).rejects.toThrow(
			'Your Claude usage limit is reached until 2027-01-15 08:00 UTC. Retry this job then.'
		);
		expect(runFailure({ assistantError: 'authentication_failed', stderr: '' })).toMatch(
			/claude setup-token/
		);
		expect(
			runFailure({
				result: { subtype: 'success', result: 'Not logged in · Please run /login' } as never,
				stderr: ''
			})
		).toMatch(/CLAUDE_CODE_OAUTH_TOKEN/);
		expect(runFailure({ result: { subtype: 'error_max_turns' } as never, stderr: '' })).toBe(
			'Claude used all its steps without finishing. Retry this job.'
		);
		expect(
			runFailure({
				result: { subtype: 'error_during_execution', errors: ['API overloaded'] } as never,
				stderr: ''
			})
		).toBe('Claude could not complete this task. API overloaded Retry this job.');
		expect(runFailure({ stderr: 'spawn failed' })).toBe(
			'Claude could not complete this task. spawn failed Retry this job.'
		);
	});
	it('cuts off very long tool output with a note', () => {
		expect(boundedOutput('short')).toBe('short');
		const long = boundedOutput('x'.repeat(250_000));
		expect(long.startsWith('x'.repeat(200_000) + '\n[Output cut off')).toBe(true);
	});
});
