import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { quizQuestions, quizSchema } from '../domain';
import { closeDatabase, db } from './db';
import { attempts, jobs, outputs, projects } from './db/schema';
import { gradeQuestion } from './grading';
import { useTestDatabase } from './testing';

const citation = { materialId: '00000000-0000-4000-8000-000000000001', locator: 'page:1' };
/** A quiz as it was stored before questions were made of fields. */
const oldQuiz = {
	title: 'Osmosis',
	questions: [
		{
			id: 'q1',
			type: 'multiple_choice',
			question: 'What follows salt?',
			options: ['Air', 'Water'],
			correctAnswer: 'Water',
			rubric: 'The right choice',
			explanation: 'Water moves towards the higher concentration.',
			citations: [citation]
		},
		{
			id: 'q2',
			type: 'written',
			question: 'Explain osmosis.',
			options: [],
			correctAnswer: 'Water crosses a membrane towards more solute.',
			rubric: 'Names the membrane and the direction.',
			explanation: '',
			citations: [citation]
		}
	]
};

describe.skipIf(!process.env.TEST_DATABASE_URL)('Question field migration', () => {
	it('converts stored quizzes, attempts and waiting jobs, and can run twice', async () => {
		const environment = await useTestDatabase('questions');
		const statements = (await readFile('drizzle/0017_question_fields.sql', 'utf8')).split(
			'--> statement-breakpoint'
		);
		const migrate = async () => {
			for (const statement of statements) await db().execute(sql.raw(statement));
		};
		try {
			const [project] = await db().insert(projects).values({ name: 'Biology' }).returning();
			const [output] = await db()
				.insert(outputs)
				.values({
					projectId: project.id,
					kind: 'quiz',
					title: 'Osmosis',
					content: '',
					quiz: oldQuiz as never,
					materialIds: [],
					sourceSnapshot: [],
					modelId: 'default'
				})
				.returning();
			const [graded, waiting] = await db()
				.insert(attempts)
				.values([
					{
						outputId: output.id,
						answers: [
							{ questionId: 'q1', value: 'Water' },
							{ questionId: 'q2', value: 'Water moves.' }
						] as never,
						grades: [
							{
								questionId: 'q1',
								score: 1,
								maxScore: 1,
								feedback: 'Water moves towards the higher concentration.',
								correctAnswer: 'Water',
								citations: [citation]
							},
							{
								questionId: 'q2',
								score: 0,
								maxScore: 1,
								feedback: 'The membrane is missing.',
								correctAnswer: 'Water crosses a membrane towards more solute.',
								citations: [citation]
							}
						] as never,
						score: 1,
						maxScore: 2,
						status: 'complete'
					},
					{
						outputId: output.id,
						answers: [
							{ questionId: 'q1', value: 'Air' },
							{ questionId: 'q2', value: 'It is diffusion of water.' }
						] as never,
						grades: [
							{
								questionId: 'q1',
								score: 0,
								maxScore: 1,
								feedback: '',
								correctAnswer: 'Water',
								citations: [citation]
							}
						] as never,
						maxScore: 2,
						status: 'grading'
					}
				])
				.returning();
			const [job] = await db()
				.insert(jobs)
				.values({
					projectId: project.id,
					kind: 'audio',
					queue: 'background',
					status: 'failed',
					payload: { audioLength: 'long', audioStyle: 'narration', modelId: 'default' }
				})
				.returning();

			await migrate();
			// Converted rows no longer match, so a second run changes nothing.
			await migrate();

			const [converted] = await db().select().from(outputs).where(eq(outputs.id, output.id));
			const quiz = quizSchema.parse(converted.quiz);
			const [choice, written] = quizQuestions(quiz);
			expect(quiz.parts).toHaveLength(1);
			expect(choice).toMatchObject({
				id: 'q1',
				body: 'What follows salt?\n\n{{answer}}',
				fields: [
					{
						id: 'answer',
						type: 'select',
						display: 'radio',
						options: [
							{ id: 'o1', text: 'Air' },
							{ id: 'o2', text: 'Water' }
						],
						correct: 'o2'
					}
				]
			});
			expect(written.fields[0]).toMatchObject({
				type: 'essay',
				modelAnswer: 'Water crosses a membrane towards more solute.',
				rubric: 'Names the membrane and the direction.'
			});

			const stored = await db().select().from(attempts).where(eq(attempts.outputId, output.id));
			const first = stored.find((attempt) => attempt.id === graded.id)!;
			expect(first.answers).toEqual([
				{ questionId: 'q1', values: { answer: 'o2' } },
				{ questionId: 'q2', values: { answer: 'Water moves.' } }
			]);
			// The converted answer grades the same under the new rules.
			expect(gradeQuestion(choice, first.answers[0].values).score).toBe(1);
			expect(first.grades).toMatchObject([
				{ questionId: 'q1', state: 'correct', fields: [{ fieldId: 'answer', expected: 'Water' }] },
				{
					questionId: 'q2',
					state: 'incorrect',
					fields: [{ fieldId: 'answer', feedback: 'The membrane is missing.' }]
				}
			]);
			const second = stored.find((attempt) => attempt.id === waiting.id)!;
			expect(second.answers[0].values).toEqual({ answer: 'o1' });
			// The written answer that was still being graded waits as a pending field.
			expect(second.grades).toMatchObject([
				{ questionId: 'q1', state: 'incorrect' },
				{ questionId: 'q2', state: 'pending', fields: [{ fieldId: 'answer', state: 'pending' }] }
			]);

			const [retryable] = await db().select().from(jobs).where(eq(jobs.id, job.id));
			expect(retryable.payload).toEqual({
				audioStyle: 'narration',
				modelId: 'default',
				coverage: 'standard',
				questionStyles: ['choice', 'embedded', 'written']
			});
		} finally {
			await closeDatabase();
			await environment.restore();
		}
	});
});
