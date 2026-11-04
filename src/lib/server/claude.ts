import { mkdir, readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import {
	createSdkMcpServer,
	query,
	tool,
	type ModelInfo,
	type Options,
	type Query,
	type SDKAssistantMessageError,
	type SDKMessage,
	type SDKResultMessage,
	type SDKUserMessage
} from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import { ClientError, dataDir, safeError } from './config';
import { runCommand } from './commands';
import { transcribeFile } from './elevenlabs';
import { scopedFile } from './storage';
import { DEFAULT_MODEL, type ClaudeModel, type ClaudeStatus } from '../domain';

// Everything Studyloom asks Claude goes through this module, the only user of the Agent SDK.

const TOKEN = 'CLAUDE_CODE_OAUTH_TOKEN';
const NOT_SET_UP = 'Claude is not set up. See Settings.';
const RUN_TIMEOUT_MS = 30 * 60_000;
const MODELS_CACHE_MS = 60 * 60_000;
const TOOL_OUTPUT_CHARS = 200_000;
const TOOLS = 'mcp__studyloom__';

export const claudeConfigured = () => Boolean(process.env[TOKEN]);
const root = () => join(dataDir(), 'claude');

/** The whole environment of the Claude Code process: its login token is its only secret. */
export function claudeEnvironment(): Record<string, string> {
	const env: Record<string, string> = {
		PATH: process.env.PATH || '/usr/local/bin:/usr/bin:/bin',
		LANG: 'C.UTF-8',
		HOME: join(root(), 'home'),
		CLAUDE_CONFIG_DIR: join(root(), 'config'),
		CLAUDE_AGENT_SDK_CLIENT_APP: 'studyloom'
	};
	for (const key of [TOKEN, 'SSL_CERT_FILE', 'SSL_CERT_DIR']) {
		const value = process.env[key];
		if (value) env[key] = value;
	}
	return env;
}
/** Options every session shares: no settings, plugins or sessions on disk, no prompts. */
async function baseOptions(stderr: { text: string }): Promise<Options> {
	await Promise.all(
		['home', 'config'].map((dir) => mkdir(join(root(), dir), { recursive: true, mode: 0o700 }))
	);
	return {
		settingSources: [],
		strictMcpConfig: true,
		persistSession: false,
		permissionMode: 'dontAsk',
		env: claudeEnvironment(),
		stderr: (data) => {
			stderr.text = (stderr.text + data).slice(-1000);
		}
	};
}
/** `default` leaves the choice to Claude Code, which picks the account's recommended model. */
const modelOption = (modelId: string) => (modelId === DEFAULT_MODEL ? {} : { model: modelId });

/** Feeds user messages into a streaming session, written verbatim (no commands or mentions). */
class InputQueue implements AsyncIterable<SDKUserMessage> {
	private readonly items: SDKUserMessage[] = [];
	private waiting: ((next: IteratorResult<SDKUserMessage>) => void) | undefined;
	private ended = false;
	push(text: string) {
		const message: SDKUserMessage = {
			type: 'user',
			message: { role: 'user', content: text },
			parent_tool_use_id: null,
			client_composed: true
		};
		const waiting = this.waiting;
		this.waiting = undefined;
		if (waiting) waiting({ value: message, done: false });
		else this.items.push(message);
	}
	end() {
		this.ended = true;
		const waiting = this.waiting;
		this.waiting = undefined;
		waiting?.({ value: undefined, done: true });
	}
	[Symbol.asyncIterator](): AsyncIterator<SDKUserMessage> {
		return {
			next: () => {
				const item = this.items.shift();
				if (item) return Promise.resolve({ value: item, done: false });
				if (this.ended) return Promise.resolve({ value: undefined, done: true });
				return new Promise((resolve) => (this.waiting = resolve));
			}
		};
	}
}

let catalog: { value: Promise<ModelInfo[]>; until: number } | undefined;
/** Claude Code's live model list; its aliases follow new releases without code changes. */
function modelCatalog() {
	if (!catalog || catalog.until < Date.now()) {
		const value = loadCatalog().catch((cause) => {
			catalog = undefined;
			throw cause;
		});
		catalog = { value, until: Date.now() + MODELS_CACHE_MS };
	}
	return catalog.value;
}
async function loadCatalog() {
	const input = new InputQueue();
	const session = query({
		prompt: input,
		options: { ...(await baseOptions({ text: '' })), tools: [] }
	});
	let timer: NodeJS.Timeout | undefined;
	try {
		return await Promise.race([
			session.supportedModels(),
			new Promise<never>((_, reject) => {
				timer = setTimeout(() => reject(new Error('Claude Code did not list its models.')), 30_000);
			})
		]);
	} finally {
		clearTimeout(timer);
		input.end();
		session.close();
	}
}
/**
 * A readable entry from Claude Code's model row: "Opus 5.5" from "Opus" and "Opus 5.5 · Best
 * for …", "Default (recommended) · Opus 5.5" for the default. API prices are left out: the
 * subscription does not bill per token.
 */
export function describeModel(model: Pick<ModelInfo, 'value' | 'displayName' | 'description'>) {
	const [summary = '', ...rest] = model.description.split(' · ').map((part) => part.trim());
	const current = /\(currently ([^)]+)\)/.exec(summary)?.[1];
	return {
		modelId: model.value,
		displayLabel: summary.startsWith(model.displayName)
			? summary
			: current
				? `${model.displayName} · ${current}`
				: model.displayName,
		description: rest.filter((part) => !part.includes('$')).join(' · ')
	};
}
export async function claudeModels(): Promise<ClaudeModel[]> {
	return (await modelCatalog()).map(describeModel);
}
export async function claudeStatus(): Promise<ClaudeStatus> {
	if (!claudeConfigured()) return { configured: false, models: [] };
	try {
		return { configured: true, models: await claudeModels() };
	} catch (cause) {
		console.error('Claude model list failed:', safeError(cause));
		return {
			configured: true,
			models: [],
			error: 'Could not load Claude models. Check the connection and try again.'
		};
	}
}
async function availableModels() {
	if (!claudeConfigured()) throw new ClientError(409, NOT_SET_UP);
	try {
		return await claudeModels();
	} catch {
		throw new ClientError(503, 'Claude is unavailable. Check Settings and retry.');
	}
}
const offered = (models: ClaudeModel[], modelId: string) =>
	modelId === DEFAULT_MODEL || models.some((model) => model.modelId === modelId);
