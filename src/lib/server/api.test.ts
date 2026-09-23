import { describe, expect, it, vi } from 'vitest';
import type { RequestEvent } from '@sveltejs/kit';
import { api } from './api';

vi.mock('./db', () => ({
	db: () => {
		throw new Error('Database connection failed.');
	}
}));

function event(path: string, request: Request): RequestEvent {
	return {
		url: new URL(path, 'https://studyloom.test'),
		request,
		locals: { session: { subject: 'test', name: 'Test' } }
	} as RequestEvent;
}

describe('API error classification', () => {
	it('reports malformed JSON as a client error', async () => {
		const request = new Request('https://studyloom.test/api/projects', {
			method: 'POST',
			body: '{'
		});
		await expect(api(event('/api/projects', request))).rejects.toMatchObject({ status: 400 });
	});

	it('leaves an unexpected database failure for SvelteKit to report as a server error', async () => {
		const request = new Request('https://studyloom.test/api/projects');
		await expect(api(event('/api/projects', request))).rejects.toThrow(
			'Database connection failed.'
		);
	});
});
