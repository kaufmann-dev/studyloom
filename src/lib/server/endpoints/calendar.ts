import { error } from '@sveltejs/kit';
import { randomBytes } from 'node:crypto';
import { and, eq, inArray, isNull, sql } from 'drizzle-orm';
import { isTimeZone } from '../../calendar';
import { db, type Transaction } from '../db';
import * as t from '../db/schema';
import { feedInput, importInput, moodleInput, type ImportSummary } from '../../domain';
import { ClientError, origin } from '../config';
import { buildExport, buildFeed } from '../ics';
import { parseIcs, type ParsedCalendar } from '../ics-import';
import { connectMoodle, disconnectMoodle, moodleStatus, syncMoodle } from '../moodle';
import { selectEvents } from './events';
import { ok, readJson, type Handler } from './http';
import { findProject } from './queries';
import { feedbackFields, selectTasks } from './tasks';

const TOKEN = /^[A-Za-z0-9_-]{43}$/;
const BATCH = 500;
const FEED_ID = 1;

const calendarResponse = (body: string, headers: Record<string, string> = {}) =>
	new Response(body, {
		headers: {
			'content-type': 'text/calendar; charset=utf-8',
			'cache-control': 'private, no-store',
			...headers
		}
	});
function timeZoneOf(input: { timeZone: string }) {
	if (!isTimeZone(input.timeZone)) throw new ClientError(400, 'Choose a valid time zone.');
	return input.timeZone;
}
async function feedSettings() {
	const [row] = await db().select().from(t.calendarFeed);
	return {
		url: row?.token ? `${origin()}/feed/${row.token}/studyloom.ics` : null,
		timeZone: row?.timeZone ?? null
	};
}

/** The subscription feed for a secret token, or nothing when the token is unknown. */
export async function feedResponse(token: string) {
	if (!TOKEN.test(token)) return undefined;
	const [feed] = await db().select().from(t.calendarFeed).where(eq(t.calendarFeed.token, token));
	if (!feed) return undefined;
	const [events, tasks] = await Promise.all([
		selectEvents(),
		selectTasks(isNull(t.tasks.completedAt))
	]);
	return calendarResponse(
		buildFeed({
			events,
			tasks: tasks.map((row) => ({ ...row, ...feedbackFields(row) })),
			timeZone: feed.timeZone,
			now: new Date()
		}),
		{
			'x-robots-tag': 'noindex'
		}
	);
}

function batches<T>(items: T[]) {
	return Array.from({ length: Math.ceil(items.length / BATCH) }, (_, index) =>
		items.slice(index * BATCH, (index + 1) * BATCH)
	);
}
const excluded = (column: { name: string }) => sql.raw(`excluded."${column.name}"`);

/** Writes imported items, replacing the ones whose identifier is already stored. */
async function store(tx: Transaction, parsed: ParsedCalendar, projectId: string | null) {
	const now = new Date();
	// An import into a project moves existing items there; otherwise they stay where they are.
	const project = <T extends object>(set: T, column: { name: string }) =>
		projectId ? { ...set, projectId: excluded(column) } : set;
	for (const batch of batches(parsed.events)) {
		const e = t.events;
		const rows = await tx
			.insert(e)
			.values(batch.map((event) => ({ ...event, exceptions: undefined, projectId })))
			.onConflictDoUpdate({
				target: e.uid,
				set: project(
					{
						title: excluded(e.title),
						location: excluded(e.location),
						notes: excluded(e.notes),
						startDate: excluded(e.startDate),
						startTime: excluded(e.startTime),
						endDate: excluded(e.endDate),
						endTime: excluded(e.endTime),
						repeat: excluded(e.repeat),
						repeatUntil: excluded(e.repeatUntil),
						updatedAt: now
					},
					e.projectId
				)
			})
			.returning({ id: e.id, uid: e.uid });
		const ids = new Map(rows.map((row) => [row.uid, row.id]));
		await tx.delete(t.eventExceptions).where(inArray(t.eventExceptions.eventId, [...ids.values()]));
		const exceptions = batch.flatMap((event) =>
			event.exceptions.map((exception) => ({ ...exception, eventId: ids.get(event.uid)! }))
		);
		for (const part of batches(exceptions)) await tx.insert(t.eventExceptions).values(part);
	}
	for (const batch of batches(parsed.tasks)) {
		const k = t.tasks;
		await tx
			.insert(k)
			.values(batch.map((task) => ({ ...task, projectId })))
			.onConflictDoUpdate({
				target: k.uid,
				set: project(
					{
						title: excluded(k.title),
						notes: excluded(k.notes),
						dueDate: excluded(k.dueDate),
						dueTime: excluded(k.dueTime),
						completedAt: excluded(k.completedAt),
						updatedAt: now
					},
					k.projectId
				)
			});
	}
}
/** Leaves out entries already synced from Moodle; they change only through the sync. */
async function withoutMoodle(parsed: ParsedCalendar): Promise<ParsedCalendar> {
	const synced = new Set<string>();
	// Moodle sends its task dates as VEVENTs. Both UIDs of a paired task remain sync-owned.
	const uids = [...parsed.events, ...parsed.tasks].map((item) => item.uid);
	for (const table of [t.events, t.tasks])
		for (const batch of batches(uids))
			for (const row of await db()
				.select({ uid: table.uid })
				.from(table)
				.where(and(eq(table.source, 'moodle'), inArray(table.uid, batch))))
				synced.add(row.uid);
	if (!synced.size) return parsed;
	const events = parsed.events.filter((item) => !synced.has(item.uid));
	const tasks = parsed.tasks.filter((item) => !synced.has(item.uid));
	const count = parsed.events.length + parsed.tasks.length - events.length - tasks.length;
	return {
		events,
		tasks,
		skipped: [...parsed.skipped, { reason: 'Already synced from Moodle', count }]
	};
}
async function existing(table: typeof t.events | typeof t.tasks, uids: string[]): Promise<number> {
	let count = 0;
	for (const batch of batches(uids))
		count += (await db().select({ uid: table.uid }).from(table).where(inArray(table.uid, batch)))
			.length;
	return count;
}

