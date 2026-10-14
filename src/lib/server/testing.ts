import type { RequestEvent } from '@sveltejs/kit';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { api } from './api';

// Helpers for the tests that run against TEST_DATABASE_URL.

/** Points the app at the test database and a fresh DATA_DIR until `restore` runs. */
export async function useTestDatabase(name: string) {
	const previous = { DATABASE_URL: process.env.DATABASE_URL, DATA_DIR: process.env.DATA_DIR };
	const data = await mkdtemp(join(tmpdir(), `studyloom-${name}-`));
	process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
	process.env.DATA_DIR = data;
	return {
		data,
		async restore() {
			for (const [key, value] of Object.entries(previous))
				if (value === undefined) delete process.env[key];
				else process.env[key] = value;
			await rm(data, { recursive: true, force: true });
		}
	};
}

/** Calls the API as the signed-in user: objects are sent as JSON, Buffers as raw bytes. */
export function callApi(
	path: string,
	init: { method?: string; body?: unknown; headers?: Record<string, string> } = {}
) {
	const { body } = init;
	const raw = Buffer.isBuffer(body);
	const request = new Request(`https://studyloom.test${path}`, {
		method: init.method ?? (body === undefined ? 'GET' : 'POST'),
		body:
			body === undefined
				? undefined
				: raw
					? new Blob([Uint8Array.from(body)])
					: JSON.stringify(body),
		headers: {
			...(body !== undefined && {
				'content-type': raw ? 'application/octet-stream' : 'application/json'
			}),
			...init.headers
		}
	});
	return api({
		url: new URL(request.url),
		request,
		locals: { session: { subject: 'test', name: 'Test' } }
	} as RequestEvent);
}
