import { error } from '@sveltejs/kit';
import { and, desc, eq, inArray } from 'drizzle-orm';
import type { z } from 'zod';
import { db } from '../db';
import * as t from '../db/schema';
import {
	chatInput,
	generationInput,
	materialUploadInput,
	modelInput,
	projectInput,
	recordingInput,
	UPLOAD_CHUNK_SIZE,
	webSourceInput,
	type AudioVoice
} from '../../domain';
import { ClientError, maxUploadBytes, safeError } from '../config';
import { removeAudioFiles } from '../audio';
import { speechCatalog } from '../elevenlabs';
import { sourceSnapshot } from '../jobs';
import { validateModel } from '../muse';
import { addWebSource } from '../sources';
import { removeMaterialFiles } from '../storage';
import { accepted, created, ok, readJson, type Handler } from './http';
import { findProject, hasActiveJob, lockProject } from './queries';
import { publicJob, publicOutput } from './study';

const cleaned = (input: { name: string; description: string }) => ({
	name: input.name.trim(),
	description: input.description.trim()
});

export const listProjects = () =>
	db().select().from(t.projects).orderBy(desc(t.projects.updatedAt));
export async function createProject(input: z.infer<typeof projectInput>) {
	const [project] = await db().insert(t.projects).values(cleaned(input)).returning();
	return project;
}
/** A project with its sources, conversations, generated outputs and recent jobs. */
export async function projectWorkspace(rawId: string | undefined) {
	const project = await findProject(rawId);
	const id = project.id;
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
	return {
		project,
		materials,
		readableMaterialIds: readableChunks.map((chunk) => chunk.materialId),
		conversations,
		outputs: outputs.map(publicOutput),
		jobs: jobs.map(publicJob)
	};
}

/** The chosen ElevenLabs voices and speech model, checked against what the account offers. */
async function audioChoice(input: z.infer<typeof generationInput>) {
	const dialogue = input.audioStyle === 'dialogue';
	if (!input.voiceId || !input.speechModelId || (dialogue && !input.learnerVoiceId))
		throw new ClientError(400, 'Choose a voice and a speech model.');
	if (dialogue && input.voiceId === input.learnerVoiceId)
		throw new ClientError(400, 'Choose two different voices.');
	const { voices, models } = await speechCatalog();
	const voice = (speaker: AudioVoice['speaker'], voiceId: string): AudioVoice => {
		const found = voices.find((v) => v.voiceId === voiceId);
		if (!found) throw new ClientError(409, 'This voice is no longer available. Reload the page.');
		return { speaker, voiceId, voiceName: found.name };
	};
	const model = models.find((m) => m.modelId === input.speechModelId);
	if (!model)
		throw new ClientError(409, 'This speech model is no longer available. Reload the page.');
	return {
		voices: dialogue
			? [voice('tutor', input.voiceId), voice('learner', input.learnerVoiceId)]
			: [voice('narrator', input.voiceId)],
		speechModelName: model.name
	};
}

export const projects: Handler = async ({ event, method, id: rawId, action }) => {
	if (!rawId && method === 'GET') return Response.json({ projects: await listProjects() });
	if (!rawId && method === 'POST')
		return created({ project: await createProject(projectInput.parse(await readJson(event))) });

	if (!action && method === 'GET') return Response.json(await projectWorkspace(rawId));
	const project = await findProject(rawId);
	const id = project.id;
	if (!action && method === 'PATCH') {
		const input = projectInput.parse(await readJson(event));
		const [updated] = await db()
			.update(t.projects)
			.set({ ...cleaned(input), updatedAt: new Date() })
			.where(eq(t.projects.id, id))
			.returning();
		return Response.json({ project: updated });
	}
	if (!action && method === 'DELETE') {
		const files = await db().transaction(async (tx) => {
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
			const audio = await tx
				.select({ id: t.jobs.id })
				.from(t.jobs)
				.where(and(eq(t.jobs.projectId, id), eq(t.jobs.kind, 'audio')));
			await tx.delete(t.projects).where(eq(t.projects.id, id));
			return { sources, audio };
		});
		for (const result of await Promise.allSettled([
			...files.sources.map((source) => removeMaterialFiles(source.id)),
			...files.audio.map((job) => removeAudioFiles(job.id))
		]))
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
	if (action === 'web-sources' && method === 'POST') {
		const input = webSourceInput.extend(modelInput.shape).parse(await readJson(event));
		const { material, job } = await addWebSource(id, input);
		return accepted({ materialId: material.id, jobId: job.id });
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
		const speech = input.kind === 'audio' ? await audioChoice(input) : {};
		const snapshot = await sourceSnapshot(id, input.materialIds);
		const job = await db().transaction(async (tx) => {
			if (!(await lockProject(tx, id))) error(404, 'Project not found.');
			const [job] = await tx
				.insert(t.jobs)
				.values({
					projectId: id,
					kind: input.kind,
					queue: 'background',
					payload: { ...input, ...speech, snapshot }
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
