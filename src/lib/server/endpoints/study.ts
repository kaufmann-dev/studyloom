import { error } from '@sveltejs/kit';
import { and, asc, desc, eq, inArray } from 'drizzle-orm';
import { db } from '../db';
import * as t from '../db/schema';
import {
	answersSchema,
	idSchema,
	lessonQuestions,
	lessonSchema,
	questionAnswerSchema,
	quizQuestions,
	quizSchema,
	type LessonAnswer,
	type StudyAnswer,
	type StudyRun
} from '../../domain';
import { released, settleJobTarget } from '../jobs';
import { gradeQuestion } from '../grading';
import { outputImagePath } from '../outline';
import { gradingModel } from '../claude';
import { audioFile } from '../audio';
import { accepted, download, ok, readJson, type Handler } from './http';
import { isUniqueViolation, jobIsActive, lockProject, type Job } from './queries';

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
	lessonAnswerId: job.lessonAnswerId,
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
	audio: output.audio,
	study: output.study,
	lesson: output.lesson,
	citations: output.citations,
	materialIds: output.materialIds,
	modelId: output.modelId,
	createdAt: output.createdAt
});

/** A conversation with its messages, oldest first. */
export async function conversationDetails(id: string | undefined) {
	const [conversation] = await db()
		.select()
		.from(t.conversations)
		.where(eq(t.conversations.id, idSchema.parse(id)));
	if (!conversation) error(404, 'Conversation not found.');
	return {
		conversation,
		messages: await db()
			.select()
			.from(t.messages)
			.where(eq(t.messages.conversationId, conversation.id))
			.orderBy(asc(t.messages.createdAt))
	};
}
async function findOutput(id: string | undefined) {
	const [output] = await db()
		.select()
		.from(t.outputs)
		.where(eq(t.outputs.id, idSchema.parse(id)));
	if (!output) error(404, 'This study tool was not found.');
	return output;
}
export const publicAnswer = (row: typeof t.studyAnswers.$inferSelect): StudyAnswer => ({
	id: row.id,
	segmentIndex: row.segmentIndex,
	attempt: row.attempt,
	answer: row.answer,
	verdict: row.verdict,
	next: row.next,
	gap: row.gap,
	feedback: row.feedback,
	createdAt: row.createdAt.toISOString()
});
/** A study session's runs with their answers, newest run first and answers in order. */
export async function studyRuns(outputId: string): Promise<StudyRun[]> {
	const runs = await db()
		.select()
		.from(t.studyRuns)
		.where(eq(t.studyRuns.outputId, outputId))
		.orderBy(desc(t.studyRuns.createdAt));
	const answers = runs.length
		? await db()
				.select()
				.from(t.studyAnswers)
				.where(
					inArray(
						t.studyAnswers.runId,
						runs.map((run) => run.id)
					)
				)
				.orderBy(asc(t.studyAnswers.segmentIndex), asc(t.studyAnswers.attempt))
		: [];
	return runs.map((run) => ({
		id: run.id,
		outputId: run.outputId,
		status: run.status,
		segmentIndex: run.segmentIndex,
		attempt: run.attempt,
		createdAt: run.createdAt.toISOString(),
		completedAt: run.completedAt?.toISOString() ?? null,
		answers: answers.filter((answer) => answer.runId === run.id).map(publicAnswer)
	}));
}
export const publicLessonAnswer = (row: typeof t.lessonAnswers.$inferSelect): LessonAnswer => ({
	id: row.id,
	questionId: row.questionId,
	values: row.values,
	result: row.result,
	status: row.status,
	feedback: row.feedback,
	createdAt: row.createdAt.toISOString()
});
/** The newest answer to each question of a lesson: where the learner stands. */
async function lessonAnswers(outputId: string) {
	const rows = await db()
		.select()
		.from(t.lessonAnswers)
		.where(eq(t.lessonAnswers.outputId, outputId))
		.orderBy(desc(t.lessonAnswers.createdAt));
	const newest = new Map<string, LessonAnswer>();
	for (const row of rows)
		if (!newest.has(row.questionId)) newest.set(row.questionId, publicLessonAnswer(row));
	return [...newest.values()];
}
/** An output with what was done with it: quiz attempts, study runs or lesson answers. */
export async function outputDetails(id: string | undefined) {
	const output = await findOutput(id);
	return {
		output: publicOutput(output),
		answers: output.kind === 'lesson' ? await lessonAnswers(output.id) : [],
		attempts: await db()
			.select()
			.from(t.attempts)
			.where(eq(t.attempts.outputId, output.id))
			.orderBy(desc(t.attempts.createdAt)),
		runs: output.kind === 'session' ? await studyRuns(output.id) : []
	};
}

export const conversations: Handler = async ({ method, id, action }) => {
	if (action || method !== 'GET') return;
	return Response.json(await conversationDetails(id));
};

