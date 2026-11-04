import { describe, expect, it, vi } from 'vitest';
import { readFile } from 'node:fs/promises';
import { eq } from 'drizzle-orm';
import { db, closeDatabase } from './db';
import { materials, projects, sourceChunks } from './db/schema';
import { pastedSections } from './sources';
import { originalPath } from './storage';
import { callApi, useTestDatabase } from './testing';

describe('Pasted text parts', () => {
	it('keeps whole paragraphs together in citable parts', () => {
		const paragraph = (word: string) => `${word} `.repeat(300).trim();
		const sections = pastedSections(
			`${paragraph('alpha')}\r\n\r\n${paragraph('beta')}\n \n${paragraph('gamma')}`
		);
		expect(sections.map((s) => s.locator)).toEqual(['part:1', 'part:2']);
		expect(sections[0].text).toBe(`${paragraph('alpha')}\n\n${paragraph('beta')}`);
		expect(sections[1].text).toBe(paragraph('gamma'));
	});
	it('cuts an overlong paragraph at a word boundary and drops blank lines', () => {
		const sections = pastedSections(`\n\n${'word '.repeat(2000)}\n\n`);
		expect(sections.length).toBe(3);
		expect(sections.every((s) => s.text.length <= 4000 && !s.text.startsWith(' '))).toBe(true);
		expect(sections.map((s) => s.text).join(' ')).toBe('word '.repeat(2000).trim());
	});
});

describe.skipIf(!process.env.TEST_DATABASE_URL)('Pasted text sources', () => {
	it('stores pasted text unchanged as a ready, searchable source', async () => {
		const environment = await useTestDatabase('paste');
		vi.stubEnv('ORIGIN', 'https://studyloom.test');
		const [project] = await db().insert(projects).values({ name: 'Notes' }).returning();
		const call = (body: unknown) => callApi(`/api/projects/${project.id}/text-sources`, { body });
		try {
			const text = 'Lecture 3: Osmosis\n\nWater crosses the membrane towards more salt.';
			const response = await call({ name: '', text });
			expect(response.status).toBe(201);
			const { materialId } = await response.json();
			const [material] = await db().select().from(materials).where(eq(materials.id, materialId));
			expect(material).toMatchObject({
				name: 'Lecture 3: Osmosis',
				filename: 'Lecture 3- Osmosis.txt',
				mimeType: 'text/plain',
				status: 'ready',
				notes: 'Pasted text.'
			});
			expect(await readFile(originalPath(materialId), 'utf8')).toBe(text);
			const chunks = await db()
				.select({ locator: sourceChunks.locator, text: sourceChunks.text })
				.from(sourceChunks)
				.where(eq(sourceChunks.materialId, materialId));
			expect(chunks).toEqual([{ locator: 'part:1', text }]);

			const named = await (await call({ name: 'My notes', text: 'Short.' })).json();
			const [second] = await db()
				.select()
				.from(materials)
				.where(eq(materials.id, named.materialId));
			expect(second.name).toBe('My notes');
			await expect(call({ name: 'Blank', text: '   ' })).rejects.toMatchObject({ status: 400 });
		} finally {
			await db().delete(projects).where(eq(projects.id, project.id));
			await closeDatabase();
			await environment.restore();
			vi.unstubAllEnvs();
		}
	});
});
