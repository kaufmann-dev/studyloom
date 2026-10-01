import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { constants, existsSync } from 'node:fs';
import { mkdir, writeFile, copyFile, chmod, rename, access } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { join, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { ClientError, dataDir } from './config';
import { runProcess } from './process';
import type { MuseAccount, MuseModel, MuseStatus } from '../domain';
const FALLBACK_PATH = '/usr/local/bin:/usr/bin:/bin';
function musePath(): string {
	const basePath = process.env.PATH || FALLBACK_PATH;
	return basePath.includes('/usr/local/bin') ? basePath : `/usr/local/bin:${basePath}`;
}
export function museEnvironment(configDir: string): NodeJS.ProcessEnv {
	const env: NodeJS.ProcessEnv = {
		PATH: musePath(),
		LANG: 'C.UTF-8',
		XDG_CONFIG_HOME: configDir,
		XDG_CACHE_HOME: join(dataDir(), 'cache'),
		XDG_DATA_HOME: join(dataDir(), 'muse-data'),
		MUSE_AUTH_PATH: join(configDir, 'muse', 'auth.json')
	};
	for (const key of ['SSL_CERT_FILE', 'SSL_CERT_DIR'])
		if (process.env[key]) env[key] = process.env[key];
	return env;
}
const exists = (path: string, mode?: number) =>
	access(path, mode).then(
		() => true,
		() => false
	);
export async function resolveMuseBin(): Promise<string> {
	const configured = process.env.MUSE_BIN;
	if (configured) {
		if (!(await exists(configured, constants.X_OK)))
			throw new Error(
				`Muse CLI not found at MUSE_BIN=${configured}. Set MUSE_BIN to the muse executable path or unset it to use automatic detection.`
			);
		return configured;
	}
	const directories = ['/usr/local/bin', '/usr/bin', ...musePath().split(':').filter(Boolean)];
	for (const directory of directories) {
		const candidate = join(directory, 'muse');
		if (await exists(candidate, constants.X_OK)) return candidate;
	}
	throw new Error(
		'Muse CLI not found. Install it with `bash scripts/install-muse.sh` or set MUSE_BIN to the muse executable path.'
	);
}
const configPath = () => join(dataDir(), 'muse-config');
export function resolveMcpPath() {
	const colocated = fileURLToPath(new URL('./mcp.js', import.meta.url));
	if (existsSync(colocated)) return colocated;
	const sourceBuild = fileURLToPath(new URL('../../../build/runtime/mcp.js', import.meta.url));
	if (existsSync(sourceBuild)) return sourceBuild;
	return resolve('build/runtime/mcp.js');
}
let settingsReady: Promise<void> | undefined;
function museSettings() {
	return (settingsReady ??= prepareSettings().catch((e) => {
		settingsReady = undefined;
		throw e;
	}));
}
async function prepareSettings() {
	const dir = join(configPath(), 'muse');
	await mkdir(dir, { recursive: true, mode: 0o700 });
	const imported = join(dir, 'import-complete');
	if (process.env.MUSE_AUTH_IMPORT_PATH) {
		if (!(await exists(imported))) {
			const auth = join(dir, 'auth.json');
			if (!(await exists(auth))) {
				await copyFile(process.env.MUSE_AUTH_IMPORT_PATH, auth);
				await chmod(auth, 0o600);
			}
			await writeFile(imported, '', { mode: 0o600 });
		}
	}
	const settings = {
		schema_version: 1,
		mcp_servers: {
			studyloom: {
				transport: 'stdio',
				command: process.execPath,
				args: [resolveMcpPath()],
				env: { TRANSCRIPTION_API_KEY: process.env.TRANSCRIPTION_API_KEY ?? '' },
				mode: 'required',
				enabled: true
			}
		}
	};
	const temporary = join(dir, 'settings-' + randomUUID() + '.tmp');
	await writeFile(temporary, JSON.stringify(settings), { mode: 0o600 });
	await rename(temporary, join(dir, 'settings.json'));
}
class MuseHost {
	private child: ChildProcessWithoutNullStreams | undefined;
	private next = 1;
	private pending = new Map<
		number,
		{ resolve: (v: unknown) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }
	>();
	private starting: Promise<void> | undefined;
	async ensure() {
		return (this.starting ??= this.start().catch((e) => {
			this.starting = undefined;
			throw e;
		}));
	}
	private async start() {
		const dir = join(dataDir(), 'muse-control');
		await mkdir(join(dir, 'files'), { recursive: true, mode: 0o700 });
		await museSettings();
		const child = spawn(
			await resolveMuseBin(),
			['serve', '--no-session-log', '--disable-write', '--disable-shell'],
			{ env: museEnvironment(configPath()), cwd: join(dir, 'files'), stdio: 'pipe' }
		);
		this.child = child;
		let stderr = '';
		child.stderr.on('data', (data: Buffer) => {
			stderr = (stderr + data.toString()).slice(-1000);
		});
		createInterface({ input: child.stdout }).on('line', (line) => {
			try {
				const message = JSON.parse(line);
				const request = this.pending.get(message.id);
				if (request) {
					clearTimeout(request.timer);
					this.pending.delete(message.id);
					if (message.error) request.reject(new Error(message.error.message));
					else request.resolve(message.result);
				}
			} catch {
				/* CLI diagnostics are not protocol messages. */
			}
		});
		const fail = (e: Error) => {
			this.starting = undefined;
			this.child = undefined;
			for (const p of this.pending.values()) {
				clearTimeout(p.timer);
				p.reject(e);
			}
			this.pending.clear();
		};
		child.on('error', fail);
		child.on('exit', () => fail(new Error('Muse connection closed. ' + stderr)));
		await this.rpc('initialize', {
			clientInfo: { name: 'studyloom', version: '1.0' },
			capabilities: { experimentalApi: true }
		});
		child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'initialized', params: {} }) + '\n');
	}
	private rpc(method: string, params: Record<string, unknown>) {
		return new Promise<unknown>((resolve, reject) => {
			const id = this.next++;
			const timer = setTimeout(() => {
				this.pending.delete(id);
				reject(new Error('Muse did not respond.'));
			}, 30_000);
			this.pending.set(id, { resolve, reject, timer });
			this.child?.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
		});
	}
	async call<T>(method: string, params: Record<string, unknown> = {}): Promise<T> {
		await this.ensure();
		return (await this.rpc(method, params)) as T;
	}
	close() {
		this.child?.kill();
	}
}
// The SvelteKit and worker bundles share one process and one account-control connection.
const processState = globalThis as typeof globalThis & { __studyloomMuseHost?: MuseHost };
export const museHost = (processState.__studyloomMuseHost ??= new MuseHost());
export const STALE_MUSE_LOGIN =
	'Your Muse login is no longer valid. Disconnect, then connect your Muse account again.';