export async function validateModel(modelId: string) {
	if (!offered(await availableModels(), modelId))
		throw new ClientError(409, 'This model is no longer available. Refresh the model list.');
}
/** The output's own model while Claude Code still offers it, otherwise the default. */
export async function gradingModel(preferred: string) {
	return offered(await availableModels(), preferred) ? preferred : DEFAULT_MODEL;
}

type ToolResult = {
	content: ({ type: 'text'; text: string } | { type: 'image'; data: string; mimeType: string })[];
	isError?: boolean;
};
const text = (value: unknown): ToolResult => ({
	content: [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value) }]
});
/** A tool failure goes back to Claude as a result it can react to, not as a crash. */
async function attempt(run: () => Promise<ToolResult>): Promise<ToolResult> {
	try {
		return await run();
	} catch (cause) {
		const message = cause instanceof Error ? cause.message : 'The tool failed.';
		return { ...text(message.slice(0, 8000)), isError: true };
	}
}
export function boundedOutput(output: string) {
	return output.length > TOOL_OUTPUT_CHARS
		? `${output.slice(0, TOOL_OUTPUT_CHARS)}\n[Output cut off after ${TOOL_OUTPUT_CHARS} characters. Write long output to a file and read it in parts.]`
		: output;
}
/** The job workspace tools; paths are relative to the workspace and cannot leave it. */
export function workspaceTools(jobDir: string, signal: AbortSignal) {
	const files = join(jobDir, 'files');
	return createSdkMcpServer({
		name: 'studyloom',
		version: '1.0.0',
		tools: [
			tool(
				'run_command',
				`Run a shell command or Python script with the job workspace as the working directory. Installed tools include Python 3, FFmpeg/ffprobe, LibreOffice, pdftotext/pdftoppm/pdfinfo/pdfimages and Tesseract. Choose the tools needed for the actual source; do not assume any file format is readable. Use relative paths. App secrets are never passed to commands. Output beyond ${TOOL_OUTPUT_CHARS} characters is cut off.`,
				{ command: z.string().min(1).max(100_000) },
				({ command }) =>
					attempt(async () => text(boundedOutput(await runCommand(jobDir, command, signal))))
			),
			tool(
				'read_file',
				'Read up to 200,000 characters from a UTF-8 workspace file, starting at a character offset. Paths are relative to the workspace root.',
				{ path: z.string(), offset: z.number().int().nonnegative().default(0) },
				({ path, offset }) =>
					attempt(async () => {
						const file = await scopedFile(files, path);
						if ((await stat(file)).size > 32 * 1024 * 1024)
							throw new Error('Use run_command to extract a smaller portion.');
						return text((await readFile(file, 'utf8')).slice(offset, offset + TOOL_OUTPUT_CHARS));
					})
			),
			tool(
				'view_image',
				'Inspect a PNG/JPEG/WebP image from the workspace. Use this to read diagrams, images, scanned pages and slide renders. Resize very large images using tools first.',
				{ path: z.string(), mimeType: z.enum(['image/png', 'image/jpeg', 'image/webp']) },
				({ path, mimeType }) =>
					attempt(async () => {
						const file = await scopedFile(files, path);
						if ((await stat(file)).size > 8 * 1024 * 1024)
							throw new Error('Resize the image below 8 MiB.');
						return {
							content: [
								{ type: 'image', mimeType, data: (await readFile(file)).toString('base64') }
							]
						};
					})
			),
			tool(
				'transcribe_audio',
				'Transcribe a workspace audio or video file with ElevenLabs speech-to-text, including speaker labels. This incurs API usage. Any common audio or video format works; extract the audio track of large videos with FFmpeg first. Returns the transcript and turns with times in milliseconds from the start of the file.',
				{ path: z.string() },
				({ path }) =>
					attempt(async () => text(await transcribeFile(await scopedFile(files, path), signal)))
			)
		]
	});
}

