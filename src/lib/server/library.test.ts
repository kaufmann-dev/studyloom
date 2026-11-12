import { describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { db, closeDatabase } from './db';
import { projects } from './db/schema';
import { callApi, useTestDatabase } from './testing';

describe.skipIf(!process.env.TEST_DATABASE_URL)('Library and pins', () => {
	it('stores nested items and files, rejects folder cycles, and removes deleted pins', async () => {
		const environment = await useTestDatabase('library');
		const call = (path: string, method = 'GET', body?: unknown) => callApi(path, { method, body });
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
			const { folders } = await parse<{ folders: { id: string; parentId: string | null }[] }>(
				'/api/library/folders'
			);
			expect(folders.find((item) => item.id === child.id)?.parentId).toBe(folder.id);
			await expect(
				call(`/api/library/${link.id}`, 'PATCH', { parentId: contact.id })
			).rejects.toMatchObject({ status: 400 });
			const { entry: movedLink } = await parse<{ entry: { parentId: string | null; url: string } }>(
				`/api/library/${link.id}`,
				'PATCH',
				{ parentId: null }
			);
			expect(movedLink).toMatchObject({ parentId: null, url: 'https://portal.example.edu' });
			await call(`/api/library/${link.id}`, 'DELETE');
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
			await environment.restore();
		}
	});
	it('lets only contacts marked as lecturers lecture projects', async () => {
		const environment = await useTestDatabase('lecturers');
		const call = (path: string, method = 'GET', body?: unknown) => callApi(path, { method, body });
		const parse = async <T>(path: string, method = 'GET', body?: unknown): Promise<T> =>
			(await call(path, method, body)).json();
		type Entry = { id: string; lecturer: boolean };
		type Listed = { project: { lecturers: { id: string }[] } };
		const created: string[] = [];
		const add = async (body: object) => {
			const { entry } = await parse<{ entry: Entry }>('/api/library', 'POST', body);
			created.push(entry.id);
			return entry;
		};
		try {
			const contact = await add({ kind: 'contact', name: 'Kalam' });
			const note = await add({ kind: 'note', name: 'Memo', lecturer: true });
			expect([contact.lecturer, note.lecturer]).toEqual([false, false]);
			const assign = (lecturerIds: string[]) =>
				call('/api/projects', 'POST', { name: 'Course', lecturerIds });
			await expect(assign([contact.id])).rejects.toMatchObject({ status: 400 });

			await parse(`/api/library/${contact.id}`, 'PATCH', { lecturer: true });
			const { lecturers } = await parse<{ lecturers: { id: string }[] }>('/api/library/lecturers');
			expect(lecturers.map((lecturer) => lecturer.id)).toEqual([contact.id]);
			const { project } = await (await assign([contact.id])).json();
			expect(project.lecturers.map((lecturer: { id: string }) => lecturer.id)).toEqual([
				contact.id
			]);

			// Editing other details keeps the flag and the assignment.
			await parse(`/api/library/${contact.id}`, 'PATCH', { phone: '+43 1' });
			expect((await parse<Listed>(`/api/projects/${project.id}`)).project.lecturers).toHaveLength(
				1
			);

			await parse(`/api/library/${contact.id}`, 'PATCH', { lecturer: false });
			expect((await parse<Listed>(`/api/projects/${project.id}`)).project.lecturers).toEqual([]);
			await call(`/api/projects/${project.id}`, 'DELETE');
		} finally {
			for (const id of created) await call(`/api/library/${id}`, 'DELETE');
			await closeDatabase();
			await environment.restore();
		}
	});
});
