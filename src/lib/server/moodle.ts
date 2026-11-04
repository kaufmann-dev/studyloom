import { and, count, eq, gte, inArray, notInArray, sql } from 'drizzle-orm';
import { toWallClock } from '../calendar';
import type { MoodleCalendar } from '../domain';
import { ClientError, safeError } from './config';
import { db, type Transaction } from './db';
import * as t from './db/schema';
import { parseIcs, type ParsedEvent } from './ics-import';
import { fetchWebPage } from './web-page';

const ROW_ID = 1;
const SYNC_INTERVAL_MS = 30 * 60_000;
const BATCH = 500;

/**
 * Moodle exports scheduled sessions with a duration and activity dates (due dates, quiz
 * openings and closings) as a single moment. Those moments become tasks.
 */
export const isMoodleTask = (event: ParsedEvent) =>
	event.startTime !== null &&
	event.startDate === event.endDate &&
	event.startTime === event.endTime;

function batches<T>(items: T[]) {
	return Array.from({ length: Math.ceil(items.length / BATCH) }, (_, index) =>
		items.slice(index * BATCH, (index + 1) * BATCH)
	);
}
const excluded = (column: { name: string }) => sql.raw(`excluded."${column.name}"`);

/**
 * Writes one download: entries are matched by their Moodle identifier, and Moodle items that
 * are still ahead but no longer in the download were removed in Moodle. Past items stay, since
 * Moodle's export only reaches a few days back. A ticked-off task stays ticked off.
 */
async function store(tx: Transaction, parsed: ParsedEvent[], today: string) {
	const tasks = parsed.filter(isMoodleTask);
	const events = parsed.filter((event) => !isMoodleTask(event));
	const e = t.events;
	for (const batch of batches(events)) {
		const rows = await tx
			.insert(e)
			.values(
				batch.map((event) => ({ ...event, exceptions: undefined, source: 'moodle' as const }))
			)
			.onConflictDoUpdate({
				target: e.uid,
				set: {
					title: excluded(e.title),
					location: excluded(e.location),
					notes: excluded(e.notes),
					startDate: excluded(e.startDate),
					startTime: excluded(e.startTime),
					endDate: excluded(e.endDate),
					endTime: excluded(e.endTime),
					repeat: excluded(e.repeat),
					repeatUntil: excluded(e.repeatUntil),
					source: excluded(e.source),
					updatedAt: new Date()
				}
			})
			.returning({ id: e.id, uid: e.uid });
		const ids = new Map(rows.map((row) => [row.uid, row.id]));
		await tx.delete(t.eventExceptions).where(inArray(t.eventExceptions.eventId, [...ids.values()]));
		const exceptions = batch.flatMap((event) =>
			event.exceptions.map((exception) => ({ ...exception, eventId: ids.get(event.uid)! }))
		);
		for (const part of batches(exceptions)) await tx.insert(t.eventExceptions).values(part);
	}
	const k = t.tasks;
	for (const batch of batches(tasks))
		await tx
			.insert(k)
			.values(
				batch.map((task) => ({
					uid: task.uid,
					title: task.title,
					notes: task.notes,
					dueDate: task.startDate,
					dueTime: task.startTime,
					source: 'moodle' as const
				}))
			)
			.onConflictDoUpdate({
				target: k.uid,
				set: {
					title: excluded(k.title),
					notes: excluded(k.notes),
					dueDate: excluded(k.dueDate),
					dueTime: excluded(k.dueTime),
					source: excluded(k.source),
					updatedAt: new Date()
				}
			});
	await tx.delete(e).where(
		and(
			eq(e.source, 'moodle'),
			gte(e.endDate, today),
			events.length
				? notInArray(
						e.uid,
						events.map((event) => event.uid)
					)
				: undefined
		)
	);
	await tx.delete(k).where(
		and(
			eq(k.source, 'moodle'),
			gte(k.dueDate, today),
			tasks.length
				? notInArray(
						k.uid,
						tasks.map((task) => task.uid)
					)
				: undefined
		)
	);
}

// Every change to the Moodle data runs in turn, so a sync never overlaps another sync or a
// disconnect, and a sync asked for after a new address always uses that address.
let queue: Promise<unknown> = Promise.resolve();
function serial<T>(work: () => Promise<T>): Promise<T> {
	const next = queue.then(work);
	queue = next.catch(() => {});
	return next;
}

async function runSync() {
	const [row] = await db().select().from(t.moodleCalendar);
	if (!row?.url) return;
	const current = and(eq(t.moodleCalendar.id, ROW_ID), eq(t.moodleCalendar.url, row.url));
	try {
		const page = await fetchWebPage(row.url);
		const body = page.body.toString('utf8');
		if (!/^\uFEFF?\s*BEGIN:VCALENDAR/i.test(body))
			throw new ClientError(400, 'Moodle did not return a calendar. Check the address.');
		const parsed = parseIcs(body, row.timeZone);
		const today = toWallClock(new Date(), row.timeZone).date;
		await db().transaction((tx) => store(tx, parsed.events, today));
		await db()
			.update(t.moodleCalendar)
			.set({ lastSyncedAt: new Date(), lastError: null })
			.where(current);
	} catch (cause) {
		// The address holds an authentication token; it never reaches a message or the log.
		const message = safeError(cause).replaceAll(row.url, '[Moodle address]');
		await db().update(t.moodleCalendar).set({ lastError: message }).where(current);
	}
}

/** Downloads the Moodle calendar now. A failure is kept as the last error, not thrown. */
export const syncMoodle = () => serial(runSync);

export async function moodleStatus(): Promise<MoodleCalendar> {
	const [[row], [events], [tasks]] = await Promise.all([
		db().select().from(t.moodleCalendar),
		db().select({ n: count() }).from(t.events).where(eq(t.events.source, 'moodle')),
		db().select({ n: count() }).from(t.tasks).where(eq(t.tasks.source, 'moodle'))
	]);
	return {
		connected: Boolean(row?.url),
		host: row?.url ? new URL(row.url).host : null,
		timeZone: row?.timeZone ?? null,
		lastSyncedAt: row?.lastSyncedAt?.toISOString() ?? null,
		lastError: row?.lastError ?? null,
		events: events.n,
		tasks: tasks.n
	};
}

/** Saves the address and time zone, then syncs; a failed first sync is reported, not thrown. */
export async function connectMoodle(url: string, timeZone: string) {
	await serial(async () => {
		const values = { url, timeZone, lastSyncedAt: null, lastError: null, updatedAt: new Date() };
		await db()
			.insert(t.moodleCalendar)
			.values({ id: ROW_ID, ...values })
			.onConflictDoUpdate({ target: t.moodleCalendar.id, set: values });
	});
	await syncMoodle();
}

/** Forgets the address and removes every item that came from Moodle. */
export const disconnectMoodle = () =>
	serial(() =>
		db().transaction(async (tx) => {
			await tx
				.update(t.moodleCalendar)
				.set({ url: null, lastSyncedAt: null, lastError: null, updatedAt: new Date() });
			await tx.delete(t.events).where(eq(t.events.source, 'moodle'));
			await tx.delete(t.tasks).where(eq(t.tasks.source, 'moodle'));
		})
	);

/** Syncs now and then every 30 minutes; returns a stop function for shutdown. */
export function startMoodleSync() {
	const run = () =>
		void syncMoodle().catch((cause) => console.error('Moodle sync:', safeError(cause)));
	run();
	const timer = setInterval(run, SYNC_INTERVAL_MS);
	timer.unref();
	return async () => {
		clearInterval(timer);
		await queue;
	};
}