export const calendar: Handler = async ({ event, method, id, action }) => {
	if (id === 'moodle') {
		if (action === 'sync' && method === 'POST') {
			await syncMoodle();
			return Response.json(await moodleStatus());
		}
		if (action) return;
		if (method === 'GET') return Response.json(await moodleStatus());
		if (method === 'PUT') {
			const input = moodleInput.parse(await readJson(event));
			await connectMoodle(input.url, timeZoneOf(input));
			return Response.json(await moodleStatus());
		}
		if (method === 'DELETE') {
			await disconnectMoodle();
			return ok();
		}
		return;
	}
	if (action) return;
	if (id === 'feed') {
		if (method === 'GET') return Response.json(await feedSettings());
		if (method === 'POST') {
			const timeZone = timeZoneOf(feedInput.parse(await readJson(event)));
			const values = {
				token: randomBytes(32).toString('base64url'),
				timeZone,
				updatedAt: new Date()
			};
			await db()
				.insert(t.calendarFeed)
				.values({ id: FEED_ID, ...values })
				.onConflictDoUpdate({ target: t.calendarFeed.id, set: values });
			return Response.json(await feedSettings());
		}
		if (method === 'PATCH') {
			const timeZone = timeZoneOf(feedInput.parse(await readJson(event)));
			const [updated] = await db()
				.update(t.calendarFeed)
				.set({ timeZone, updatedAt: new Date() })
				.returning();
			if (!updated) error(404, 'The calendar feed is not enabled.');
			return Response.json(await feedSettings());
		}
		if (method === 'DELETE') {
			await db().update(t.calendarFeed).set({ token: null, updatedAt: new Date() });
			return ok();
		}
	}
	if (id === 'export' && method === 'GET') {
		// Moodle items come back through the sync, so the backup holds only your own.
		const [events, tasks] = await Promise.all([
			selectEvents(eq(t.events.source, 'custom')),
			selectTasks(eq(t.tasks.source, 'custom'))
		]);
		return calendarResponse(buildExport({ events, tasks }), {
			'content-disposition': 'attachment; filename="studyloom.ics"'
		});
	}
	if (id === 'import' && method === 'POST') {
		const input = importInput.parse(await readJson(event));
		if (input.projectId) await findProject(input.projectId);
		const parsed = await withoutMoodle(parseIcs(input.ics, timeZoneOf(input)));
		const summary: ImportSummary = {
			events: parsed.events.length,
			tasks: parsed.tasks.length,
			updated:
				(await existing(
					t.events,
					parsed.events.map((item) => item.uid)
				)) +
				(await existing(
					t.tasks,
					parsed.tasks.map((item) => item.uid)
				)),
			skipped: parsed.skipped
		};
		if (input.commit) await db().transaction((tx) => store(tx, parsed, input.projectId));
		return Response.json(summary);
	}
};
