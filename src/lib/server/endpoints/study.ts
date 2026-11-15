import { error } from '@sveltejs/kit';
import { and, asc, desc, eq, inArray } from 'drizzle-orm';
import { db } from '../db';
import * as t from '../db/schema';
import {
	answersSchema,
	idSchema,
	quizQuestions,
	quizSchema,
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
	if (!output) error(404, 'Overview, quiz, audio summary or study session not found.');
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
/** An overview, quiz, audio summary or study session with its attempts or runs, newest first. */
export async function outputDetails(id: string | undefined) {
	const output = await findOutput(id);
	return {
		output: publicOutput(output),
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
		const image = output.quiz?.images.find((item) => item.id === seq);
		if (!image) error(404, 'Image not found.');
		return download(event, outputImagePath(output.id, image.id), image.mimeType, image.label);
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
