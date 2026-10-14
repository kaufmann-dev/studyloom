import { describe, expect, it, vi } from 'vitest';
import { readFile } from 'node:fs/promises';
import { eq } from 'drizzle-orm';
import { quizSchema, textSourceInput } from '../domain';
import { db, closeDatabase } from './db';
import { projects } from './db/schema';
import { outputDetails } from './endpoints/study';
import { addTextSource, readSource, saveOverview, saveQuiz, searchSources } from './sources';
import { originalPath } from './storage';
import { callApi, useTestDatabase } from './testing';

const filler = (word: string) => `${word} `.repeat(120).trim();

describe.skipIf(!process.env.TEST_DATABASE_URL)('Sources written by MCP clients', () => {
	it('stores, searches, reads and cites text sources', async () => {
		const environment = await useTestDatabase('sources');
		vi.stubEnv('ORIGIN', 'https://studyloom.test');
		const [project] = await db().insert(projects).values({ name: 'Biology' }).returning();
		try {
			expect(() =>
				textSourceInput.parse({
					name: 'Duplicate',
					sections: [
						{ locator: 'a', text: 'One' },
						{ locator: 'a', text: 'Two' }
					]
				})
			).toThrow('unique');
			const { material } = await addTextSource(
				project.id,
				textSourceInput.parse({
					name: 'Lecture notes',
					sections: [
						{ locator: 'section:Intro', text: `Photosynthesis basics. ${filler('light')}` },
						{ locator: 'section:Cells', text: `Chloroplasts hold chlorophyll. ${filler('cell')}` },
						{ locator: 'section:Summary', text: `Energy is stored. ${filler('sugar')}` }
					]
				}),
				'Test client'
			);
			expect(material).toMatchObject({ status: 'ready', notes: 'Added by Test client via MCP.' });
			expect(await readFile(originalPath(material.id), 'utf8')).toContain('## section:Cells');

			const results = await searchSources({
				query: 'chlorophyll',
				projectId: project.id,
				limit: 10
			});
			expect(results).toHaveLength(1);
			expect(results[0]).toMatchObject({ materialId: material.id, locator: 'section:Cells' });
			expect(results[0].snippet).toContain('**chlorophyll**');

			const first = await readSource({ materialId: material.id, offset: 0, maxChars: 1000 });
			expect(first.chunks.map((c) => c.locator)).toEqual(['section:Intro']);
			expect(first).toMatchObject({ totalChunks: 3, nextOffset: 1 });
			const rest = await readSource({
				materialId: material.id,
				locator: 'section:Cells',
				offset: 0,
				maxChars: 100000
			});
			expect(rest).toMatchObject({ offset: 1, nextOffset: null });
			expect(rest.chunks).toHaveLength(2);

			const question = {
				id: 'q1',
				type: 'multiple_choice' as const,
				question: 'What do chloroplasts hold?',
				options: ['Chlorophyll', 'Keratin'],
				correctAnswer: 'Chlorophyll',
				rubric: 'Names chlorophyll.',
				explanation: 'The notes say so.',
				citations: [
					{ materialId: material.id, locator: 'section:Cells', quote: 'hold chlorophyll' }
				]
			};
			const quiz = (citation: Record<string, string>) =>
				quizSchema.parse({
					title: 'Cells',
					questions: [{ ...question, citations: [{ ...question.citations[0], ...citation }] }]
				});
			await expect(
				saveQuiz(project.id, quiz({ locator: 'section:Missing' }), 'Test client')
			).rejects.toMatchObject({ status: 400 });
			await expect(
				saveQuiz(project.id, quiz({ quote: 'invented words' }), 'Test client')
			).rejects.toMatchObject({ status: 400 });
			const saved = await saveQuiz(project.id, quiz({}), 'Test client');
			expect((await outputDetails(saved.id)).output).toMatchObject({
				kind: 'quiz',
				modelId: 'Test client (MCP)',
				materialIds: [material.id]
			});
			const overview = await saveOverview(
				project.id,
				{
					title: 'Overview',
					content: 'Chloroplasts hold chlorophyll.',
					citations: [{ materialId: material.id, locator: 'section:Cells' }]
				},
				'Test client'
			);
			expect(overview).toMatchObject({
				kind: 'summary',
				url: `https://studyloom.test/projects/${project.id}`
			});

			// Multiple-choice quizzes written by a client are graded without Muse.
			const response = await callApi(`/api/outputs/${saved.id}/attempts`, {
				body: { answers: [{ questionId: 'q1', value: 'Chlorophyll' }] }
			});
			expect(response.status).toBe(202);
			const { attempts } = await outputDetails(saved.id);
			expect(attempts[0]).toMatchObject({ status: 'complete', score: 1, maxScore: 1 });
		} finally {
			await db().delete(projects).where(eq(projects.id, project.id));
			await closeDatabase();
			await environment.restore();
			vi.unstubAllEnvs();
		}
	});
});
