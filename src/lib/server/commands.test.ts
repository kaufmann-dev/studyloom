import { describe, expect, it, afterEach } from 'vitest';
import { mkdtemp, mkdir, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runCommand } from './commands';

const savedDatabaseUrl = process.env.DATABASE_URL;
const savedTranscriptionKey = process.env.TRANSCRIPTION_API_KEY;

afterEach(() => {
	if (savedDatabaseUrl === undefined) delete process.env.DATABASE_URL;
	else process.env.DATABASE_URL = savedDatabaseUrl;
	if (savedTranscriptionKey === undefined) delete process.env.TRANSCRIPTION_API_KEY;
	else process.env.TRANSCRIPTION_API_KEY = savedTranscriptionKey;
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
			process.env.DATABASE_URL = 'secret-database-url';
			process.env.TRANSCRIPTION_API_KEY = 'secret-transcription-key';
			const output = await runCommand(dir, 'env');
			expect(output).not.toContain('secret-database-url');
			expect(output).not.toContain('secret-transcription-key');
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
