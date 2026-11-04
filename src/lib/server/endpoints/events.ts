import { error } from '@sveltejs/kit';
import { randomUUID } from 'node:crypto';
import { and, asc, eq, getTableColumns, gt, inArray, ne, or, sql, type SQL } from 'drizzle-orm';
import { z } from 'zod';
import { cancelledOccurrence, diffDays, isOccurrence } from '../../calendar';
import { db, type Transaction } from '../db';
import * as t from '../db/schema';
import { eventInput, eventPatchInput, exceptionInput, idSchema } from '../../domain';
import { ClientError } from '../config';
import { created, ok, readJson, type Handler } from './http';
import { findProject } from './queries';

const MAX_RANGE_DAYS = 400;
const day = z.iso.date('Enter dates as YYYY-MM-DD.');
export const rangeInput = z.object({ from: day, to: day, projectId: idSchema.optional() });
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
/** An event that can be changed here; Moodle events change only in Moodle. */
async function findOwnEvent(id: string | undefined) {
	const row = await findEvent(id);
	if (row.source === 'moodle')
		throw new ClientError(409, 'Moodle events can only be changed in Moodle.');
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

/** Event series touching the range, with their single-occurrence changes. */
export async function listEvents(range: z.infer<typeof rangeInput>) {
	const span = diffDays(range.to, range.from);
	if (span < 0 || span > MAX_RANGE_DAYS)
		throw new ClientError(400, `Choose a range of at most ${MAX_RANGE_DAYS} days.`);
	const rows = await selectEvents(
		and(
			touching(range.from, range.to),
			range.projectId ? eq(t.events.projectId, range.projectId) : undefined
		)
	);
	return rows.map(publicEvent);
}
export async function createEvent(input: z.infer<typeof eventInput>) {
	if (input.projectId) await findProject(input.projectId);
	const [inserted] = await db()
		.insert(t.events)
		.values({ uid: `${randomUUID()}@studyloom`, ...stored(input) })
		.returning({ id: t.events.id });
	return publicEvent(await findEvent(inserted.id));
}
/** Changes the whole series. A new start date or repeat drops its single-occurrence changes. */
export async function updateEvent(id: string | undefined, patch: z.infer<typeof eventPatchInput>) {
	const row = await findOwnEvent(id);
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
	return publicEvent(await findEvent(row.id));
}
export async function deleteEvent(id: string | undefined) {
	const row = await findOwnEvent(id);
	await db().delete(t.events).where(eq(t.events.id, row.id));
}
const touch = (tx: Transaction, id: string) =>
	tx.update(t.events).set({ updatedAt: new Date() }).where(eq(t.events.id, id));
/** Cancels or changes one occurrence of a repeating event. */
export async function setOccurrence(
	id: string | undefined,
	occurrenceDate: string | undefined,
	input: z.infer<typeof exceptionInput>
) {
	const row = await findOwnEvent(id);
	const date = day.parse(occurrenceDate);
	if (row.repeat === 'none' || !isOccurrence(row, date))
		throw new ClientError(400, 'That date is not part of this repeating event.');
	const change =
		'cancelled' in input
			? cancelledOccurrence(date)
			: {
					occurrenceDate: date,
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
			.values({ eventId: row.id, ...change })
			.onConflictDoUpdate({
				target: [t.eventExceptions.eventId, t.eventExceptions.occurrenceDate],
				set: change
			});
		await touch(tx, row.id);
	});
	return publicEvent(await findEvent(row.id));
}
/** Drops the change to one occurrence, restoring it as the series defines it. */
export async function restoreOccurrence(
	id: string | undefined,
	occurrenceDate: string | undefined
) {
	const row = await findOwnEvent(id);
	const date = day.parse(occurrenceDate);
	await db().transaction(async (tx) => {
		await tx
			.delete(t.eventExceptions)
			.where(
				and(eq(t.eventExceptions.eventId, row.id), eq(t.eventExceptions.occurrenceDate, date))
			);
		await touch(tx, row.id);
	});
	return publicEvent(await findEvent(row.id));
}

export const events: Handler = async ({ event, method, id, action, seq }) => {
	if (!id && method === 'GET')
		return Response.json({
			events: await listEvents(rangeInput.parse(Object.fromEntries(event.url.searchParams)))
		});
	if (!id && method === 'POST')
		return created({ event: await createEvent(eventInput.parse(await readJson(event))) });
	if (!id) return;
	if (!action && method === 'PATCH')
		return Response.json({
			event: await updateEvent(id, eventPatchInput.parse(await readJson(event)))
		});
	if (!action && method === 'DELETE') {
		await deleteEvent(id);
		return ok();
	}
	if (action !== 'exceptions') return;
	if (method === 'PUT')
		return Response.json({
			event: await setOccurrence(id, seq, exceptionInput.parse(await readJson(event)))
		});
	if (method === 'DELETE') return Response.json({ event: await restoreOccurrence(id, seq) });
};
