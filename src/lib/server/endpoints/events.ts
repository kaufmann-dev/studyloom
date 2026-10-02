import { error } from '@sveltejs/kit';
import { randomUUID } from 'node:crypto';
import { and, asc, eq, getTableColumns, gt, inArray, ne, or, sql, type SQL } from 'drizzle-orm';
import { z } from 'zod';
import { diffDays, isOccurrence } from '../../calendar';
import { db } from '../db';
import * as t from '../db/schema';
import { eventInput, eventPatchInput, exceptionInput, idSchema } from '../../domain';
import { ClientError } from '../config';
import { created, ok, readJson, type Handler } from './http';
import { findProject } from './queries';

const MAX_RANGE_DAYS = 400;
const day = z.iso.date('Enter dates as YYYY-MM-DD.');
const rangeInput = z.object({ from: day, to: day, projectId: idSchema.optional() });
const columns = { ...getTableColumns(t.events), projectName: t.projects.name };

/** Events with the name of their project and their single-occurrence changes. */
export async function selectEvents(where?: SQL) {
	const rows = await db()
		.select(columns)
		.from(t.events)
		.leftJoin(t.projects, eq(t.projects.id, t.events.projectId))
		.where(where)
		.orderBy(asc(t.events.startDate), asc(t.events.createdAt));
	const exceptions = rows.length
		? await db()
				.select()
				.from(t.eventExceptions)
				.where(
					inArray(
						t.eventExceptions.eventId,
						rows.map((row) => row.id)
					)
				)
				.orderBy(asc(t.eventExceptions.occurrenceDate))
		: [];
	return rows.map((row) => ({
		...row,
		exceptions: exceptions
			.filter((exception) => exception.eventId === row.id)
			.map((exception) => ({ ...exception, id: undefined, eventId: undefined }))
	}));
}
type EventRow = Awaited<ReturnType<typeof selectEvents>>[number];

/** The iCalendar identifier stays on the server. */
const publicEvent = (row: EventRow) => ({ ...row, uid: undefined });
async function findEvent(id: string | undefined) {
	const [row] = await selectEvents(eq(t.events.id, idSchema.parse(id)));
	if (!row) error(404, 'Event not found.');
	return row;
}
/** The stored row in the shape the form and the input schema use. */
const asInput = (row: EventRow) => ({
	title: row.title,
	location: row.location,
	notes: row.notes,
	startDate: row.startDate,
	startTime: row.startTime ?? '',
	endDate: row.endDate,
	endTime: row.endTime ?? '',
	repeat: row.repeat,
	repeatUntil: row.repeatUntil ?? '',
	projectId: row.projectId
});
function stored(input: z.infer<typeof eventInput>) {
	return {
		projectId: input.projectId,
		title: input.title.trim(),
		location: input.location,
		notes: input.notes,
		startDate: input.startDate,
		startTime: input.startTime || null,
		endDate: input.endDate,
		endTime: input.endTime || null,
		repeat: input.repeat,
		repeatUntil: input.repeat === 'none' ? null : input.repeatUntil || null
	};
}
/** Everything that touches the range: single events, running series and moved occurrences. */
function touching(from: string, to: string) {
	const e = t.events;
	const x = t.eventExceptions;
	return or(
		and(eq(e.repeat, 'none'), sql`${e.startDate} <= ${to}`, sql`${e.endDate} >= ${from}`),
		and(
			ne(e.repeat, 'none'),
			sql`${e.startDate} <= ${to}`,
			sql`(${e.repeatUntil} is null or ${e.repeatUntil} + (${e.endDate} - ${e.startDate}) >= ${from}::date)`
		),
		sql`exists (select 1 from ${x} where ${x.eventId} = ${e.id} and not ${x.cancelled} and ${x.startDate} <= ${to} and ${x.endDate} >= ${from})`
	);
}

