import { describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { addDays, toWallClock } from '../calendar';
import type { CalendarEvent, ImportSummary, MoodleCalendar, Task } from '../domain';
import { db, closeDatabase } from './db';
import { events, moodleCalendar, tasks } from './db/schema';
import { callApi, useTestDatabase } from './testing';
import { fetchWebPage } from './web-page';

vi.mock('./web-page', () => ({ fetchWebPage: vi.fn() }));

const ADDRESS = 'https://moodle.test/calendar/export_execute.php?userid=1&authtoken=secret-token';
const compact = (date: string) => date.replaceAll('-', '');
/** One Moodle VEVENT; `end` equal to `start` makes it a due date. */
const entry = (uid: string, title: string, date: string, start: string, end = start) =>
	[
		'BEGIN:VEVENT',
		`UID:${uid}@moodle.test`,
		`SUMMARY:${title}`,
		'DESCRIPTION:',
		`DTSTART:${compact(date)}T${start}00Z`,
		`DTEND:${compact(date)}T${end}00Z`,
		'END:VEVENT'
	].join('\r\n');
const calendar = (...entries: string[]) =>
	[
		'BEGIN:VCALENDAR',
		'VERSION:2.0',
		'PRODID:-//Moodle Pty Ltd//NONSGML Moodle//EN',
		...entries,
		'END:VCALENDAR'
	].join('\r\n');
function serve(body: string) {
	vi.mocked(fetchWebPage).mockResolvedValueOnce({
		url: ADDRESS,
		name: 'icalexport.ics',
		filename: 'icalexport.ics',
		mimeType: 'text/calendar',
		body: Buffer.from(body)
	});
}

describe.skipIf(!process.env.TEST_DATABASE_URL)('Moodle calendar sync', () => {
	it('syncs sessions as events and due dates as tasks, read-only except ticking off', async () => {
		const environment = await useTestDatabase('moodle');
		vi.stubEnv('ORIGIN', 'https://studyloom.test');
		const call = (path: string, method = 'GET', body?: unknown) => callApi(path, { method, body });
		const parse = async <T>(path: string, method = 'GET', body?: unknown): Promise<T> =>
			(await call(path, method, body)).json();
		const today = toWallClock(new Date(), 'UTC').date;
		const soon = addDays(today, 5);
		const later = addDays(today, 12);
		const past = addDays(today, -20);
		const moodleRows = async () => ({
			events: await db().select().from(events).where(eq(events.source, 'moodle')),
			tasks: await db().select().from(tasks).where(eq(tasks.source, 'moodle'))
		});
		try {
			// An earlier manual import of the Moodle file becomes a synced event.
			await db().insert(events).values({
				uid: 'lecture@moodle.test',
				title: 'Imported by hand',
				startDate: soon,
				endDate: soon
			});
			await db().insert(events).values({
				uid: 'old-lecture@moodle.test',
				title: 'Past session',
				startDate: past,
				endDate: past,
				source: 'moodle'
			});
			serve(
				calendar(
					entry('lecture', 'Lecture 1', soon, '0800', '1000'),
					entry('dropped', 'Cancelled later', later, '0800', '0900'),
					entry('forum', 'Forum ist fällig', soon, '2259'),
					entry('quiz', 'Quiz endet', later, '1100')
				)
			);
			const connected = await parse<MoodleCalendar>('/api/calendar/moodle', 'PUT', {
				url: ADDRESS,
				timeZone: 'UTC'
			});
			expect(connected).toMatchObject({
				connected: true,
				host: 'moodle.test',
				timeZone: 'UTC',
				lastError: null,
				events: 3,
				tasks: 2
			});
			expect(JSON.stringify(connected)).not.toContain('secret-token');
			let rows = await moodleRows();
			expect(rows.events.find((row) => row.uid === 'lecture@moodle.test')).toMatchObject({
				title: 'Lecture 1',
				startTime: '08:00',
				endTime: '10:00'
			});
			expect(rows.tasks.map((row) => [row.title, row.dueDate, row.dueTime]).sort()).toEqual([
				['Forum ist fällig', soon, '22:59'],
				['Quiz endet', later, '11:00']
			]);

			// Moodle events cannot change here; Moodle tasks can only be ticked off.
			const lecture = rows.events.find((row) => row.uid === 'lecture@moodle.test')!;
			await expect(
				call(`/api/events/${lecture.id}`, 'PATCH', { title: 'Mine now' })
			).rejects.toMatchObject({ status: 409 });
			await expect(call(`/api/events/${lecture.id}`, 'DELETE')).rejects.toMatchObject({
				status: 409
			});
			const forum = rows.tasks.find((row) => row.title === 'Forum ist fällig')!;
			await expect(
				call(`/api/tasks/${forum.id}`, 'PATCH', { title: 'Renamed' })
			).rejects.toMatchObject({ status: 409 });
			await expect(call(`/api/tasks/${forum.id}`, 'DELETE')).rejects.toMatchObject({
				status: 409
			});
			const { task: ticked } = await parse<{ task: Task }>(`/api/tasks/${forum.id}`, 'PATCH', {
				done: true
			});
			expect(ticked).toMatchObject({ source: 'moodle' });
			expect(ticked.completedAt).not.toBeNull();
			const { events: listed } = await parse<{ events: CalendarEvent[] }>(
				`/api/events?from=${today}&to=${later}`
			);
			expect(listed.every((event) => event.source === 'moodle')).toBe(true);

			// The next download: a renamed due date stays ticked off, a removed future session goes,
			// the past session that left Moodle's window stays, and a session turns into a due date.
			serve(
				calendar(
					entry('lecture', 'Lecture 1 (room change)', soon, '0900', '1100'),
					entry('forum', 'Forum ist fällig (extended)', soon, '2259'),
					entry('quiz', 'Quiz endet', later, '1100', '1200')
				)
			);
			const synced = await parse<MoodleCalendar>('/api/calendar/moodle/sync', 'POST', {});
			expect(synced).toMatchObject({ events: 3, tasks: 1, lastError: null });
			rows = await moodleRows();
			expect(rows.events.map((row) => row.title).sort()).toEqual([
				'Lecture 1 (room change)',
				'Past session',
				'Quiz endet'
			]);
			expect(rows.tasks).toHaveLength(1);
			expect(rows.tasks[0]).toMatchObject({ title: 'Forum ist fällig (extended)' });
			expect(rows.tasks[0].completedAt).not.toBeNull();

			// Importing the Moodle file by hand skips what the sync owns; the export leaves it out.
			const summary = await parse<ImportSummary>('/api/calendar/import', 'POST', {
				ics: calendar(entry('lecture', 'Lecture 1', soon, '0800', '1000')),
				timeZone: 'UTC',
				commit: true
			});
			expect(summary.events).toBe(0);
			expect(summary.skipped).toContainEqual({ reason: 'Already synced from Moodle', count: 1 });
			const exported = await (await call('/api/calendar/export')).text();
			expect(exported).not.toContain('Lecture 1');
			expect(exported).not.toContain('Forum');

			// A broken download is reported and changes nothing.
			serve('<html>Invalid authentication</html>');
			const failed = await parse<MoodleCalendar>('/api/calendar/moodle/sync', 'POST', {});
			expect(failed.lastError).toBe('Moodle did not return a calendar. Check the address.');
			expect(failed).toMatchObject({ events: 3, tasks: 1 });
			vi.mocked(fetchWebPage).mockRejectedValueOnce(new Error(`Could not open ${ADDRESS}`));
			const leaked = await parse<MoodleCalendar>('/api/calendar/moodle/sync', 'POST', {});
			expect(leaked.lastError).toBe('Could not open [Moodle address]');

			// Disconnecting removes everything that came from Moodle.
			await call('/api/calendar/moodle', 'DELETE');
			expect(await parse<MoodleCalendar>('/api/calendar/moodle')).toMatchObject({
				connected: false,
				host: null,
				events: 0,
				tasks: 0
			});
			await expect(
				call('/api/calendar/moodle', 'PUT', { url: 'http://moodle.test/x', timeZone: 'UTC' })
			).rejects.toMatchObject({ status: 400 });
		} finally {
			await db().delete(events);
			await db().delete(tasks);
			await db().delete(moodleCalendar);
			await closeDatabase();
			await environment.restore();
			vi.unstubAllEnvs();
		}
	});
});
