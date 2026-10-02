import { error } from '@sveltejs/kit';
import { randomUUID } from 'node:crypto';
import { asc, desc, eq, getTableColumns, isNotNull, isNull, sql, type SQL } from 'drizzle-orm';
import { db } from '../db';
import * as t from '../db/schema';
import { idSchema, taskInput, taskPatchInput } from '../../domain';
import { created, ok, readJson, type Handler } from './http';
import { findProject } from './queries';

const DONE_LIMIT = 200;
const columns = { ...getTableColumns(t.tasks), projectName: t.projects.name };

/** Tasks with the name of their project. */
export const selectTasks = (where?: SQL) =>
	db()
		.select(columns)
		.from(t.tasks)
		.leftJoin(t.projects, eq(t.projects.id, t.tasks.projectId))
		.where(where);
type TaskRow = Awaited<ReturnType<typeof selectTasks>>[number];

function publicTask(row: TaskRow) {
	return {
		id: row.id,
		projectId: row.projectId,
		projectName: row.projectName,
		title: row.title,
		notes: row.notes,
		dueDate: row.dueDate,
		dueTime: row.dueTime,
		completedAt: row.completedAt,
		createdAt: row.createdAt,
		updatedAt: row.updatedAt
	};
}
async function findTask(id: string | undefined) {
	const [row] = await selectTasks(eq(t.tasks.id, idSchema.parse(id)));
	if (!row) error(404, 'Task not found.');
	return row;
}

export const tasks: Handler = async ({ event, method, id }) => {
	if (!id && method === 'GET') {
		const rows =
			event.url.searchParams.get('status') === 'done'
				? await selectTasks(isNotNull(t.tasks.completedAt))
						.orderBy(desc(t.tasks.completedAt))
						.limit(DONE_LIMIT)
				: await selectTasks(isNull(t.tasks.completedAt)).orderBy(
						asc(t.tasks.dueDate),
						sql`${t.tasks.dueTime} asc nulls last`,
						asc(t.tasks.createdAt)
					);
		return Response.json({ tasks: rows.map(publicTask) });
	}
	if (!id && method === 'POST') {
		const input = taskInput.parse(await readJson(event));
		if (input.projectId) await findProject(input.projectId);
		const [inserted] = await db()
			.insert(t.tasks)
			.values({
				uid: `${randomUUID()}@studyloom`,
				projectId: input.projectId,
				title: input.title.trim(),
				notes: input.notes,
				dueDate: input.dueDate,
				dueTime: input.dueTime || null
			})
			.returning({ id: t.tasks.id });
		return created({ task: publicTask(await findTask(inserted.id)) });
	}
	if (!id) return;

	const task = await findTask(id);
	if (method === 'PATCH') {
		const patch = taskPatchInput.parse(await readJson(event));
		if (patch.projectId) await findProject(patch.projectId);
		await db()
			.update(t.tasks)
			.set({
				title: patch.title?.trim(),
				notes: patch.notes,
				dueDate: patch.dueDate,
				dueTime: patch.dueTime === undefined ? undefined : patch.dueTime || null,
				projectId: patch.projectId,
				completedAt:
					patch.done === undefined
						? undefined
						: patch.done
							? (task.completedAt ?? new Date())
							: null,
				updatedAt: new Date()
			})
			.where(eq(t.tasks.id, task.id));
		return Response.json({ task: publicTask(await findTask(task.id)) });
	}
	if (method === 'DELETE') {
		await db().delete(t.tasks).where(eq(t.tasks.id, task.id));
		return ok();
	}
};
