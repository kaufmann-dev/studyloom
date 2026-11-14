import { error } from '@sveltejs/kit';
import { and, eq, inArray, type SQL } from 'drizzle-orm';
import { db, type Transaction } from '../db';
import * as t from '../db/schema';
import { idSchema } from '../../domain';

export type Material = typeof t.materials.$inferSelect;
export type Job = typeof t.jobs.$inferSelect;

export const jobIsActive = inArray(t.jobs.status, ['queued', 'running']);

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
					payload
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
