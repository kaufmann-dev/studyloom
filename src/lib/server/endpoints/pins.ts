import { error } from '@sveltejs/kit';
import { desc, eq, inArray } from 'drizzle-orm';
import { db } from '../db';
import * as t from '../db/schema';
import { idSchema, LIBRARY_KIND_LABELS, pinInput, type LibraryKind } from '../../domain';
import { created, ok, readJson, type Handler } from './http';
import { findLibraryEntry, findProject } from './queries';

function publicPin(pin: typeof t.pins.$inferSelect, target: { name: string; kind?: LibraryKind }) {
	return {
		id: pin.id,
		targetType: pin.projectId ? ('project' as const) : ('library' as const),
		targetId: pin.projectId ?? pin.libraryId!,
		label: target.name,
		subtitle: target.kind ? LIBRARY_KIND_LABELS[target.kind] : 'Project',
		createdAt: pin.createdAt
	};
}

export const pins: Handler = async ({ event, method, id }) => {
	if (!id && method === 'GET') {
		const rows = await db().select().from(t.pins).orderBy(desc(t.pins.createdAt), desc(t.pins.id));
		const ids = (key: 'projectId' | 'libraryId') =>
			rows.flatMap((pin) => (pin[key] ? [pin[key]] : []));
		const [projects, entries] = await Promise.all([
			db()
				.select({ id: t.projects.id, name: t.projects.name })
				.from(t.projects)
				.where(inArray(t.projects.id, ids('projectId'))),
			db()
				.select({
					id: t.libraryEntries.id,
					name: t.libraryEntries.name,
					kind: t.libraryEntries.kind
				})
				.from(t.libraryEntries)
				.where(inArray(t.libraryEntries.id, ids('libraryId')))
		]);
		const targets = new Map<string, { name: string; kind?: LibraryKind }>(
			[...projects, ...entries].map((target) => [target.id, target])
		);
		return Response.json({
			pins: rows.flatMap((pin) => {
				const target = targets.get(pin.projectId ?? pin.libraryId!);
				return target ? [publicPin(pin, target)] : [];
			})
		});
	}
	if (!id && method === 'POST') {
		const input = pinInput.parse(await readJson(event));
		const forProject = input.targetType === 'project';
		const target = forProject
			? { name: (await findProject(input.targetId)).name }
			: await findLibraryEntry(input.targetId);
		const [inserted] = await db()
			.insert(t.pins)
			.values(forProject ? { projectId: input.targetId } : { libraryId: input.targetId })
			.onConflictDoNothing()
			.returning();
		const [pin] = inserted
			? [inserted]
			: await db()
					.select()
					.from(t.pins)
					.where(eq(forProject ? t.pins.projectId : t.pins.libraryId, input.targetId));
		return inserted
			? created({ pin: publicPin(pin, target) })
			: Response.json({ pin: publicPin(pin, target) });
	}
	if (id && method === 'DELETE') {
		const [deleted] = await db()
			.delete(t.pins)
			.where(eq(t.pins.id, idSchema.parse(id)))
			.returning();
		if (!deleted) error(404, 'Pin not found.');
		return ok();
	}
};
