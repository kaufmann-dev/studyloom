import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { runProcess } from './process';

/** The whole environment of workspace commands: no app secrets, a private home per job. */
async function toolEnvironment(jobDir: string) {
	const home = join(jobDir, 'home');
	await mkdir(home, { recursive: true });
	return {
		PATH: '/usr/local/bin:/usr/bin:/bin',
		LANG: 'C.UTF-8',
		HOME: home,
		XDG_CONFIG_HOME: home
	};
}

/** Runs a shell command that Claude chose, with the job workspace as the working directory. */
export async function runCommand(jobDir: string, command: string, signal?: AbortSignal) {
	return runProcess('/bin/bash', ['-c', command], {
		cwd: join(jobDir, 'files'),
		signal,
		timeoutMs: 180_000,
		maxBytes: 4 * 1024 * 1024,
		env: await toolEnvironment(jobDir)
	});
}

/** Runs one installed tool without a shell, in the job workspace and the same environment. */
export async function runTool(
	jobDir: string,
	command: string,
	args: string[],
	options: { signal?: AbortSignal; timeoutMs: number; maxBytes?: number }
) {
	return runProcess(command, args, {
		cwd: join(jobDir, 'files'),
		signal: options.signal,
		timeoutMs: options.timeoutMs,
		maxBytes: options.maxBytes ?? 8 * 1024 * 1024,
		env: await toolEnvironment(jobDir)
	});
}
