import { error, json } from '@sveltejs/kit';
import { and, desc, eq, inArray } from 'drizzle-orm';
import { db } from '../db';
import * as t from '../db/schema';
import {
	chatInput,
	generationInput,
	materialUploadInput,
	projectInput,
	recordingInput,
	UPLOAD_CHUNK_SIZE
} from '../../domain';
import { maxUploadBytes, safeError } from '../config';
import { sourceSnapshot } from '../jobs';
import { validateModel } from '../muse';
import { removeMaterialFiles } from '../storage';
import { accepted, created, ok, readJson, type Handler } from './http';
import { findProject, hasActiveJob, lockProject } from './queries';
import { publicJob, publicOutput } from './study';

const cleaned = (input: { name: string; description: string }) => ({
	name: input.name.trim(),
	description: input.description.trim()
});

export const projects: Handler = async ({ event, method, id: rawId, action }) => {
	if (!rawId && method === 'GET')
		return json({
			projects: await db().select().from(t.projects).orderBy(desc(t.projects.updatedAt))
		});
	if (!rawId && method === 'POST') {
		const input = projectInput.parse(await readJson(event));
		const [project] = await db().insert(t.projects).values(cleaned(input)).returning();
		return created({ project });
	}

	const project = await findProject(rawId);
	const id = project.id;
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
			project,
			materials,
			readableMaterialIds: readableChunks.map((chunk) => chunk.materialId),
			conversations,
			outputs: outputs.map(publicOutput),
			jobs: jobs.map(publicJob)
		});
	}
	if (!action && method === 'PATCH') {
		const input = projectInput.parse(await readJson(event));
		const [updated] = await db()
			.update(t.projects)
			.set({ ...cleaned(input), updatedAt: new Date() })
			.where(eq(t.projects.id, id))
			.returning();
		return json({ project: updated });
	}
	if (!action && method === 'DELETE') {
		const sources = await db().transaction(async (tx) => {
			if (!(await lockProject(tx, id))) error(404, 'Project not found.');
			if (await hasActiveJob(tx, eq(t.jobs.projectId, id)))
				error(409, 'Cancel active jobs before deleting.');
			const [recording] = await tx
				.select({ id: t.materials.id })
				.from(t.materials)
				.where(
					and(eq(t.materials.projectId, id), inArray(t.materials.status, ['recording', 'paused']))
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
		return ok();
	}
	if (action === 'uploads' && method === 'POST') {
		const input = materialUploadInput
			.extend({ size: materialUploadInput.shape.size.max(maxUploadBytes()) })
			.parse(await readJson(event));
		const [source] = await db()
			.insert(t.materials)
			.values({ ...input, name: input.filename, projectId: id, kind: 'file', status: 'uploading' })
			.returning();
		return created({ materialId: source.id, chunkSize: UPLOAD_CHUNK_SIZE });
	}
	if (action === 'recordings' && method === 'POST') {
		const input = recordingInput.parse(await readJson(event));
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
		return created({ materialId: source.id });
	}
	if (action === 'generate' && method === 'POST') {
		const input = generationInput.parse(await readJson(event));
		await validateModel(input.modelId);
		const snapshot = await sourceSnapshot(id, input.materialIds);
		const job = await db().transaction(async (tx) => {
			if (!(await lockProject(tx, id))) error(404, 'Project not found.');
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
		return accepted({ jobId: job.id });
	}
	if (action === 'chat' && method === 'POST') {
		const input = chatInput.parse(await readJson(event));
		await validateModel(input.modelId);
		const snapshot = await sourceSnapshot(id, input.materialIds);
		const selection = { materialIds: input.materialIds, modelId: input.modelId };
		const { job, conversationId } = await db().transaction(async (tx) => {
			await lockProject(tx, id);
			let conversationId = input.conversationId;
			if (conversationId) {
				const [conversation] = await tx
					.select()
					.from(t.conversations)
					.where(and(eq(t.conversations.id, conversationId), eq(t.conversations.projectId, id)))
					.for('update');
				if (!conversation) error(404, 'Conversation not found.');
				if (await hasActiveJob(tx, eq(t.jobs.conversationId, conversationId)))
					error(409, 'Wait for the current answer or cancel it.');
				await tx
					.update(t.conversations)
					.set({ ...selection, updatedAt: new Date() })
					.where(eq(t.conversations.id, conversationId));
			} else {
				const [conversation] = await tx
					.insert(t.conversations)
					.values({ projectId: id, title: input.message.trim().slice(0, 120), ...selection })
					.returning();
				conversationId = conversation.id;
			}
			await tx.insert(t.messages).values({ conversationId, role: 'user', content: input.message });
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
			return { job, conversationId };
		});
		return accepted({ jobId: job.id, conversationId });
	}
};
