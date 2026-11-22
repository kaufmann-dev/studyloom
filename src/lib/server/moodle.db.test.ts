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
	it('combines unique feedback windows and retains the opening when the feed rolls forward', async () => {
		const environment = await useTestDatabase('moodle-feedback');
		vi.stubEnv('ORIGIN', 'https://studyloom.test');
		const today = toWallClock(new Date(), 'UTC').date;
		const past = addDays(today, -10);
		const later = addDays(today, 20);
		const marker = (uid: string, title: string, date: string, course: string) =>
			entry(uid, title, date, '1200').replace(
				'DESCRIPTION:',
				`CATEGORIES:${course}\r\nDESCRIPTION:`
			);
		const start = marker('open', 'Feedback: Seminar beginnt', past, 'Course-A');
		const end = marker('close', 'Feedback: Seminar endet', later, 'Course-A');
		const secondCourse = marker('other', 'Feedback: Seminar beginnt', past, 'Course-B');
		const list = async (status = 'open'): Promise<Task[]> =>
			(await (await callApi(`/api/tasks?status=${status}`)).json()).tasks;
		try {
			serve(calendar(start, end, secondCourse));
			const status = await (
				await callApi('/api/calendar/moodle', {
					method: 'PUT',
					body: { url: ADDRESS, timeZone: 'UTC' }
				})
			).json();
			expect(status).toMatchObject({ lastError: null, tasks: 2 });
			const open = await list();
			const pair = open.find((task) => task.title === 'Feedback: Seminar')!;
			expect(pair).toMatchObject({ opensDate: past, opensTime: '12:00', dueDate: later });
			expect(open.find((task) => task.title.endsWith('beginnt'))?.moodleFeedbackOpening).toBe(true);
			const feed = await (
				await callApi('/api/calendar/feed', { body: { timeZone: 'UTC' } })
			).json();
			const { feedResponse } = await import('./endpoints/calendar');
			const response = await feedResponse(new URL(feed.url).pathname.split('/')[2]);
			const ics = await response!.text();
			expect(ics).toContain(`DTSTART:${compact(past)}T120000Z\r\nDTEND:${compact(later)}T120000Z`);
			expect(ics).not.toContain('UID:due-open@moodle.test');
			await callApi(`/api/tasks/${pair.id}`, { method: 'PATCH', body: { done: true } });
			serve(calendar(end));
			expect(await (await callApi('/api/calendar/moodle/sync', { body: {} })).json()).toMatchObject(
				{ tasks: 2, lastError: null }
			);
			expect(await list('done')).toContainEqual(
				expect.objectContaining({ id: pair.id, opensDate: past, dueDate: later })
			);
			const renamed = marker('second-close', 'Feedback: Seminar endet', later, 'Course-A');
			serve(calendar(end, renamed));
			expect(await (await callApi('/api/calendar/moodle/sync', { body: {} })).json()).toMatchObject(
				{ tasks: 4, lastError: null }
			);
			expect((await list('done')).find((task) => task.id === pair.id)?.opensDate).toBeNull();
		} finally {
			await callApi('/api/calendar/moodle', { method: 'DELETE' });
			await callApi('/api/calendar/feed', { method: 'DELETE' });
			vi.unstubAllEnvs();
			await closeDatabase();
			await environment.restore();
		}
	});
	it('pairs quiz markers only when their course and single quiz link agree', async () => {
		const environment = await useTestDatabase('moodle-quiz-windows');
		const today = toWallClock(new Date(), 'UTC').date;
		const opening = addDays(today, -1);
		const closing = addDays(today, 5);
		const quizLink = (id: number) => `https://moodle.test/mod/quiz/view.php?id=${id}`;
		const quiz = (uid: string, phase: 'beginnt' | 'endet', urls: string[], course = 'Course-A') =>
			entry(
				uid,
				`Multiple-Choice-Test ${phase}`,
				phase === 'beginnt' ? opening : closing,
				'1200'
			).replace(
				'DESCRIPTION:',
				`CATEGORIES:${course}\r\nDESCRIPTION:Quiz [1]\\n${urls.join('\\n')}`
			);
		const open = quiz('quiz-open', 'beginnt', [quizLink(12)]);
		const close = quiz('quiz-close', 'endet', [quizLink(12)]);
		const list = async (status = 'open'): Promise<Task[]> =>
			(await (await callApi(`/api/tasks?status=${status}`)).json()).tasks;

		try {
			serve(
				calendar(
					open,
					close,
					quiz('different-id', 'endet', [quizLink(15)]),
					quiz('different-course', 'endet', [quizLink(12)], 'Course-B'),
					quiz('foreign', 'endet', [quizLink(12).replace('moodle.test', 'foreign.test')]),
					quiz('ambiguous', 'endet', [quizLink(12), quizLink(15)]),
					quiz('missing', 'endet', [])
				)
			);
			const connected = await callApi('/api/calendar/moodle', {
				method: 'PUT',
				body: { url: ADDRESS, timeZone: 'UTC' }
			});
			expect(await connected.json()).toMatchObject({ tasks: 6, lastError: null });
			const tasks = await list();
			const paired = tasks.find((task) => task.title === 'Multiple-Choice-Test')!;
			expect(paired).toMatchObject({ opensDate: opening, opensTime: '12:00', dueDate: closing });
			expect(tasks.filter((task) => task.opensDate)).toHaveLength(1);
			await callApi(`/api/tasks/${paired.id}`, { method: 'PATCH', body: { done: true } });
			serve(calendar(close));
			const synced = await callApi('/api/calendar/moodle/sync', { body: {} });
			expect(await synced.json()).toMatchObject({ tasks: 1, lastError: null });
			expect(await list('done')).toContainEqual(
				expect.objectContaining({ id: paired.id, opensDate: opening, dueDate: closing })
			);
		} finally {
			await callApi('/api/calendar/moodle', { method: 'DELETE' });
			await closeDatabase();
			await environment.restore();
		}
	});
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