export const MUSE_MODELS_UNREACHABLE =
	'Could not load Muse models. Check the connection and try again.';
export function museStatusFromCatalog(account: MuseAccount, models: MuseModel[]): MuseStatus {
	if (account.state === 'accountLogin' && models.length === 0)
		return { account, models, error: STALE_MUSE_LOGIN };
	return { account, models };
}
export async function museStatus(): Promise<MuseStatus> {
	const account = await museHost.call<MuseAccount>('account/read');
	if (account.state !== 'accountLogin') return { account, models: [] };
	let models: MuseModel[];
	try {
		const catalog = await museHost.call<{ models: MuseModel[] }>('model/list');
		models = Array.isArray(catalog.models) ? catalog.models : [];
	} catch {
		return { account, models: [], error: MUSE_MODELS_UNREACHABLE };
	}
	return museStatusFromCatalog(account, models);
}
export async function validateModel(modelId: string) {
	let account: MuseAccount;
	let models: MuseModel[];
	try {
		({ account, models } = await museStatus());
	} catch {
		throw new ClientError(503, 'Muse is unavailable. Check Settings and retry.');
	}
	if (account.state !== 'accountLogin')
		throw new ClientError(409, 'Sign into Muse with your subscription in Settings.');
	if (models.length === 0) throw new ClientError(409, STALE_MUSE_LOGIN);
	if (!models.some((m) => m.modelId === modelId))
		throw new ClientError(409, 'This model is no longer available. Refresh the model list.');
}
export interface MuseResult {
	text: string;
	stderr: string;
}
export async function museRun(
	workspace: string,
	modelId: string,
	prompt: string,
	signal: AbortSignal,
	onProgress: (text: string) => void
): Promise<MuseResult> {
	await validateModel(modelId);
	const configDir = join(workspace, 'control');
	await museSettings();
	await mkdir(configDir, { recursive: true, mode: 0o700 });
	const files = join(workspace, 'files');
	await mkdir(files, { recursive: true, mode: 0o700 });
	await mkdir(join(files, '.git'), { recursive: true });
	const promptFile = join(configDir, 'prompt.txt');
	await writeFile(promptFile, prompt, { mode: 0o600 });
	let terminal: string | undefined;
	let failure: string | undefined;
	const stderrTail = { text: '' };
	await runProcess(
		await resolveMuseBin(),
		[
			'exec',
			'--json',
			'--workspace',
			files,
			'--prompt-file',
			promptFile,
			'--model',
			modelId,
			'--disable-shell',
			'--disable-write',
			'--disable-web-tools',
			'--no-foreign-personal-context',
			'--no-session-log',
			'--disable-approval',
			'--max-model-steps',
			'100',
			'--max-tool-output-bytes',
			'200000'
		],
		{
			env: museEnvironment(configPath()),
			cwd: files,
			signal,
			timeoutMs: 30 * 60_000,
			maxBytes: 32 * 1024 * 1024,
			stderrTail,
			onLine: (line) => {
				try {
					const event = JSON.parse(line);
					if (event.payload_type === 'run.terminal.failed') failure = event.payload?.reason;
					if (
						event.payload_type === 'run.terminal.completed' &&
						event.payload?.terminal === 'completed'
					)
						terminal = event.payload.text;
					if (event.payload_type === 'run.output.delta' && typeof event.payload?.text === 'string')
						onProgress(event.payload.text);
				} catch {
					/* Ignore non-JSON diagnostic lines. */
				}
			}
		}
	).catch((e) => {
		throw new Error(failure || (e instanceof Error ? e.message : 'Muse failed.'));
	});
	if (terminal === undefined)
		throw new Error('Muse did not complete this task. Retry from the job panel.');
	return { text: terminal, stderr: stderrTail.text };
}
