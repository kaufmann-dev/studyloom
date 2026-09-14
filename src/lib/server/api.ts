import { error, json, type RequestEvent } from '@sveltejs/kit';
import { and, asc, desc, eq, inArray } from 'drizzle-orm';
import { z } from 'zod';
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { Readable } from 'node:stream';
import { db } from './db';
import * as t from './db/schema';
import {
	projectInput,
	idSchema,
	UPLOAD_CHUNK_SIZE,
	generationInput,
	chatInput,
	answersSchema,
	DEFAULT_MODEL,
	quizSchema
} from '../domain';
import { maxUploadBytes, safeError } from './config';
import { assemble, originalPath, putChunk, removeMaterialFiles } from './storage';
import { enqueue, gradeChoice, sourceSnapshot } from './jobs';
import { museHost, museStatus, validateModel } from './muse';
const publicJob = (j: typeof t.jobs.$inferSelect) => ({
	id: j.id,
	projectId: j.projectId,
	materialId: j.materialId,
	kind: j.kind,
	status: j.status,
	progress: j.progress,
	error: j.error,
	outputId: j.outputId,
	conversationId: j.conversationId,
	attemptId: j.attemptId,
	createdAt: j.createdAt,
	updatedAt: j.updatedAt
});
const publicOutput = (o: typeof t.outputs.$inferSelect) => ({
	id: o.id,
	projectId: o.projectId,
	kind: o.kind,
	title: o.title,
	content: o.content,
	quiz: o.quiz,
	citations: o.citations,
	materialIds: o.materialIds,
	modelId: o.modelId,
	createdAt: o.createdAt
});
async function project(id: string) {
	const [row] = await db()
		.select()
		.from(t.projects)
		.where(eq(t.projects.id, idSchema.parse(id)));
	if (!row) error(404, 'Project not found.');
	return row;
}
async function material(id: string) {
	const [row] = await db()
		.select()
		.from(t.materials)
		.where(eq(t.materials.id, idSchema.parse(id)));
	if (!row) error(404, 'Source not found.');
	return row;
}
async function requireIdle(projectId: string) {
	const [active] = await db()
		.select({ id: t.jobs.id })
		.from(t.jobs)
		.where(and(eq(t.jobs.projectId, projectId), inArray(t.jobs.status, ['running', 'queued'])))
		.limit(1);
	if (active) error(409, 'Cancel active jobs before deleting.');
	const [recording] = await db()
		.select({ id: t.materials.id })
		.from(t.materials)
		.where(and(eq(t.materials.projectId, projectId), eq(t.materials.status, 'recording')))
		.limit(1);
	if (recording) error(409, 'Stop recording before deleting.');
}
async function body(event: RequestEvent) {
	const length = Number(event.request.headers.get('content-length') || 0);
	if (length > 1024 * 1024) error(413, 'Request too large.');
	return JSON.parse(await boundedBody(event.request, 1024 * 1024).then((b) => b.toString()));
}
export async function boundedBody(request: Request, limit: number) {
	if (!request.body) return Buffer.alloc(0);
	const reader = request.body.getReader();
	const parts: Buffer[] = [];
	let size = 0;
	try {
		while (true) {
			const { done, value } = await reader.read();
			if (done) break;
			size += value.length;
			if (size > limit) {
				await reader.cancel();
				error(413, 'Request too large.');
			}
			parts.push(Buffer.from(value));
		}
	} finally {
		reader.releaseLock();
	}
	return Buffer.concat(parts);
}
async function download(event: RequestEvent, path: string, mime: string, name: string) {
	const info = await stat(path).catch(() => null);
	if (!info) error(404, 'File is not ready yet.');
	const inline =
		/^(audio\/(wav|mpeg|ogg|webm|mp4|x-m4a|flac)|video\/(mp4|webm)|image\/(png|jpeg|webp)|application\/pdf|text\/plain)$/.test(
			mime
		) && !event.url.searchParams.has('download');
	const headers: Record<string, string> = {
		'content-type': inline ? mime : 'application/octet-stream',
		'content-disposition': `${inline ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeURIComponent(name)}`,
		'accept-ranges': 'bytes',
		'x-content-type-options': 'nosniff',
		'content-security-policy': "sandbox; default-src 'none'",
		'cache-control': 'private, no-store'
	};
	const range = event.request.headers.get('range');
	let start = 0,
		end = info.size - 1,
		status = 200;
	if (range) {
		const match = /^bytes=(\d*)-(\d*)$/.exec(range);
		if (!match || (!match[1] && !match[2]))
			return new Response(null, {
				status: 416,
				headers: { 'content-range': `bytes */${info.size}` }
			});
		if (!match[1]) start = Math.max(0, info.size - Number(match[2]));
		else {
			start = Number(match[1]);
			if (match[2]) end = Math.min(end, Number(match[2]));
		}
		if (start > end || start >= info.size)
			return new Response(null, {
				status: 416,
				headers: { 'content-range': `bytes */${info.size}` }
			});
		status = 206;
		headers['content-range'] = `bytes ${start}-${end}/${info.size}`;
	}
	headers['content-length'] = String(Math.max(0, end - start + 1));
	return new Response(
		info.size ? (Readable.toWeb(createReadStream(path, { start, end })) as ReadableStream) : null,
		{ status, headers }
	);
}
export async function api(event: RequestEvent) {
	const method = event.request.method;
	const parts = event.url.pathname.slice(5).split('/').filter(Boolean);
	const [resource, id, action, seq] = parts;
	if (resource === 'health' && method === 'GET') return json({ status: 'ok' });
	if (!event.locals.session) error(401, 'Please sign in.');
	try {
		if (resource === 'muse') {
			if (method === 'GET') return json(await museStatus());
			if (method === 'POST' && id === 'login')
				return json(await museHost.call('account/loginStart', { type: 'deviceCode' }));
			if (method === 'POST' && id === 'cancel-login')
				return json(await museHost.call('account/loginCancel'));
			if (method === 'POST' && id === 'logout') return json(await museHost.call('account/logout'));
		}
		if (resource === 'projects') {
			if (!id && method === 'GET')
				return json({
					projects: await db().select().from(t.projects).orderBy(desc(t.projects.updatedAt))
				});
			if (!id && method === 'POST') {
				const [row] = await db()
					.insert(t.projects)
					.values(projectInput.parse(await body(event)))
					.returning();
				return json({ project: row }, { status: 201 });
			}
			const row = await project(id);
			if (!action && method === 'GET') {
				const [materials, conversations, outputs, jobs] = await Promise.all([
					db()
						.select()
						.from(t.materials)
						.where(eq(t.materials.projectId, id))
						.orderBy(desc(t.materials.createdAt)),
					db()
						.select()
						.from(t.conversations)
						.where(eq(t.conversations.projectId, id))
						.orderBy(desc(t.conversations.updatedAt)),
					db()
						.select()
						.from(t.outputs)
						.where(eq(t.outputs.projectId, id))
						.orderBy(desc(t.outputs.createdAt)),
					db()
						.select()
						.from(t.jobs)
						.where(eq(t.jobs.projectId, id))
						.orderBy(desc(t.jobs.createdAt))
						.limit(100)
				]);
				return json({
					project: row,
					materials,
					conversations,
					outputs: outputs.map(publicOutput),
					jobs: jobs.map(publicJob)
				});
			}
			if (!action && method === 'PATCH') {
				const [project] = await db()
					.update(t.projects)
					.set({ ...projectInput.parse(await body(event)), updatedAt: new Date() })
					.where(eq(t.projects.id, id))
					.returning();
				return json({ project });
			}
			if (!action && method === 'DELETE') {
				await requireIdle(id);
				const sources = await db()
					.select({ id: t.materials.id })
					.from(t.materials)
					.where(eq(t.materials.projectId, id));
				await db().delete(t.projects).where(eq(t.projects.id, id));
				await Promise.all(sources.map((s) => removeMaterialFiles(s.id)));
				return json({ ok: true });
			}
			if (action === 'uploads' && method === 'POST') {
				const input = z
					.object({
						filename: z.string().min(1).max(255),
						mimeType: z.string().max(120).default('application/octet-stream'),
						size: z.number().int().positive().max(maxUploadBytes())
					})
					.parse(await body(event));
				const [source] = await db()
					.insert(t.materials)
					.values({
						...input,
						name: input.filename,
						projectId: id,
						kind: 'file',
						status: 'uploading'
					})
					.returning();
				return json({ materialId: source.id, chunkSize: UPLOAD_CHUNK_SIZE }, { status: 201 });
			}
			if (action === 'recordings' && method === 'POST') {
				const input = z
					.object({
						name: z.string().trim().min(1).max(160),
						source: z.enum(['microphone', 'tab', 'both'])
					})
					.parse(await body(event));
				const [source] = await db()
					.insert(t.materials)
					.values({
						name: input.name,
						filename: input.name + '.wav',
						mimeType: 'audio/wav',
						projectId: id,
						kind: 'recording',
						status: 'paused',
						notes: `Captured from ${input.source}.`
					})
					.returning();
				return json({ materialId: source.id }, { status: 201 });
			}
			if (action === 'generate' && method === 'POST') {
				const input = generationInput.parse(await body(event));
				await validateModel(input.modelId);
				const snapshot = await sourceSnapshot(id, input.materialIds);
				const job = await enqueue({
					projectId: id,
					kind: input.kind,
					queue: 'background',
					payload: { ...input, snapshot }
				});
				return json({ jobId: job.id }, { status: 202 });
			}
			if (action === 'chat' && method === 'POST') {
				const input = chatInput.parse(await body(event));
				await validateModel(input.modelId);
				const snapshot = await sourceSnapshot(id, input.materialIds);
				let conversationId = input.conversationId;
				if (conversationId) {
					const [conversation] = await db()
						.select()
						.from(t.conversations)
						.where(and(eq(t.conversations.id, conversationId), eq(t.conversations.projectId, id)));
					if (!conversation) error(404, 'Conversation not found.');
					const [active] = await db()
						.select()
						.from(t.jobs)
						.where(
							and(
								eq(t.jobs.conversationId, conversationId),
								inArray(t.jobs.status, ['queued', 'running'])
							)
						)
						.limit(1);
					if (active) error(409, 'Wait for the current answer or cancel it.');
				} else {
					const [conversation] = await db()
						.insert(t.conversations)
						.values({
							projectId: id,
							title: input.message.slice(0, 120),
							materialIds: input.materialIds,
							modelId: input.modelId
						})
						.returning();
					conversationId = conversation.id;
				}
				const job = await db().transaction(async (tx) => {
					await tx
						.insert(t.messages)
						.values({ conversationId: conversationId!, role: 'user', content: input.message });
					await tx
						.update(t.conversations)
						.set({ materialIds: input.materialIds, modelId: input.modelId, updatedAt: new Date() })
						.where(eq(t.conversations.id, conversationId!));
					const [job] = await tx
						.insert(t.jobs)
						.values({
							projectId: id,
							kind: 'chat',
							queue: 'interactive',
							conversationId,
							payload: { ...input, snapshot }
						})
						.returning();
					return job;
				});
				return json({ jobId: job.id, conversationId }, { status: 202 });
			}
		}
		if (resource === 'materials') {
			const source = await material(id);
			if (!action && method === 'GET') {
				const [chunks, turns, assets] = await Promise.all([
					db()
						.select()
						.from(t.sourceChunks)
						.where(eq(t.sourceChunks.materialId, id))
						.orderBy(asc(t.sourceChunks.ordinal)),
					db()
						.select()
						.from(t.transcriptTurns)
						.where(eq(t.transcriptTurns.materialId, id))
						.orderBy(asc(t.transcriptTurns.startMs)),
					db()
						.select({
							id: t.assets.id,
							materialId: t.assets.materialId,
							label: t.assets.label,
							mimeType: t.assets.mimeType,
							locator: t.assets.locator
						})
						.from(t.assets)
						.where(eq(t.assets.materialId, id))
				]);
				return json({ material: source, chunks, turns, assets });
			}
			if (!action && method === 'DELETE') {
				await requireIdle(source.projectId);
				await db().delete(t.materials).where(eq(t.materials.id, id));
				await removeMaterialFiles(id);
				return json({ ok: true });
			}
			if (action === 'file' && method === 'GET')
				return download(event, originalPath(id), source.mimeType, source.filename);
			if (action === 'chunks' && method === 'PUT') {
				if (source.kind !== 'file') error(400, 'Use recording chunks for audio.');
				await putChunk(id, Number(seq), await boundedBody(event.request, UPLOAD_CHUNK_SIZE));
				return json({ ok: true });
			}
			if (action === 'complete' && method === 'POST') {
				const input = z
					.object({ modelId: z.string().min(1).max(160).default(DEFAULT_MODEL) })
					.parse(await body(event));
				if (source.status !== 'uploading') return json({ ok: true });
				await validateModel(input.modelId);
				if (source.receivedBytes !== source.size) error(409, 'Upload is incomplete.');
				await assemble(id);
				const job = await db().transaction(async (tx) => {
					const [changed] = await tx
						.update(t.materials)
						.set({ status: 'processing', updatedAt: new Date() })
						.where(and(eq(t.materials.id, id), eq(t.materials.status, 'uploading')))
						.returning();
					if (!changed) return undefined;
					const [job] = await tx
						.insert(t.jobs)
						.values({
							projectId: source.projectId,
							materialId: id,
							kind: 'ingest',
							queue: 'background',
							payload: { modelId: input.modelId }
						})
						.returning();
					return job;
				});
				return json({ jobId: job?.id }, { status: 202 });
			}
			if (action === 'retry' && method === 'POST') {
				const input = z
					.object({ modelId: z.string().min(1).max(160).default(DEFAULT_MODEL) })
					.parse(await body(event));
				if (source.kind === 'file') await validateModel(input.modelId);
				if (!['failed', 'partial'].includes(source.status))
					error(409, 'This source cannot be retried yet.');
				await db()
					.update(t.materials)
					.set({ status: 'processing', updatedAt: new Date() })
					.where(eq(t.materials.id, id));
				const job = await enqueue({
					projectId: source.projectId,
					materialId: id,
					kind: source.kind === 'recording' ? 'recover' : 'ingest',
					queue: 'background',
					payload: { modelId: input.modelId, finalize: true }
				});
				return json({ jobId: job.id }, { status: 202 });
			}
		}
		if (resource === 'recordings') {
			const source = await material(id);
			if (source.kind !== 'recording') error(400, 'Not a recording.');
			if (action === 'chunks' && method === 'PUT') {
				await putChunk(
					id,
					Number(seq),
					await boundedBody(event.request, 96000),
					z.coerce
						.number()
						.int()
						.nonnegative()
						.parse(z.string().min(1).parse(event.request.headers.get('x-start-sample')))
				);
				return json({ ok: true });
			}
			if (action === 'recover' && method === 'POST') {
				const { finalize } = z.object({ finalize: z.boolean() }).parse(await body(event));
				const [active] = await db()
					.select()
					.from(t.jobs)
					.where(and(eq(t.jobs.materialId, id), inArray(t.jobs.status, ['queued', 'running'])))
					.limit(1);
				if (active) return json({ jobId: active.id }, { status: 202 });
				if (source.status === 'ready' || source.status === 'partial') return json({ ok: true });
				await db()
					.update(t.recordingSegments)
					.set({ status: 'interrupted' })
					.where(
						and(eq(t.recordingSegments.materialId, id), eq(t.recordingSegments.status, 'live'))
					);
				await db()
					.update(t.materials)
					.set({ status: 'processing', updatedAt: new Date() })
					.where(eq(t.materials.id, id));
				const job = await enqueue({
					projectId: source.projectId,
					materialId: id,
					kind: 'recover',
					queue: 'background',
					payload: { finalize }
				});
				return json({ jobId: job.id }, { status: 202 });
			}
		}
		if (resource === 'assets' && action === 'file' && method === 'GET') {
			const [asset] = await db()
				.select()
				.from(t.assets)
				.where(eq(t.assets.id, idSchema.parse(id)));
			if (!asset) error(404, 'Asset not found.');
			return download(event, asset.path, asset.mimeType, asset.label);
		}
		if (resource === 'conversations' && !action && method === 'GET') {
			const [conversation] = await db()
				.select()
				.from(t.conversations)
				.where(eq(t.conversations.id, idSchema.parse(id)));
			if (!conversation) error(404);
			return json({
				conversation,
				messages: await db()
					.select()
					.from(t.messages)
					.where(eq(t.messages.conversationId, id))
					.orderBy(asc(t.messages.createdAt))
			});
		}
		if (resource === 'outputs') {
			const [output] = await db()
				.select()
				.from(t.outputs)
				.where(eq(t.outputs.id, idSchema.parse(id)));
			if (!output) error(404);
			if (!action && method === 'GET')
				return json({
					output: publicOutput(output),
					attempts: await db()
						.select()
						.from(t.attempts)
						.where(eq(t.attempts.outputId, id))
						.orderBy(desc(t.attempts.createdAt))
				});
			if (action === 'attempts' && method === 'POST') {
				const input = answersSchema.parse(await body(event));
				const quiz = quizSchema.parse(output.quiz);
				if (
					input.answers.length !== quiz.questions.length ||
					new Set(input.answers.map((a) => a.questionId)).size !== quiz.questions.length ||
					input.answers.some((a) => !quiz.questions.some((q) => q.id === a.questionId))
				)
					error(400, 'Answer each question exactly once.');
				const grades = gradeChoice(quiz, input.answers);
				const written = quiz.questions.some((q) => q.type === 'written');
				if (written) await validateModel(output.modelId);
				const [attempt] = await db()
					.insert(t.attempts)
					.values({
						outputId: id,
						answers: input.answers,
						grades,
						maxScore: quiz.questions.length,
						status: written ? 'grading' : 'complete',
						score: written ? null : grades.reduce((s, g) => s + g.score, 0)
					})
					.returning();
				const job = written
					? await enqueue({
							projectId: output.projectId,
							kind: 'grade',
							queue: 'interactive',
							attemptId: attempt.id,
							payload: { snapshot: output.sourceSnapshot, modelId: output.modelId }
						})
					: undefined;
				return json({ attemptId: attempt.id, jobId: job?.id }, { status: 202 });
			}
		}
		if (resource === 'jobs') {
			const [job] = await db()
				.select()
				.from(t.jobs)
				.where(eq(t.jobs.id, idSchema.parse(id)));
			if (!job) error(404);
			if (!action && method === 'GET') return json({ job: publicJob(job) });
			if (action === 'cancel' && method === 'POST') {
				await db()
					.update(t.jobs)
					.set({ status: 'cancelled', progress: 'Cancelled', updatedAt: new Date() })
					.where(and(eq(t.jobs.id, id), inArray(t.jobs.status, ['queued', 'running'])));
				if (job.materialId)
					await db()
						.update(t.materials)
						.set({
							status: job.kind === 'recover' ? 'paused' : 'failed',
							notes: 'Processing was cancelled.',
							updatedAt: new Date()
						})
						.where(eq(t.materials.id, job.materialId));
				return json({ ok: true });
			}
			if (action === 'retry' && method === 'POST') {
				if (!['failed', 'cancelled'].includes(job.status))
					error(409, 'Only failed or cancelled jobs can be retried.');
				await db()
					.update(t.jobs)
					.set({
						status: 'queued',
						error: null,
						tries: 0,
						progress: 'Waiting to retry',
						leaseOwner: null,
						leaseUntil: null,
						updatedAt: new Date()
					})
					.where(eq(t.jobs.id, id));
				if (job.materialId)
					await db()
						.update(t.materials)
						.set({ status: 'processing', notes: '', updatedAt: new Date() })
						.where(eq(t.materials.id, job.materialId));
				if (job.attemptId)
					await db()
						.update(t.attempts)
						.set({ status: 'grading' })
						.where(eq(t.attempts.id, job.attemptId));
				return json({ jobId: id }, { status: 202 });
			}
		}
		error(404, 'Endpoint not found.');
	} catch (e) {
		if (e instanceof z.ZodError) error(400, e.issues.map((i) => i.message).join('; '));
		if (e && typeof e === 'object' && 'status' in e) throw e;
		error(400, safeError(e));
	}
}
