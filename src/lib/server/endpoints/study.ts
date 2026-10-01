import { error } from '@sveltejs/kit';
import { and, asc, desc, eq, inArray, ne } from 'drizzle-orm';
import { db } from '../db';
import * as t from '../db/schema';
import { answersSchema, idSchema, quizSchema } from '../../domain';
import { gradeChoice } from '../jobs';
import { validateModel } from '../muse';
import { accepted, ok, readJson, type Handler } from './http';
import { jobIsActive, lockProject, type Job } from './queries';

// Job payloads and source snapshots stay on the server.
export const publicJob = (job: Job) => ({
	id: job.id,
	projectId: job.projectId,
	materialId: job.materialId,
	kind: job.kind,
	status: job.status,
	progress: job.progress,
	error: job.error,
	outputId: job.outputId,
	conversationId: job.conversationId,
	attemptId: job.attemptId,
	createdAt: job.createdAt,
	updatedAt: job.updatedAt
});
export const publicOutput = (output: typeof t.outputs.$inferSelect) => ({
	id: output.id,
	projectId: output.projectId,
	kind: output.kind,
	title: output.title,
	content: output.content,
	quiz: output.quiz,
	citations: output.citations,
	materialIds: output.materialIds,
	modelId: output.modelId,
	createdAt: output.createdAt
});

export const conversations: Handler = async ({ method, id, action }) => {
	if (action || method !== 'GET') return;
	const [conversation] = await db()
		.select()
		.from(t.conversations)
		.where(eq(t.conversations.id, idSchema.parse(id)));
	if (!conversation) error(404);
	return Response.json({
		conversation,
		messages: await db()
			.select()
			.from(t.messages)
			.where(eq(t.messages.conversationId, conversation.id))
			.orderBy(asc(t.messages.createdAt))
	});
};

export const outputs: Handler = async ({ event, method, id, action }) => {
	const [output] = await db()
		.select()
		.from(t.outputs)
		.where(eq(t.outputs.id, idSchema.parse(id)));
	if (!output) error(404);
	if (!action && method === 'GET')
		return Response.json({
			output: publicOutput(output),
			attempts: await db()
				.select()
				.from(t.attempts)
				.where(eq(t.attempts.outputId, output.id))
				.orderBy(desc(t.attempts.createdAt))
		});
	if (action === 'attempts' && method === 'POST') {
		const { answers } = answersSchema.parse(await readJson(event));
		const quiz = quizSchema.parse(output.quiz);
		const questionIds = new Set(quiz.questions.map((question) => question.id));
		if (
			answers.length !== questionIds.size ||
			new Set(answers.map((answer) => answer.questionId)).size !== questionIds.size ||
			answers.some((answer) => !questionIds.has(answer.questionId))
		)
			error(400, 'Answer each question exactly once.');
		const grades = gradeChoice(quiz, answers);
		// Multiple-choice answers are graded here; written answers need a Muse grading job.
		const written = quiz.questions.some((question) => question.type === 'written');
		if (written) await validateModel(output.modelId);
		const { attempt, job } = await db().transaction(async (tx) => {
			await lockProject(tx, output.projectId);
			const [attempt] = await tx
				.insert(t.attempts)
				.values({
					outputId: output.id,
					answers,
					grades,
					maxScore: quiz.questions.length,
					status: written ? 'grading' : 'complete',
					score: written ? null : grades.reduce((sum, grade) => sum + grade.score, 0)
				})
				.returning();
			if (!written) return { attempt, job: undefined };
			const [job] = await tx
				.insert(t.jobs)
				.values({
					projectId: output.projectId,
					kind: 'grade',
					queue: 'interactive',
					attemptId: attempt.id,
					payload: { snapshot: output.sourceSnapshot, modelId: output.modelId }
				})
				.returning();
			return { attempt, job };
		});
		return accepted({ attemptId: attempt.id, jobId: job?.id });
	}
};

export const jobs: Handler = async ({ method, id, action }) => {
	const [job] = await db()
		.select()
		.from(t.jobs)
		.where(eq(t.jobs.id, idSchema.parse(id)));
	if (!job) error(404);
	const released = { leaseOwner: null, leaseUntil: null, updatedAt: new Date() };
	if (!action && method === 'GET') return Response.json({ job: publicJob(job) });
	if (action === 'cancel' && method === 'POST') {
		await db().transaction(async (tx) => {
			const [cancelled] = await tx
				.update(t.jobs)
				.set({ status: 'cancelled', progress: 'Cancelled', ...released })
				.where(and(eq(t.jobs.id, job.id), jobIsActive))
				.returning({ id: t.jobs.id });
			if (!cancelled) return;
			if (job.materialId)
				await tx
					.update(t.materials)
					.set({
						status: job.kind === 'recover' ? 'paused' : 'failed',
						notes: 'Processing was cancelled.',
						updatedAt: new Date()
					})
					.where(eq(t.materials.id, job.materialId));
			if (job.attemptId)
				await tx
					.update(t.attempts)
					.set({ status: 'failed' })
					.where(and(eq(t.attempts.id, job.attemptId), eq(t.attempts.status, 'grading')));
		});
		return ok();
	}
	if (action === 'retry' && method === 'POST') {
		if (job.status !== 'failed' && job.status !== 'cancelled')
			error(409, 'Only failed or cancelled jobs can be retried.');
		await db().transaction(async (tx) => {
			const [retried] = await tx
				.update(t.jobs)
				.set({
					status: 'queued',
					error: null,
					tries: 0,
					progress: 'Waiting to retry',
					...released
				})
				.where(and(eq(t.jobs.id, job.id), inArray(t.jobs.status, ['failed', 'cancelled'])))
				.returning({ id: t.jobs.id });
			if (!retried) return;
			if (job.materialId)
				await tx
					.update(t.materials)
					.set({ status: 'processing', notes: '', updatedAt: new Date() })
					.where(eq(t.materials.id, job.materialId));
			if (job.attemptId)
				await tx
					.update(t.attempts)
					.set({ status: 'grading' })
					.where(and(eq(t.attempts.id, job.attemptId), ne(t.attempts.status, 'complete')));
		});
		return accepted({ jobId: job.id });
	}
};