export const outputs: Handler = async ({ event, method, id, action, seq }) => {
	if (!action && method === 'GET') return Response.json(await outputDetails(id));
	const output = await findOutput(id);
	if (action === 'audio' && method === 'GET') {
		if (output.kind !== 'audio') error(404, 'This output has no audio.');
		return download(event, audioFile(output.id), 'audio/mpeg', `${output.title}.mp3`);
	}
	if (action === 'runs' && method === 'POST') {
		if (output.kind !== 'session') error(404, 'This output is not a study session.');
		// Resuming continues the open run, so its position and answers carry over.
		const run = await db().transaction(async (tx) => {
			await lockProject(tx, output.projectId);
			const [active] = await tx
				.select({ id: t.studyRuns.id })
				.from(t.studyRuns)
				.where(and(eq(t.studyRuns.outputId, output.id), eq(t.studyRuns.status, 'active')))
				.limit(1);
			if (active) return active;
			const [created] = await tx
				.insert(t.studyRuns)
				.values({ outputId: output.id })
				.returning({ id: t.studyRuns.id });
			return created;
		});
		return Response.json({ runId: run.id });
	}
	if (action === 'images' && method === 'GET') {
		// The id is looked up in the output's own list and never becomes part of a path unchecked.
		const images = output.quiz?.images ?? output.lesson?.lesson.images ?? [];
		const image = images.find((item) => item.id === seq);
		if (!image) error(404, 'Image not found.');
		return download(event, outputImagePath(output.id, image.id), image.mimeType, image.label);
	}
	if (action === 'answers' && method === 'DELETE') {
		if (output.kind !== 'lesson') error(404, 'This output is not a lesson.');
		// Starting over forgets every answer; grading that is still running has nothing to save to.
		await db().delete(t.lessonAnswers).where(eq(t.lessonAnswers.outputId, output.id));
		return ok();
	}
	if (action === 'answers' && method === 'POST') {
		if (!output.lesson) error(404, 'This output is not a lesson.');
		const answer = questionAnswerSchema.parse(await readJson(event));
		const question = lessonQuestions(lessonSchema.parse(output.lesson.lesson)).find(
			(item) => item.id === answer.questionId
		);
		if (!question) error(404, 'Question not found.');
		// Everything but free text is graded here and now, without Claude.
		const result = gradeQuestion(question, answer.values);
		const written = result.state === 'pending';
		const modelId = written ? await gradingModel(output.modelId) : output.modelId;
		const saved = await db().transaction(async (tx) => {
			await lockProject(tx, output.projectId);
			const [row] = await tx
				.insert(t.lessonAnswers)
				.values({
					outputId: output.id,
					questionId: question.id,
					values: answer.values,
					result,
					score: result.score,
					maxScore: result.maxScore,
					status: written ? 'grading' : 'graded'
				})
				.returning();
			if (!written) return { row, job: undefined };
			const [job] = await tx
				.insert(t.jobs)
				.values({
					projectId: output.projectId,
					kind: 'grade',
					queue: 'interactive',
					lessonAnswerId: row.id,
					payload: { snapshot: output.sourceSnapshot, modelId }
				})
				.returning();
			return { row, job };
		});
		return accepted({ answer: publicLessonAnswer(saved.row), jobId: saved.job?.id });
	}
	if (action === 'attempts' && method === 'POST') {
		const { answers } = answersSchema.parse(await readJson(event));
		const quiz = quizSchema.parse(output.quiz);
		const questions = quizQuestions(quiz);
		const given = new Map(answers.map((answer) => [answer.questionId, answer.values]));
		if (
			given.size !== answers.length ||
			answers.some((a) => !questions.some((q) => q.id === a.questionId))
		)
			error(400, 'Answer each question at most once.');
		// Everything but free text is graded here; a question left open scores nothing.
		const grades = questions.map((question) => gradeQuestion(question, given.get(question.id)));
		const written = grades.some((grade) => grade.state === 'pending');
		const modelId = written ? await gradingModel(output.modelId) : output.modelId;
		const { attempt, job } = await db().transaction(async (tx) => {
			await lockProject(tx, output.projectId);
			const [attempt] = await tx
				.insert(t.attempts)
				.values({
					outputId: output.id,
					answers,
					grades,
					maxScore: grades.reduce((sum, grade) => sum + grade.maxScore, 0),
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
					payload: { snapshot: output.sourceSnapshot, modelId }
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
	if (!action && method === 'GET') return Response.json({ job: publicJob(job) });
	if (action === 'cancel' && method === 'POST') {
		await db().transaction(async (tx) => {
			const [cancelled] = await tx
				.update(t.jobs)
				.set({ status: 'cancelled', progress: 'Cancelled', ...released() })
				.where(and(eq(t.jobs.id, job.id), jobIsActive))
				.returning({ id: t.jobs.id });
			if (cancelled) await settleJobTarget(tx, job, 'cancelled', 'Processing was cancelled.');
		});
		return ok();
	}
	if (action === 'retry' && method === 'POST') {
		if (job.status !== 'failed' && job.status !== 'cancelled')
			error(409, 'Only failed or cancelled jobs can be retried.');
		try {
			await db().transaction(async (tx) => {
				const [retried] = await tx
					.update(t.jobs)
					.set({
						status: 'queued',
						error: null,
						tries: 0,
						progress: 'Waiting to retry',
						...released()
					})
					.where(and(eq(t.jobs.id, job.id), inArray(t.jobs.status, ['failed', 'cancelled'])))
					.returning({ id: t.jobs.id });
				if (retried) await settleJobTarget(tx, job, 'retried');
			});
		} catch (cause) {
			// Only one job per source may be active; a newer one is already working on it.
			if (isUniqueViolation(cause)) error(409, 'This source is already being processed.');
			throw cause;
		}
		return accepted({ jobId: job.id });
	}
};
