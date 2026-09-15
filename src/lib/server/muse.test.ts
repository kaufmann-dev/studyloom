import { describe, expect, it, afterEach } from 'vitest';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { museEnvironment, resolveMuseBin } from './muse';

const savedPath = process.env.PATH;
const savedMuseBin = process.env.MUSE_BIN;

afterEach(() => {
	if (savedPath === undefined) delete process.env.PATH;
	else process.env.PATH = savedPath;
	if (savedMuseBin === undefined) delete process.env.MUSE_BIN;
	else process.env.MUSE_BIN = savedMuseBin;
});

describe('muse binary resolution', () => {
	it('honors MUSE_BIN when it points at an executable', async () => {
		const dir = await mkdtemp(join(tmpdir(), 'studyloom-muse-'));
		try {
			const bin = join(dir, 'my-muse');
			await writeFile(bin, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
			process.env.MUSE_BIN = bin;
			await expect(resolveMuseBin()).resolves.toBe(bin);
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});
	it('reports a misconfigured MUSE_BIN instead of a bare ENOENT', async () => {
		process.env.MUSE_BIN = '/nonexistent/muse';
		await expect(resolveMuseBin()).rejects.toThrow('MUSE_BIN=/nonexistent/muse');
	});
	it('keeps /usr/local/bin on PATH even when the runtime PATH is empty', () => {
		delete process.env.PATH;
		delete process.env.MUSE_BIN;
		const env = museEnvironment('/private/config');
		expect(env.PATH).toContain('/usr/local/bin');
		process.env.PATH = '/usr/bin:/bin';
		expect(museEnvironment('/private/config').PATH).toContain('/usr/local/bin');
	});
});