export interface ClaudeResult {
	text: string;
	structured?: unknown;
	stderr: string;
}
interface RunState {
	result?: SDKResultMessage;
	/** When a rejected rate limit resets, in epoch seconds; null when unknown. */
	limitedUntil?: number | null;
	assistantError?: SDKAssistantMessageError;
	stderr: string;
}
const resetTime = (until: number) =>
	new Date(until < 1e12 ? until * 1000 : until).toISOString().slice(0, 16).replace('T', ' ');
/** Why a run produced no usable result, in words the job panel can show. */
export function runFailure(state: RunState): string {
	const { result, limitedUntil, assistantError, stderr } = state;
	if (limitedUntil !== undefined)
		return `Your Claude usage limit is reached${limitedUntil ? ` until ${resetTime(limitedUntil)} UTC` : ''}. Retry this job then.`;
	const detail =
		(result?.subtype === 'success' ? result.result : result?.errors?.join('; ')) ||
		stderr.trim() ||
		'';
	if (
		assistantError === 'authentication_failed' ||
		/not logged in|\/login|oauth token/i.test(detail)
	)
		return 'Claude rejected the login token. Create a new one with `claude setup-token` and update CLAUDE_CODE_OAUTH_TOKEN.';
	if (assistantError === 'billing_error' || assistantError === 'account_on_hold')
		return 'Claude refused the request because of the account’s plan or billing. Check your Claude subscription.';
	if (result?.subtype === 'error_max_turns')
		return 'Claude used all its steps without finishing. Retry this job.';
	if (result?.subtype === 'error_max_structured_output_retries')
		return 'Claude could not produce a valid result. Retry this job.';
	return `Claude could not complete this task.${detail ? ` ${detail.slice(-400)}` : ''} Retry this job.`;
}
/** Records what a run's messages say about progress, limits and the final result. */
function observe(message: SDKMessage, state: RunState, progress: (text: string) => void) {
	if (message.type === 'assistant') {
		if (message.error) state.assistantError = message.error;
		for (const block of message.message.content) {
			if (block.type === 'text' && block.text.trim()) progress(block.text);
			if (block.type === 'tool_use') progress(`Running ${block.name.replace(TOOLS, '')}`);
		}
	}
	if (message.type === 'rate_limit_event' && message.rate_limit_info.status === 'rejected')
		state.limitedUntil = message.rate_limit_info.resetsAt ?? null;
	if (message.type === 'result') state.result = message;
}

/**
 * Runs one task in a job workspace with the Studyloom tools and no built-in Claude Code tools.
 * With a schema, the result is Claude's structured output for it.
 */
