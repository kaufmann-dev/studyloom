import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { runProcess } from './process';

export async function runCommand(jobDir: string, command: string, signal?: AbortSignal) {
	const files = join(jobDir, 'files');
	const home = join(jobDir, 'home');
	await mkdir(home, { recursive: true });
	return runProcess('/bin/bash', ['-c', command], {
		cwd: files,
		signal,
		timeoutMs: 180_000,
		maxBytes: 4 * 1024 * 1024,
		env: {
			PATH: '/usr/local/bin:/usr/bin:/bin',
			LANG: 'C.UTF-8',
			HOME: home,
			XDG_CONFIG_HOME: home
		}
	});
}
