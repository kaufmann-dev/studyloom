import { error, json, type RequestEvent } from '@sveltejs/kit';
import { and, asc, desc, eq, inArray, isNull, ne } from 'drizzle-orm';
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
	quizSchema,
	libraryInput,
	libraryPatchInput,
	libraryUploadInput,
	pinInput
} from '../domain';
import { ClientError, maxUploadBytes, safeError } from './config';
import { assemble, originalPath, putChunk, removeMaterialFiles } from './storage';
import {
	completeLibraryUpload,
	libraryFilePath,
	putLibraryChunk,
	removeLibraryFiles
} from './library-storage';
import { gradeChoice, sourceSnapshot } from './jobs';
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
async function libraryEntry(id: string) {
	const [entry] = await db()
		.select()
		.from(t.libraryEntries)
		.where(eq(t.libraryEntries.id, idSchema.parse(id)));
	if (!entry) error(404, 'Library item not found.');
	return entry;
}
async function checkLibraryParent(parentId: string | null, movingId?: string) {
	let current = parentId;
	const seen = new Set<string>();
	while (current) {
		if (current === movingId || seen.has(current)) error(409, 'A folder cannot contain itself.');
		seen.add(current);
		const parent = await libraryEntry(current);
		if (parent.kind !== 'folder') error(400, 'Choose a folder as the destination.');
		current = parent.parentId;
	}
}
function publicPin(
	pin: typeof t.pins.$inferSelect,
	target: { name: string; description?: string; kind?: string }
) {
	const project = Boolean(pin.projectId);
	const targetId = pin.projectId ?? pin.libraryId!;
	return {
		id: pin.id,
		targetType: project ? ('project' as const) : ('library' as const),
		targetId,
		label: target.name,
		subtitle: project
			? 'Project'
			: target.kind === 'folder'
				? 'Folder'
				: target.kind === 'file'
					? 'File'
					: target.kind === 'link'
						? 'Link'
						: target.kind === 'contact'
							? 'Contact'
							: 'Note',
		href: project ? `/projects/${targetId}` : `/library/${targetId}`,
		createdAt: pin.createdAt
	};
}
type UploadStatus = 'uploading' | 'failed' | 'partial';
function isUniqueViolation(value: unknown) {
	return value && typeof value === 'object' && 'code' in value && value.code === '23505';
}
async function enqueueFileIngest(
	source: typeof t.materials.$inferSelect,
	modelId: string,
	allowedStatuses: UploadStatus[],
	assembleUpload: boolean
) {
	if (assembleUpload && source.receivedBytes !== source.size) error(409, 'Upload is incomplete.');
	await validateModel(modelId);
	if (assembleUpload) await assemble(source.id);
	try {
		return await db().transaction(async (tx) => {
			await tx
				.select({ id: t.projects.id })
				.from(t.projects)
				.where(eq(t.projects.id, source.projectId))
				.for('update');
			const [changed] = await tx
				.update(t.materials)
				.set({ status: 'processing', updatedAt: new Date() })
				.where(and(eq(t.materials.id, source.id), inArray(t.materials.status, allowedStatuses)))
				.returning();
			if (!changed) return undefined;
			const [job] = await tx
				.insert(t.jobs)
				.values({
					projectId: source.projectId,
					materialId: source.id,
					kind: 'ingest',
					queue: 'background',
					payload: { modelId }
				})
				.returning();
			return job;
		});
	} catch (e) {
		if (!isUniqueViolation(e)) throw e;
		const [active] = await db()
			.select()
			.from(t.jobs)
			.where(and(eq(t.jobs.materialId, source.id), inArray(t.jobs.status, ['queued', 'running'])))
			.limit(1);
		if (active) return active;
		throw e;
	}
}
async function enqueueMaterialJob(
	source: typeof t.materials.$inferSelect,
	statuses: Array<'failed' | 'partial' | 'paused' | 'recording' | 'processing'>,
	kind: 'ingest' | 'recover',
	payload: Record<string, unknown>
) {
	try {
		return await db().transaction(async (tx) => {
			await tx
				.select({ id: t.projects.id })
				.from(t.projects)
				.where(eq(t.projects.id, source.projectId))
				.for('update');
			const [changed] = await tx
				.update(t.materials)
				.set({ status: 'processing', updatedAt: new Date() })
				.where(and(eq(t.materials.id, source.id), inArray(t.materials.status, statuses)))
				.returning();
			if (!changed) return undefined;
			const [job] = await tx
				.insert(t.jobs)
				.values({
					projectId: source.projectId,
					materialId: source.id,
					kind,
					queue: 'background',
					payload
				})
				.returning();
			return job;
		});
	} catch (e) {
		if (!isUniqueViolation(e)) throw e;
		const [active] = await db()
			.select()
			.from(t.jobs)
			.where(and(eq(t.jobs.materialId, source.id), inArray(t.jobs.status, ['queued', 'running'])))
			.limit(1);
		if (active) return active;
		throw e;
	}
}
async function body(event: RequestEvent) {
	const length = Number(event.request.headers.get('content-length') || 0);
	if (length > 1024 * 1024) error(413, 'Request too large.');
	try {
		return JSON.parse(await boundedBody(event.request, 1024 * 1024).then((b) => b.toString()));
	} catch (cause) {
		if (cause instanceof SyntaxError) throw new ClientError(400, 'Invalid JSON request.');
		throw cause;
	}
}
async function museAction<T>(operation: Promise<T>): Promise<T> {
	try {
		return await operation;
	} catch (cause) {
		console.error('Muse request failed:', safeError(cause));
		throw new ClientError(503, 'Muse is unavailable. Check Settings and retry.');
	}
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
	if (!info?.isFile()) error(404, 'File is not ready yet.');
	const contentType =
		/^[A-Za-z0-9][A-Za-z0-9!#$%&'*+.^_`|~-]*\/[A-Za-z0-9][A-Za-z0-9!#$%&'*+.^_`|~-]*$/.test(mime)
			? mime
			: 'application/octet-stream';
	const inline =
		/^(audio\/(wav|mpeg|ogg|webm|mp4|x-m4a|flac)|video\/(mp4|webm)|image\/(png|jpeg|webp)|application\/pdf|text\/plain)$/.test(
			contentType
		) && !event.url.searchParams.has('download');
	const headers: Record<string, string> = {
		'content-type': inline ? contentType : 'application/octet-stream',
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
		if (resource === 'library') {
			if (id === 'folders' && method === 'GET')
				return json({
					folders: await db()
						.select()
						.from(t.libraryEntries)
						.where(eq(t.libraryEntries.kind, 'folder'))
						.orderBy(asc(t.libraryEntries.name))
				});
			if (id === 'uploads' && method === 'POST') {
				const input = libraryUploadInput
					.extend({ size: libraryUploadInput.shape.size.max(maxUploadBytes()) })
					.parse(await body(event));
				await checkLibraryParent(input.parentId);
				const [entry] = await db()
					.insert(t.libraryEntries)
					.values({
						kind: 'file',
						name: input.filename,
						parentId: input.parentId,
						filename: input.filename,
						mimeType: input.mimeType || 'application/octet-stream',
						size: input.size,
						status: 'uploading'
					})
					.returning();
				return json({ entry, chunkSize: UPLOAD_CHUNK_SIZE }, { status: 201 });
			}
			if (!id && method === 'GET') {
				const children = await db()
					.select()
					.from(t.libraryEntries)
					.where(isNull(t.libraryEntries.parentId))
					.orderBy(asc(t.libraryEntries.name));
				return json({ entry: null, children, ancestors: [] });
			}
			if (!id && method === 'POST') {
				const input = libraryInput.parse(await body(event));
				await checkLibraryParent(input.parentId);
				const [entry] = await db()
					.insert(t.libraryEntries)
					.values({
						kind: input.kind,
						name: input.name,
						parentId: input.parentId,
						url: input.kind === 'link' ? input.url : '',
						phone: input.kind === 'contact' ? input.phone : '',
						email: input.kind === 'contact' ? input.email : '',
						website: input.kind === 'contact' ? input.website : '',
						notes: ['link', 'contact'].includes(input.kind) ? input.notes : '',
						text: input.kind === 'note' ? input.text : ''
					})
					.returning();
				return json({ entry }, { status: 201 });
			}
			const entry = await libraryEntry(id);
			if (!action && method === 'GET') {
				const ancestors: { id: string; name: string }[] = [];
				let parentId = entry.parentId;
				while (parentId) {
					const parent = await libraryEntry(parentId);
					ancestors.unshift({ id: parent.id, name: parent.name });
					parentId = parent.parentId;
				}
				const children =
					entry.kind === 'folder'
						? await db()
								.select()
								.from(t.libraryEntries)
								.where(eq(t.libraryEntries.parentId, entry.id))
								.orderBy(asc(t.libraryEntries.name))
						: [];
				return json({ entry, children, ancestors });
			}
			if (!action && method === 'PATCH') {
				const patch = libraryPatchInput.parse(await body(event));
				const parentId = patch.parentId === undefined ? entry.parentId : patch.parentId;
				await checkLibraryParent(parentId, entry.kind === 'folder' ? entry.id : undefined);
				const values =
					entry.kind === 'file'
						? { name: patch.name ?? entry.name, parentId, updatedAt: new Date() }
						: (() => {
								const parsed = libraryInput.parse({ ...entry, ...patch });
								return {
									name: parsed.name,
									parentId,
									url: parsed.kind === 'link' ? parsed.url : '',
									phone: parsed.kind === 'contact' ? parsed.phone : '',
									email: parsed.kind === 'contact' ? parsed.email : '',
									website: parsed.kind === 'contact' ? parsed.website : '',
									notes: ['link', 'contact'].includes(parsed.kind) ? parsed.notes : '',
									text: parsed.kind === 'note' ? parsed.text : '',
									updatedAt: new Date()
								};
							})();
				const [updated] = await db()
					.update(t.libraryEntries)
					.set(values)
					.where(eq(t.libraryEntries.id, entry.id))
					.returning();
				return json({ entry: updated });
			}
			if (!action && method === 'DELETE') {
				const fileIds = await db().transaction(async (tx) => {
					await tx
						.select({ id: t.libraryEntries.id })
						.from(t.libraryEntries)
						.where(eq(t.libraryEntries.id, entry.id))
						.for('update');
					const all = await tx
						.select({
							id: t.libraryEntries.id,
							parentId: t.libraryEntries.parentId,
							kind: t.libraryEntries.kind
						})
						.from(t.libraryEntries);
					const descendants = new Set([entry.id]);
					let changed = true;
					while (changed) {
						changed = false;
						for (const item of all)
							if (item.parentId && descendants.has(item.parentId) && !descendants.has(item.id)) {
								descendants.add(item.id);
								changed = true;
							}
					}
					await tx.delete(t.libraryEntries).where(eq(t.libraryEntries.id, entry.id));
					return all
						.filter((item) => descendants.has(item.id) && item.kind === 'file')
						.map((item) => item.id);
				});
				await removeLibraryFiles(fileIds).catch((cause) =>
					console.error('Library file cleanup failed:', safeError(cause))
				);
				return json({ ok: true });
			}
			if (entry.kind !== 'file') error(404, 'Endpoint not found.');
			if (action === 'file' && method === 'GET') {
				if (entry.status !== 'ready') error(404, 'File is not ready yet.');
				return download(
					event,
					libraryFilePath(entry.id),
					entry.mimeType ?? 'application/octet-stream',
					entry.filename ?? entry.name
				);
			}
			if (action === 'chunks' && method === 'PUT') {
				await putLibraryChunk(
					entry.id,
					Number(seq),
					await boundedBody(event.request, UPLOAD_CHUNK_SIZE)
				);
				return json({ ok: true });
			}
			if (action === 'complete' && method === 'POST')
				return json({ entry: await completeLibraryUpload(entry.id) });
		}
		if (resource === 'pins') {
			if (!id && method === 'GET') {
				const pins = await db()
					.select()
					.from(t.pins)
					.orderBy(desc(t.pins.createdAt), desc(t.pins.id));
				const projects = await db()
					.select({ id: t.projects.id, name: t.projects.name })
					.from(t.projects)
					.where(
						inArray(
							t.projects.id,
							pins.flatMap((pin) => (pin.projectId ? [pin.projectId] : []))
						)
					);
				const entries = await db()
					.select({
						id: t.libraryEntries.id,
						name: t.libraryEntries.name,
						kind: t.libraryEntries.kind
					})
					.from(t.libraryEntries)
					.where(
						inArray(
							t.libraryEntries.id,
							pins.flatMap((pin) => (pin.libraryId ? [pin.libraryId] : []))
						)
					);
				const targets = new Map([...projects, ...entries].map((target) => [target.id, target]));
				return json({
					pins: pins.flatMap((pin) => {
						const target = targets.get(pin.projectId ?? pin.libraryId!);
						return target ? [publicPin(pin, target)] : [];
					})
				});
			}
			if (!id && method === 'POST') {
				const input = pinInput.parse(await body(event));
				const target =
					input.targetType === 'project'
						? await project(input.targetId)
						: await libraryEntry(input.targetId);
				const column = input.targetType === 'project' ? t.pins.projectId : t.pins.libraryId;
				const values =
					input.targetType === 'project'
						? { projectId: input.targetId }
						: { libraryId: input.targetId };
				const [created] = await db()
					.insert(t.pins)
					.values(values)
					.onConflictDoNothing()
					.returning();
				const [pin] = created
					? [created]
					: await db().select().from(t.pins).where(eq(column, input.targetId));
				return json({ pin: publicPin(pin, target) }, { status: created ? 201 : 200 });
			}
			if (id && method === 'DELETE') {
				const [deleted] = await db()
					.delete(t.pins)
					.where(eq(t.pins.id, idSchema.parse(id)))
					.returning();
				if (!deleted) error(404, 'Pin not found.');
				return json({ ok: true });
			}
		}
		if (resource === 'muse') {
			if (method === 'GET') return json(await museAction(museStatus()));
			if (method === 'POST' && id === 'login')
				return json(await museAction(museHost.call('account/loginStart', { type: 'deviceCode' })));
			if (method === 'POST' && id === 'cancel-login')
				return json(await museAction(museHost.call('account/loginCancel')));
			if (method === 'POST' && id === 'logout')
				return json(await museAction(museHost.call('account/logout')));
		}
		if (resource === 'projects') {
			if (!id && method === 'GET')
				return json({
					projects: await db().select().from(t.projects).orderBy(desc(t.projects.updatedAt))
				});
			if (!id && method === 'POST') {
				const input = projectInput.parse(await body(event));
				const [row] = await db()
					.insert(t.projects)
					.values({
						...input,
						name: input.name.trim(),
						description: input.description.trim()
					})
					.returning();
				return json({ project: row }, { status: 201 });
			}
			const row = await project(id);
			if (!action && method === 'GET') {
				const [materials, conversations, outputs, jobs, readableChunks] = await Promise.all([
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
						.limit(100),
					db()
						.select({ materialId: t.sourceChunks.materialId })
						.from(t.sourceChunks)
						.innerJoin(t.materials, eq(t.materials.id, t.sourceChunks.materialId))
						.where(eq(t.materials.projectId, id))
						.groupBy(t.sourceChunks.materialId)
				]);
				return json({
					project: row,
					materials,
					readableMaterialIds: readableChunks.map((chunk) => chunk.materialId),
					conversations,
					outputs: outputs.map(publicOutput),
					jobs: jobs.map(publicJob)
				});
			}
			if (!action && method === 'PATCH') {
				const input = projectInput.parse(await body(event));
				const [project] = await db()
					.update(t.projects)
					.set({
						...input,
						name: input.name.trim(),
						description: input.description.trim(),
						updatedAt: new Date()
					})
					.where(eq(t.projects.id, id))
					.returning();
				return json({ project });
			}
			if (!action && method === 'DELETE') {
				const sources = await db().transaction(async (tx) => {
					const [locked] = await tx
						.select({ id: t.projects.id })
						.from(t.projects)
						.where(eq(t.projects.id, id))
						.for('update');
					if (!locked) error(404, 'Project not found.');
					const [active] = await tx
						.select({ id: t.jobs.id })
						.from(t.jobs)
						.where(and(eq(t.jobs.projectId, id), inArray(t.jobs.status, ['running', 'queued'])))
						.limit(1);
					if (active) error(409, 'Cancel active jobs before deleting.');
					const [recording] = await tx
						.select({ id: t.materials.id })
						.from(t.materials)
						.where(
							and(
								eq(t.materials.projectId, id),
								inArray(t.materials.status, ['recording', 'paused'])
							)
						)
						.limit(1);
					if (recording) error(409, 'Save or stop recording before deleting.');
					const sources = await tx
						.select({ id: t.materials.id })
						.from(t.materials)
						.where(eq(t.materials.projectId, id));
					await tx.delete(t.projects).where(eq(t.projects.id, id));
					return sources;
				});
				for (const result of await Promise.allSettled(
					sources.map((source) => removeMaterialFiles(source.id))
				))
					if (result.status === 'rejected')
						console.error('Project file cleanup failed:', safeError(result.reason));
				return json({ ok: true });
			}
			if (action === 'uploads' && method === 'POST') {
				const input = z
					.object({
						filename: z.string().min(1).max(255),
						mimeType: z
							.string()
							.max(120)
							.regex(
								/^[A-Za-z0-9][A-Za-z0-9!#$%&'*+.^_`|~-]*\/[A-Za-z0-9][A-Za-z0-9!#$%&'*+.^_`|~-]*$/
							)
							.default('application/octet-stream'),
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
				const job = await db().transaction(async (tx) => {
					const [locked] = await tx
						.select({ id: t.projects.id })
						.from(t.projects)
						.where(eq(t.projects.id, id))
						.for('update');
					if (!locked) error(404, 'Project not found.');
					const [job] = await tx
						.insert(t.jobs)
						.values({
							projectId: id,
							kind: input.kind,
							queue: 'background',
							payload: { ...input, snapshot }
						})
						.returning();
					return job;
				});
				return json({ jobId: job.id }, { status: 202 });
			}
			if (action === 'chat' && method === 'POST') {
				const input = chatInput.parse(await body(event));
				await validateModel(input.modelId);
				const snapshot = await sourceSnapshot(id, input.materialIds);
				let conversationId = input.conversationId;
				const job = await db().transaction(async (tx) => {
					await tx
						.select({ id: t.projects.id })
						.from(t.projects)
						.where(eq(t.projects.id, id))
						.for('update');
					if (conversationId) {
						const [conversation] = await tx
							.select()
							.from(t.conversations)
							.where(and(eq(t.conversations.id, conversationId), eq(t.conversations.projectId, id)))
							.for('update');
						if (!conversation) error(404, 'Conversation not found.');
						const [active] = await tx
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
						const [conversation] = await tx
							.insert(t.conversations)
							.values({
								projectId: id,
								title: input.message.trim().slice(0, 120),
								materialIds: input.materialIds,
								modelId: input.modelId
							})
							.returning();
						conversationId = conversation.id;
					}
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
				await db().transaction(async (tx) => {
					const [lockedProject] = await tx
						.select({ id: t.projects.id })
						.from(t.projects)
						.where(eq(t.projects.id, source.projectId))
						.for('update');
					if (!lockedProject) error(404, 'Project not found.');
					const [active] = await tx
						.select({ id: t.jobs.id })
						.from(t.jobs)
						.where(
							and(
								eq(t.jobs.projectId, source.projectId),
								inArray(t.jobs.status, ['running', 'queued'])
							)
						)
						.limit(1);
					if (active) error(409, 'Cancel active jobs before deleting.');
					const [lockedSource] = await tx
						.select({ id: t.materials.id, status: t.materials.status })
						.from(t.materials)
						.where(eq(t.materials.id, id))
						.for('update');
					if (!lockedSource) error(404, 'Source not found.');
					if (['recording', 'paused'].includes(lockedSource.status))
						error(409, 'Save or stop recording before deleting.');
					await tx.delete(t.materials).where(eq(t.materials.id, id));
				});
				await removeMaterialFiles(id).catch((cause) =>
					console.error('Source file cleanup failed:', safeError(cause))
				);
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
				const job = await enqueueFileIngest(source, input.modelId, ['uploading'], true);
				return json({ jobId: job?.id }, { status: 202 });
			}
			if (action === 'retry' && method === 'POST') {
				const input = z
					.object({ modelId: z.string().min(1).max(160).default(DEFAULT_MODEL) })
					.parse(await body(event));
				if (source.kind === 'file') {
					const job = await enqueueFileIngest(
						source,
						input.modelId,
						['uploading', 'failed', 'partial'],
						source.status === 'uploading'
					);
					return json({ jobId: job?.id }, { status: 202 });
				}
				if (!['failed', 'partial'].includes(source.status))
					error(409, 'This source cannot be retried yet.');
				const job = await enqueueMaterialJob(
					source,
					['failed', 'partial'],
					source.kind === 'recording' ? 'recover' : 'ingest',
					{ modelId: input.modelId, finalize: true }
				);
				if (!job) return json({ ok: true });
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
				const job = await db().transaction(async (tx) => {
					await tx
						.select({ id: t.projects.id })
						.from(t.projects)
						.where(eq(t.projects.id, source.projectId))
						.for('update');
					const [current] = await tx
						.select()
						.from(t.materials)
						.where(eq(t.materials.id, id))
						.for('update');
					const [active] = await tx
						.select()
						.from(t.jobs)
						.where(and(eq(t.jobs.materialId, id), inArray(t.jobs.status, ['queued', 'running'])))
						.limit(1);
					if (active) return active;
					if (!current || current.status === 'ready' || current.status === 'partial')
						return undefined;
					await tx
						.update(t.recordingSegments)
						.set({ status: 'interrupted' })
						.where(
							and(eq(t.recordingSegments.materialId, id), eq(t.recordingSegments.status, 'live'))
						);
					const [changed] = await tx
						.update(t.materials)
						.set({ status: 'processing', updatedAt: new Date() })
						.where(
							and(
								eq(t.materials.id, id),
								inArray(t.materials.status, ['paused', 'recording', 'failed', 'processing'])
							)
						)
						.returning();
					if (!changed) return undefined;
					const [created] = await tx
						.insert(t.jobs)
						.values({
							projectId: current.projectId,
							materialId: id,
							kind: 'recover',
							queue: 'background',
							payload: { finalize }
						})
						.returning();
					return created;
				});
				if (!job) return json({ ok: true });
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
				const { attempt, job } = await db().transaction(async (tx) => {
					await tx
						.select({ id: t.projects.id })
						.from(t.projects)
						.where(eq(t.projects.id, output.projectId))
						.for('update');
					const [attempt] = await tx
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
					const [job] = written
						? await tx
								.insert(t.jobs)
								.values({
									projectId: output.projectId,
									kind: 'grade',
									queue: 'interactive',
									attemptId: attempt.id,
									payload: { snapshot: output.sourceSnapshot, modelId: output.modelId }
								})
								.returning()
						: [undefined];
					return { attempt, job };
				});
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
				await db().transaction(async (tx) => {
					const [cancelled] = await tx
						.update(t.jobs)
						.set({
							status: 'cancelled',
							progress: 'Cancelled',
							leaseOwner: null,
							leaseUntil: null,
							updatedAt: new Date()
						})
						.where(and(eq(t.jobs.id, id), inArray(t.jobs.status, ['queued', 'running'])))
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
				return json({ ok: true });
			}
			if (action === 'retry' && method === 'POST') {
				if (!['failed', 'cancelled'].includes(job.status))
					error(409, 'Only failed or cancelled jobs can be retried.');
				await db().transaction(async (tx) => {
					const [retried] = await tx
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
						.where(and(eq(t.jobs.id, id), inArray(t.jobs.status, ['failed', 'cancelled'])))
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
				return json({ jobId: id }, { status: 202 });
			}
		}
		error(404, 'Endpoint not found.');
	} catch (e) {
		if (e instanceof z.ZodError) error(400, e.issues.map((i) => i.message).join('; '));
		if (e instanceof ClientError) error(e.status, e.message);
		throw e;
	}
}
