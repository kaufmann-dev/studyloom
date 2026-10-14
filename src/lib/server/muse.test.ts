import { describe, expect, it, afterEach } from 'vitest';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { museEnvironment, museHost, museStatusFromCatalog, resolveMuseBin } from './muse';
import type { MuseAccount, MuseModel } from '../domain';

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

describe('muse stale-login detection', () => {
	const loggedIn: MuseAccount = {
		state: 'accountLogin',
		label: 'learner@example.com',
		credentialRequired: true
	};
	const model: MuseModel = {
		modelId: 'muse-spark-1.3-contributor',
		displayLabel: 'muse-spark-1.3-contributor',
		contextLimit: 1007997,
		description: null
	};
	it('returns models without an error when the catalog is populated', () => {
		const status = museStatusFromCatalog(loggedIn, [model]);
		expect(status.models).toEqual([model]);
		expect(status.error).toBeUndefined();
	});
	it('flags an empty catalog on a logged-in account as a stale login', () => {
		const status = museStatusFromCatalog(loggedIn, []);
		expect(status.models).toEqual([]);
		expect(status.error).toMatch(/no longer valid/);
	});
	it('stays silent when logged out, even with an empty catalog', () => {
		const status = museStatusFromCatalog({ state: 'loggedOut', credentialRequired: true }, []);
		expect(status.models).toEqual([]);
		expect(status.error).toBeUndefined();
	});
});

describe('muse host protocol', () => {
	it('routes notifications and refuses server requests without mistaking them for replies', async () => {
		const dir = await mkdtemp(join(tmpdir(), 'studyloom-muse-host-'));
		const savedDataDir = process.env.DATA_DIR;
		try {
			// A stand-in host that sends a server request reusing the client's request id.
			const bin = join(dir, 'muse');
			await writeFile(
				bin,
				`#!/usr/bin/env node
const out = (m) => process.stdout.write(JSON.stringify(m) + '\\n');
require('readline').createInterface({ input: process.stdin }).on('line', (line) => {
	const m = JSON.parse(line);
	if (m.method === 'initialize') out({ jsonrpc: '2.0', id: m.id, result: {} });
	if (m.method === 'test/echo') {
		out({ jsonrpc: '2.0', id: m.id, method: 'approval/request', params: { sessionId: 's' } });
		out({ jsonrpc: '2.0', method: 'item/delta', params: { sessionId: 's', delta: 'hi' } });
		out({ jsonrpc: '2.0', id: m.id, result: { ok: true } });
	}
	if (m.error) out({ jsonrpc: '2.0', method: 'test/refused', params: { code: m.error.code } });
});
`,
				{ mode: 0o755 }
			);
			process.env.MUSE_BIN = bin;
			process.env.DATA_DIR = dir;
			const events: unknown[] = [];
			const off = [
				museHost.on('item/delta', (params) => events.push(['delta', params.delta])),
				museHost.on('approval/request', () => events.push(['approval'])),
				museHost.on('test/refused', (params) => events.push(['refused', params.code]))
			];
			await expect(museHost.call('test/echo')).resolves.toEqual({ ok: true });
			await new Promise((resolve) => setTimeout(resolve, 100));
			expect(events).toEqual([['approval'], ['delta', 'hi'], ['refused', -32601]]);
			off.forEach((unsubscribe) => unsubscribe());
		} finally {
			museHost.close();
			if (savedDataDir === undefined) delete process.env.DATA_DIR;
			else process.env.DATA_DIR = savedDataDir;
			await rm(dir, { recursive: true, force: true });
		}
	});
});
