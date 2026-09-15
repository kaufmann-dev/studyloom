import { describe, expect, it, afterEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ensureSandboxAvailable } from './sandbox';

const savedPath = process.env.PATH;

afterEach(() => {
	if (savedPath === undefined) delete process.env.PATH;
	else process.env.PATH = savedPath;
});

describe('sandbox availability probe', () => {
	it('fails fast with an actionable error when the sandbox runtime is missing', async () => {
		const dir = await mkdtemp(join(tmpdir(), 'studyloom-no-sandbox-'));
		try {
			process.env.PATH = dir;
			await expect(ensureSandboxAvailable()).rejects.toThrow(
				/isolated Bubblewrap sandbox.*pnpm sandbox:check/
			);
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});
});
