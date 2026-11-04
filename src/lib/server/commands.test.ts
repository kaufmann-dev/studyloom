import { describe, expect, it, afterEach } from 'vitest';
import { mkdtemp, mkdir, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runCommand, runTool } from './commands';

const SECRETS = ['DATABASE_URL', 'ELEVENLABS_API_KEY', 'CLAUDE_CODE_OAUTH_TOKEN'] as const;
const saved = Object.fromEntries(SECRETS.map((name) => [name, process.env[name]]));

afterEach(() => {
	for (const name of SECRETS)
		if (saved[name] === undefined) delete process.env[name];
		else process.env[name] = saved[name];
});

async function jobDir() {
	const dir = await mkdtemp(join(tmpdir(), 'studyloom-command-'));
	await mkdir(join(dir, 'files'), { recursive: true });
	return dir;
}

describe('runCommand', () => {
	it('runs with the workspace as the working directory', async () => {
		const dir = await jobDir();
		try {
			const output = await runCommand(dir, 'echo hello > rel.txt && cat rel.txt');
			expect(output).toBe('hello\n');
			expect(await readFile(join(dir, 'files', 'rel.txt'), 'utf8')).toBe('hello\n');
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});
	it('does not pass app secrets to commands', async () => {
		const dir = await jobDir();
		try {
			for (const name of SECRETS) process.env[name] = `secret-${name}`;
			for (const output of [
				await runCommand(dir, 'env'),
				await runTool(dir, 'env', [], { timeoutMs: 10_000 })
			])
				expect(output).not.toContain('secret-');
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});
	it('keeps a character whole when it arrives split across two output chunks', async () => {
		const dir = await jobDir();
		try {
			// "ä" is 0xC3 0xA4 in UTF-8; the pause makes the two bytes separate chunks.
			expect(await runCommand(dir, "printf '\\303'; sleep 0.2; printf '\\244\\n'")).toBe('ä\n');
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});
	it('runs a tool directly in the workspace, without a shell', async () => {
		const dir = await jobDir();
		try {
			expect(await runTool(dir, 'echo', ['$HOME', '*'], { timeoutMs: 10_000 })).toBe('$HOME *\n');
			expect(await runTool(dir, 'pwd', [], { timeoutMs: 10_000 })).toBe(join(dir, 'files') + '\n');
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});
	it('propagates command failure', async () => {
		const dir = await jobDir();
		try {
			await expect(runCommand(dir, 'exit 3')).rejects.toThrow('exited with 3');
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});
});
