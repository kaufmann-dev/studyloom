import type { Server } from 'node:http';
import { describe, expect, it, vi } from 'vitest';
import { attachRuntime, providerErrorMessage } from './runtime';

const order = vi.hoisted(() => [] as string[]);

vi.mock('../lib/server/db', () => ({
	db: () => {
		order.push('query');
		return {
			update: () => ({
				set: () => ({
					where: () => {
						order.push('update');
						return Promise.resolve();
					}
				})
			})
		};
	},
	closeDatabase: () => Promise.resolve(),
	migrateDatabase: () => {
		order.push('migrate');
		return Promise.resolve();
	}
}));

vi.mock('../lib/server/jobs', () => ({
	startWorkers: () => () => Promise.resolve(),
	finishRecording: () => Promise.resolve()
}));

vi.mock('../lib/server/muse', () => ({
	museHost: { close: () => {} }
}));

describe('runtime startup', () => {
	it('applies migrations before crash recovery touches tables', async () => {
		order.length = 0;
		const shutdown = await attachRuntime({ on: () => {} } as unknown as Server);
		await shutdown();
		expect(order[0]).toBe('migrate');
		expect(order.filter((entry) => entry === 'update')).toHaveLength(2);
		expect(order.indexOf('migrate')).toBeLessThan(order.indexOf('update'));
	});
});

describe('transcription provider errors', () => {
	it('surfaces the provider reason instead of blaming the API key', () => {
		expect(
			providerErrorMessage({
				type: 'error',
				message: 'Ingress audio slower than real-time',
				errorType: 'invalid_request_error'
			})
		).toBe(
			'Transcription stream interrupted: invalid_request_error — Ingress audio slower than real-time.'
		);
	});
	it('falls back to the key guidance when the provider gives no detail', () => {
		expect(providerErrorMessage({ type: 'error' })).toMatch(/API key and usage limits/);
	});
});
