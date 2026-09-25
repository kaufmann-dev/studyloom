import { describe, expect, it } from 'vitest';
import type { RequestEvent } from '@sveltejs/kit';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { eq } from 'drizzle-orm';
import { api } from './api';
import { db, closeDatabase } from './db';
import { projects } from './db/schema';

describe.skipIf(!process.env.TEST_DATABASE_URL)('Library and pins', () => {
	it('stores nested items and files, rejects folder cycles, and removes deleted pins', async () => {
		const previousDatabaseUrl = process.env.DATABASE_URL;
		const previousDataDir = process.env.DATA_DIR;
		process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
		const data = await mkdtemp(join(tmpdir(), 'studyloom-library-'));
		process.env.DATA_DIR = data;
		const call = async (path: string, method = 'GET', body?: unknown) => {
			const request = new Request(`https://studyloom.test${path}`, {
				method,
				body:
					body === undefined
						? undefined
						: Buffer.isBuffer(body)
							? new Blob([Uint8Array.from(body)])
							: JSON.stringify(body),
				headers:
					body === undefined
						? {}
						: {
								'content-type': Buffer.isBuffer(body)
									? 'application/octet-stream'
									: 'application/json'
							}
			});
			return api({
				url: new URL(request.url),
				request,
				locals: { session: { subject: 'test', name: 'Test' } }
			} as RequestEvent);
		};
		const parse = async <T>(path: string, method = 'GET', body?: unknown): Promise<T> =>
			(await call(path, method, body)).json();
		const [project] = await db().insert(projects).values({ name: 'Pinned project' }).returning();
		try {
			expect((await parse<{ pins: unknown[] }>('/api/pins')).pins).toEqual([]);
			const { entry: folder } = await parse<{ entry: { id: string } }>('/api/library', 'POST', {
				kind: 'folder',
				name: 'University'
			});
			const { entry: child } = await parse<{ entry: { id: string } }>('/api/library', 'POST', {
				kind: 'folder',
				name: 'Documents',
				parentId: folder.id
			});
			const { entry: contact } = await parse<{ entry: { id: string } }>('/api/library', 'POST', {
				kind: 'contact',
				name: 'Registrar',
				parentId: child.id,
				phone: '+49 123'
			});
			const nested = await parse<{ ancestors: { id: string }[] }>(`/api/library/${contact.id}`);
			expect(nested.ancestors.map((ancestor) => ancestor.id)).toEqual([folder.id, child.id]);
			await expect(
				call('/api/library', 'POST', { kind: 'link', name: 'Portal', url: 'javascript:alert(1)' })
			).rejects.toMatchObject({ status: 400 });
			const { entry: link } = await parse<{ entry: { id: string } }>('/api/library', 'POST', {
				kind: 'link',
				name: 'Portal',
				parentId: child.id,
				url: 'https://example.edu'
			});
			const { entry: changedLink } = await parse<{ entry: { url: string } }>(
				`/api/library/${link.id}`,
				'PATCH',
				{ url: 'https://portal.example.edu' }
			);
			expect(changedLink.url).toBe('https://portal.example.edu');
			await parse('/api/library', 'POST', {
				kind: 'note',
				name: 'Deadline',
				parentId: child.id,
				text: 'October 12'
			});
			await expect(
				call(`/api/library/${folder.id}`, 'PATCH', { parentId: child.id })
			).rejects.toMatchObject({ status: 409 });
			const { entry: upload } = await parse<{ entry: { id: string } }>(
				'/api/library/uploads',
				'POST',
				{ parentId: child.id, filename: 'credentials.pdf', mimeType: 'application/pdf', size: 3 }
			);
			await call(`/api/library/${upload.id}/chunks/0`, 'PUT', Buffer.from('abc'));
			await parse(`/api/library/${upload.id}/complete`, 'POST', {});
			const file = await call(`/api/library/${upload.id}/file`);
			expect(await file.text()).toBe('abc');
			expect(file.headers.get('content-disposition')).toContain('inline');
			await parse('/api/pins', 'POST', { targetType: 'project', targetId: project.id });
			await parse('/api/pins', 'POST', { targetType: 'library', targetId: contact.id });
			await call(`/api/library/${folder.id}`, 'DELETE');
			const { pins } = await parse<{ pins: { targetType: string }[] }>('/api/pins');
			expect(pins.map((pin) => pin.targetType)).toEqual(['project']);
		} finally {
			await db().delete(projects).where(eq(projects.id, project.id));
			await closeDatabase();
			await rm(data, { recursive: true, force: true });
			if (previousDatabaseUrl === undefined) delete process.env.DATABASE_URL;
			else process.env.DATABASE_URL = previousDatabaseUrl;
			if (previousDataDir === undefined) delete process.env.DATA_DIR;
			else process.env.DATA_DIR = previousDataDir;
		}
	});
});
