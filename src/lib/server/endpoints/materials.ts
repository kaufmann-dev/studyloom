import { error } from '@sveltejs/kit';
import { and, asc, eq, inArray, or, sql } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '../db';
import * as t from '../db/schema';
import { idSchema, modelInput, processInput, UPLOAD_CHUNK_SIZE } from '../../domain';
import { safeError } from '../config';
import { validateModel } from '../claude';
import { assemble, originalPath, putChunk, removeMaterialFiles } from '../storage';
import { accepted, boundedBody, download, ok, readJson, type Handler } from './http';
import {
	enqueueMaterialJob,
	findMaterial,
	hasActiveJob,
	jobIsActive,
	lockProject,
	type Material
} from './queries';

const MAX_PCM_CHUNK_BYTES = 96000;
const recoverInput = z.object({ finalize: z.boolean() });
const startSampleHeader = z.coerce.number().int().nonnegative();

/** Queues extraction for an uploaded file, assembling its chunks first when still uploading. */
async function enqueueFileIngest(
	source: Material,
	modelId: string,
	from: Material['status'][],
	assembleUpload: boolean
) {
	if (assembleUpload && source.receivedBytes !== source.size) error(409, 'Upload is incomplete.');
	await validateModel(modelId);
	if (assembleUpload) await assemble(source.id);
	return enqueueMaterialJob(source, from, 'ingest', { modelId });
}

export const materials: Handler = async ({ event, method, id: rawId, action, seq }) => {
	const source = await findMaterial(rawId);
	const id = source.id;
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
		return Response.json({ material: source, chunks, turns, assets });
	}
	if (!action && method === 'DELETE') {
		await db().transaction(async (tx) => {
			if (!(await lockProject(tx, source.projectId))) error(404, 'Project not found.');
			// Jobs on other sources go on; one that reads this source must end first.
			const usesSource = or(
				eq(t.jobs.materialId, id),
				sql`jsonb_exists(${t.jobs.payload} -> 'materialIds', ${id})`
			)!;
			if (await hasActiveJob(tx, and(eq(t.jobs.projectId, source.projectId), usesSource)!))
				error(409, 'Cancel the jobs that use this source before deleting it.');
			const [locked] = await tx
				.select({ status: t.materials.status })
				.from(t.materials)
				.where(eq(t.materials.id, id))
				.for('update');
			if (!locked) error(404, 'Source not found.');
			if (locked.status === 'recording' || locked.status === 'paused')
				error(409, 'Save or stop recording before deleting.');
			await tx.delete(t.materials).where(eq(t.materials.id, id));
		});
		await removeMaterialFiles(id).catch((cause) =>
			console.error('Source file cleanup failed:', safeError(cause))
		);
		return ok();
	}
	if (action === 'file' && method === 'GET')
		return download(event, originalPath(id), source.mimeType, source.filename);
	if (action === 'chunks' && method === 'PUT') {
		if (source.kind !== 'file') error(400, 'Use recording chunks for audio.');
		await putChunk(id, Number(seq), await boundedBody(event.request, UPLOAD_CHUNK_SIZE));
		return ok();
	}
	if (action === 'complete' && method === 'POST') {
		const { modelId, process } = processInput.parse(await readJson(event));
		if (source.status !== 'uploading') return ok();
		if (process) {
			const job = await enqueueFileIngest(source, modelId, ['uploading'], true);
			return accepted({ jobId: job?.id });
		}
		// Kept as it is: the file is whole and waits until processing is asked for.
		if (source.receivedBytes !== source.size) error(409, 'Upload is incomplete.');
		await assemble(id);
		await db()
			.update(t.materials)
			.set({ status: 'stored', updatedAt: new Date() })
			.where(and(eq(t.materials.id, id), eq(t.materials.status, 'uploading')));
		return ok();
	}
	if (action === 'process' && method === 'POST') {
		const { modelId } = modelInput.parse(await readJson(event));
		if (source.kind === 'file') {
			// Also starts over on a source that is already extracted.
			const job = await enqueueFileIngest(
				source,
				modelId,
				['uploading', 'stored', 'failed', 'partial', 'ready'],
				source.status === 'uploading'
			);
			return accepted({ jobId: job?.id });
		}
		if (source.status !== 'failed' && source.status !== 'partial')
			error(409, 'This source cannot be processed yet.');
		const job = await enqueueMaterialJob(source, ['failed', 'partial'], 'recover', {
			modelId,
			finalize: true
		});
		return job ? accepted({ jobId: job.id }) : ok();
	}
};

export const recordings: Handler = async ({ event, method, id: rawId, action, seq }) => {
	const source = await findMaterial(rawId);
	const id = source.id;
	if (source.kind !== 'recording') error(400, 'Not a recording.');
	if (action === 'chunks' && method === 'PUT') {
		await putChunk(
			id,
			Number(seq),
			await boundedBody(event.request, MAX_PCM_CHUNK_BYTES),
			startSampleHeader.parse(z.string().min(1).parse(event.request.headers.get('x-start-sample')))
		);
		return ok();
	}
	if (action === 'recover' && method === 'POST') {
		const { finalize } = recoverInput.parse(await readJson(event));
		const job = await db().transaction(async (tx) => {
			await lockProject(tx, source.projectId);
			const [current] = await tx
				.select()
				.from(t.materials)
				.where(eq(t.materials.id, id))
				.for('update');
			const [active] = await tx
				.select()
				.from(t.jobs)
				.where(and(eq(t.jobs.materialId, id), jobIsActive))
				.limit(1);
			if (active) return active;
			if (!current || current.status === 'ready' || current.status === 'partial') return undefined;
			await tx
				.update(t.recordingSegments)
				.set({ status: 'interrupted' })
				.where(and(eq(t.recordingSegments.materialId, id), eq(t.recordingSegments.status, 'live')));
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
			const [queued] = await tx
				.insert(t.jobs)
				.values({
					projectId: current.projectId,
					materialId: id,
					kind: 'recover',
					queue: 'background',
					payload: { finalize }
				})
				.returning();
			return queued;
		});
		return job ? accepted({ jobId: job.id }) : ok();
	}
};

export const assets: Handler = async ({ event, method, id, action }) => {
	if (action !== 'file' || method !== 'GET') return;
	const [asset] = await db()
		.select()
		.from(t.assets)
		.where(eq(t.assets.id, idSchema.parse(id)));
	if (!asset) error(404, 'Asset not found.');
	return download(event, asset.path, asset.mimeType, asset.label);
};
