import { error } from '@sveltejs/kit';
import { and, desc, eq, inArray, sql, type SQL } from 'drizzle-orm';
import { db, type Transaction } from '../db';
import * as t from '../db/schema';
import { settleJobTarget } from '../jobs';
import { idSchema } from '../../domain';

export type Material = typeof t.materials.$inferSelect;
export type Job = typeof t.jobs.$inferSelect;

export const jobIsActive = inArray(t.jobs.status, ['queued', 'running']);
export const jobIsInterrupted = inArray(t.jobs.status, ['paused', 'failed', 'cancelled']);
/** Generation jobs keep files under their own id (speech, plans, images), which their output takes over. */
export const JOBS_WITH_FILES = ['audio', 'session', 'quiz', 'lesson'] as const;

export async function findProject(id: string | undefined) {
	const [row] = await db()
		.select()
		.from(t.projects)
		.where(eq(t.projects.id, idSchema.parse(id)));
	if (!row) error(404, 'Project not found.');
	return row;
}
export async function findMaterial(id: string | undefined) {
	const [row] = await db()
		.select()
		.from(t.materials)
		.where(eq(t.materials.id, idSchema.parse(id)));
	if (!row) error(404, 'Source not found.');
	return row;
}
export async function findLibraryEntry(id: string | undefined) {
	const [row] = await db()
		.select()
		.from(t.libraryEntries)
		.where(eq(t.libraryEntries.id, idSchema.parse(id)));
	if (!row) error(404, 'Library item not found.');
	return row;
}

/** Serializes job and source changes per project. Returns false when the project is gone. */
export async function lockProject(tx: Transaction, projectId: string) {
	const [locked] = await tx
		.select({ id: t.projects.id })
		.from(t.projects)
		.where(eq(t.projects.id, projectId))
		.for('update');
	return Boolean(locked);
}
export async function hasActiveJob(tx: Transaction, scope: SQL) {
	const [active] = await tx
		.select({ id: t.jobs.id })
		.from(t.jobs)
		.where(and(scope, jobIsActive))
		.limit(1);
	return Boolean(active);
}

export function isUniqueViolation(value: unknown) {
	return value && typeof value === 'object' && 'code' in value && value.code === '23505';
}
export async function latestMaterialJob(tx: Transaction, materialId: string) {
	const [latest] = await tx
		.select()
		.from(t.jobs)
		.where(eq(t.jobs.materialId, materialId))
		.orderBy(desc(t.jobs.createdAt), desc(t.jobs.id))
		.limit(1);
	return latest;
}

async function checkSourceReaders(tx: Transaction, projectId: string, id: string) {
	if (
		await hasActiveJob(
			tx,
			and(
				eq(t.jobs.projectId, projectId),
				sql`jsonb_exists(${t.jobs.payload} -> 'materialIds', ${id})`
			)!
		)
	)
		error(409, 'Wait until the jobs that use this source are finished.');
}

/** Caller holds the project lock. Both source processing and job retry enter here. */
export async function resumeReview(tx: Transaction, job: Job, payload: Job['payload']) {
	if (job.status === 'queued' || job.status === 'running') return job;
	if (!job.review || !job.materialId || job.status === 'succeeded')
		error(409, 'This review cannot be resumed.');
	await checkSourceReaders(tx, job.projectId, job.materialId);
	const [queued] = await tx
		.update(t.jobs)
		.set({
			status: 'queued',
			progress: 'Waiting to resume',
			resetsAt: null,
			error: null,
			tries: 0,
			payload,
			leaseOwner: null,
			leaseUntil: null,
			updatedAt: new Date()
		})
		.where(and(eq(t.jobs.id, job.id), jobIsInterrupted))
		.returning();
	if (!queued) error(409, 'This review has already changed.');
	await settleJobTarget(tx, job, 'retried');
	return queued;
}

/**
 * Moves a source to `processing` and queues its job, but only from one of the `from` statuses.
 * Returns the already active job when a concurrent request won, or nothing when the source moved on.
 */
export async function enqueueMaterialJob(
	source: Material,
	from: Material['status'][],
	kind: 'ingest' | 'recover',
	payload: Record<string, unknown>
) {
	try {
		return await db().transaction(async (tx) => {
			await lockProject(tx, source.projectId);
			if (kind === 'ingest') {
				const latest = await latestMaterialJob(tx, source.id);
				if (latest?.review && latest.status !== 'succeeded')
					return resumeReview(tx, latest, { ...latest.payload, modelId: payload.modelId });
			}
			await checkSourceReaders(tx, source.projectId, source.id);
			const [changed] = await tx
				.update(t.materials)
				.set({ status: 'processing', updatedAt: new Date() })
				.where(and(eq(t.materials.id, source.id), inArray(t.materials.status, from)))
				.returning();
			if (!changed) return undefined;
			const [job] = await tx
				.insert(t.jobs)
				.values({
					projectId: source.projectId,
					materialId: source.id,
					kind,
					queue: 'background',
					// An extraction that exists stays valid until the new one is saved.
					payload:
						source.status === 'ready' || source.status === 'partial'
							? { ...payload, previous: { status: source.status, notes: source.notes } }
							: payload
				})
				.returning();
			return job;
		});
	} catch (cause) {
		if (!isUniqueViolation(cause)) throw cause;
		const [active] = await db()
			.select()
			.from(t.jobs)
			.where(and(eq(t.jobs.materialId, source.id), jobIsActive))
			.limit(1);
		if (active) return active;
		throw cause;
	}
}