export const events: Handler = async ({ event, method, id, action, seq }) => {
	if (!id && method === 'GET') {
		const range = rangeInput.parse(Object.fromEntries(event.url.searchParams));
		const span = diffDays(range.to, range.from);
		if (span < 0 || span > MAX_RANGE_DAYS)
			throw new ClientError(400, `Choose a range of at most ${MAX_RANGE_DAYS} days.`);
		const rows = await selectEvents(
			and(
				touching(range.from, range.to),
				range.projectId ? eq(t.events.projectId, range.projectId) : undefined
			)
		);
		return Response.json({ events: rows.map(publicEvent) });
	}
	if (!id && method === 'POST') {
		const input = eventInput.parse(await readJson(event));
		if (input.projectId) await findProject(input.projectId);
		const [inserted] = await db()
			.insert(t.events)
			.values({ uid: `${randomUUID()}@studyloom`, ...stored(input) })
			.returning({ id: t.events.id });
		return created({ event: publicEvent(await findEvent(inserted.id)) });
	}
	if (!id) return;

	const row = await findEvent(id);
	if (!action && method === 'PATCH') {
		const patch = eventPatchInput.parse(await readJson(event));
		const input = eventInput.parse({ ...asInput(row), ...patch });
		if (input.projectId) await findProject(input.projectId);
		const next = stored(input);
		await db().transaction(async (tx) => {
			await tx
				.update(t.events)
				.set({ ...next, updatedAt: new Date() })
				.where(eq(t.events.id, row.id));
			// Single-occurrence changes are tied to the dates of the old schedule.
			const rescheduled = next.startDate !== row.startDate || next.repeat !== row.repeat;
			if (rescheduled || next.repeatUntil)
				await tx
					.delete(t.eventExceptions)
					.where(
						and(
							eq(t.eventExceptions.eventId, row.id),
							rescheduled ? undefined : gt(t.eventExceptions.occurrenceDate, next.repeatUntil!)
						)
					);
		});
		return Response.json({ event: publicEvent(await findEvent(row.id)) });
	}
	if (!action && method === 'DELETE') {
		await db().delete(t.events).where(eq(t.events.id, row.id));
		return ok();
	}
	if (action !== 'exceptions') return;

	const date = day.parse(seq);
	const target = and(
		eq(t.eventExceptions.eventId, row.id),
		eq(t.eventExceptions.occurrenceDate, date)
	);
	const touch = (tx: Parameters<Parameters<ReturnType<typeof db>['transaction']>[0]>[0]) =>
		tx.update(t.events).set({ updatedAt: new Date() }).where(eq(t.events.id, row.id));
	if (method === 'PUT') {
		if (row.repeat === 'none' || !isOccurrence(row, date))
			throw new ClientError(400, 'That date is not part of this repeating event.');
		const input = exceptionInput.parse(await readJson(event));
		const change =
			'cancelled' in input
				? {
						cancelled: true,
						title: null,
						location: null,
						notes: null,
						startDate: null,
						startTime: null,
						endDate: null,
						endTime: null
					}
				: {
						cancelled: false,
						title: input.title.trim(),
						location: input.location,
						notes: input.notes,
						startDate: input.startDate,
						startTime: input.startTime || null,
						endDate: input.endDate,
						endTime: input.endTime || null
					};
		await db().transaction(async (tx) => {
			await tx
				.insert(t.eventExceptions)
				.values({ eventId: row.id, occurrenceDate: date, ...change })
				.onConflictDoUpdate({
					target: [t.eventExceptions.eventId, t.eventExceptions.occurrenceDate],
					set: change
				});
			await touch(tx);
		});
		return Response.json({ event: publicEvent(await findEvent(row.id)) });
	}
	if (method === 'DELETE') {
		await db().transaction(async (tx) => {
			await tx.delete(t.eventExceptions).where(target);
			await touch(tx);
		});
		return Response.json({ event: publicEvent(await findEvent(row.id)) });
	}
};