export async function claudeRun(input: {
	workspace: string;
	modelId: string;
	system: string;
	prompt: string;
	schema?: z.ZodType;
	signal: AbortSignal;
	progress: (text: string) => void;
}): Promise<ClaudeResult> {
	await validateModel(input.modelId);
	const files = join(input.workspace, 'files');
	await mkdir(files, { recursive: true, mode: 0o700 });
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), RUN_TIMEOUT_MS);
	const cancel = () => controller.abort();
	input.signal.addEventListener('abort', cancel, { once: true });
	if (input.signal.aborted) cancel();
	const stderr = { text: '' };
	const state: RunState = { stderr: '' };
	const prompt = new InputQueue();
	prompt.push(input.prompt);
	prompt.end();
	try {
		const run = query({
			prompt,
			options: {
				...(await baseOptions(stderr)),
				...modelOption(input.modelId),
				systemPrompt: input.system,
				cwd: files,
				tools: [],
				mcpServers: { studyloom: workspaceTools(input.workspace, controller.signal) },
				// dontAsk denies whatever is not listed; StructuredOutput delivers the schema result.
				allowedTools: [`${TOOLS}*`, ...(input.schema ? ['StructuredOutput'] : [])],
				maxTurns: 100,
				abortController: controller,
				...(input.schema && {
					outputFormat: {
						type: 'json_schema',
						schema: z.toJSONSchema(input.schema, { target: 'draft-7' })
					}
				})
			}
		});
		for await (const message of run) observe(message, state, input.progress);
	} catch (cause) {
		// A failed run may end its stream with an error after the result; the result explains it.
		if (input.signal.aborted) throw new Error('The job was cancelled.', { cause });
		if (controller.signal.aborted)
			throw new Error('Claude took longer than 30 minutes. Retry this job.', { cause });
	} finally {
		clearTimeout(timer);
		input.signal.removeEventListener('abort', cancel);
	}
	state.stderr = stderr.text;
	const result = state.result;
	if (result?.subtype !== 'success' || result.is_error) throw new Error(runFailure(state));
	return { text: result.result, structured: result.structured_output, stderr: stderr.text };
}

/** A live conversation without tools; each `send` streams one reply. */
export class ClaudeConversation {
	private readonly messages: AsyncIterator<SDKMessage>;
	private readonly state: RunState = { stderr: '' };
	private constructor(
		private readonly session: Query,
		private readonly input: InputQueue,
		private readonly stderr: { text: string }
	) {
		this.messages = session[Symbol.asyncIterator]();
	}
	static async start(options: { modelId: string; system: string; cwd: string; effort: 'low' }) {
		await mkdir(options.cwd, { recursive: true, mode: 0o700 });
		const supportsEffort = await modelCatalog().then(
			(models) =>
				models
					.find((model) => model.value === options.modelId)
					?.supportedEffortLevels?.includes(options.effort) ?? false,
			() => false
		);
		const stderr = { text: '' };
		const input = new InputQueue();
		const session = query({
			prompt: input,
			options: {
				...(await baseOptions(stderr)),
				...modelOption(options.modelId),
				systemPrompt: options.system,
				cwd: options.cwd,
				tools: [],
				includePartialMessages: true,
				...(supportsEffort && { effort: options.effort })
			}
		});
		const conversation = new ClaudeConversation(session, input, stderr);
		try {
			await session.initializationResult();
		} catch (cause) {
			conversation.close();
			throw cause;
		}
		return conversation;
	}
	/** Sends one message; text deltas stream to `onDelta`, and the whole reply resolves. */
	async send(message: string, onDelta: (delta: string) => void) {
		this.state.result = undefined;
		this.input.push(message);
		let reply = '';
		let textBlocks = 0;
		for (;;) {
			const next = await this.messages.next();
			if (next.done) throw new Error('The tutor session closed.');
			const event = next.value;
			observe(event, this.state, () => {});
			if (event.type === 'stream_event' && event.parent_tool_use_id === null) {
				const stream = event.event;
				if (stream.type === 'content_block_start' && stream.content_block.type === 'text') {
					if (textBlocks++ > 0) {
						reply += '\n';
						onDelta('\n');
					}
				}
				if (stream.type === 'content_block_delta' && stream.delta.type === 'text_delta') {
					reply += stream.delta.text;
					onDelta(stream.delta.text);
				}
			}
			if (event.type !== 'result') continue;
			if (event.subtype !== 'success' || event.is_error) {
				this.state.stderr = this.stderr.text;
				throw new Error(runFailure(this.state));
			}
			if (!reply && event.result) {
				reply = event.result;
				onDelta(reply);
			}
			return reply;
		}
	}
	close() {
		this.input.end();
		this.session.close();
	}
}
