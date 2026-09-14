import { access } from 'node:fs/promises';
import { constants } from 'node:fs';
import { join } from 'node:path';
import { runProcess } from './process';
export async function sandboxArgs(files: string, command: string) {
	const args = ['--die-with-parent', '--new-session', '--unshare-all', '--clearenv'];
	for (const path of [
		'/usr',
		'/bin',
		'/sbin',
		'/lib',
		'/lib64',
		'/opt',
		'/nix/store',
		'/etc/fonts',
		'/etc/alternatives'
	]) {
		try {
			await access(path, constants.R_OK);
			args.push('--ro-bind', path, path);
		} catch {
			/* Distribution-specific runtime path. */
		}
	}
	args.push(
		'--proc',
		'/proc',
		'--dev',
		'/dev',
		'--tmpfs',
		'/tmp',
		'--dir',
		'/work',
		'--bind',
		files,
		'/work',
		'--chdir',
		'/work',
		'--setenv',
		'PATH',
		'/usr/local/bin:/usr/bin:/bin',
		'--setenv',
		'LANG',
		'C.UTF-8',
		'--setenv',
		'XDG_CONFIG_HOME',
		'/tmp',
		'--',
		'/bin/bash',
		'-c',
		command
	);
	return args;
}
export async function sandboxCommand(jobDir: string, command: string, signal?: AbortSignal) {
	return runProcess(
		'prlimit',
		[
			'--cpu=120',
			'--as=4294967296',
			'--fsize=2147483648',
			'--nofile=256',
			'--',
			'bwrap',
			...(await sandboxArgs(join(jobDir, 'files'), command))
		],
		{
			signal,
			timeoutMs: 180_000,
			maxBytes: 4 * 1024 * 1024,
			env: { PATH: process.env.PATH, LANG: 'C.UTF-8' }
		}
	);
}
