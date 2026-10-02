import { describe, expect, it } from 'vitest';
import type { RequestEvent } from '@sveltejs/kit';
import { eq } from 'drizzle-orm';
import { api } from './api';
import { db, closeDatabase } from './db';
import { events, projects, tasks } from './db/schema';
import { feedResponse } from './endpoints/calendar';
import type { CalendarEvent, CalendarFeed, ImportSummary, Task } from '../domain';

describe.skipIf(!process.env.TEST_DATABASE_URL)('Tasks, events and the calendar feed', () => {
	it('manages tasks, repeating events, the feed, import and export', async () => {
		const previous = { url: process.env.DATABASE_URL, origin: process.env.ORIGIN };
		process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
		process.env.ORIGIN = 'https://studyloom.test';
		const call = (path: string, method = 'GET', body?: unknown) => {
			const request = new Request(`https://studyloom.test${path}`, {
				method,
				body: body === undefined ? undefined : JSON.stringify(body),
				headers: body === undefined ? {} : { 'content-type': 'application/json' }
			});
			return api({
				url: new URL(request.url),
				request,
				locals: { session: { subject: 'test', name: 'Test' } }
			} as RequestEvent);
		};
		const parse = async <T>(path: string, method = 'GET', body?: unknown): Promise<T> =>
			(await call(path, method, body)).json();
		const openTasks = async () => (await parse<{ tasks: Task[] }>('/api/tasks')).tasks;
		const inOctober = async (query = '') =>
			(
				await parse<{ events: CalendarEvent[] }>(
					`/api/events?from=2026-10-01&to=2026-10-31${query}`
				)
			).events;
		const [project] = await db().insert(projects).values({ name: 'Biology' }).returning();
		try {
			// Tasks
			const { task: essay } = await parse<{ task: Task }>('/api/tasks', 'POST', {
				title: ' Essay ',
				dueDate: '2026-10-09',
				projectId: project.id
			});
			expect(essay).toMatchObject({ title: 'Essay', dueTime: null, projectName: 'Biology' });
			expect(essay).not.toHaveProperty('uid');
			await parse('/api/tasks', 'POST', { title: 'Evening', dueDate: '2026-10-03' });
			await parse('/api/tasks', 'POST', {
				title: 'Morning',
				dueDate: '2026-10-03',
				dueTime: '09:00'
			});
			expect((await openTasks()).map((task) => task.title)).toEqual([
				'Morning',
				'Evening',
				'Essay'
			]);
			await expect(
				call('/api/tasks', 'POST', { title: 'Bad', dueDate: '2026-13-01' })
			).rejects.toMatchObject({ status: 400 });
			await expect(
				call('/api/tasks', 'POST', { title: 'Bad', dueDate: '2026-10-01', dueTime: '25:00' })
			).rejects.toMatchObject({ status: 400 });
			await expect(
				call('/api/tasks', 'POST', {
					title: 'Orphan',
					dueDate: '2026-10-01',
					projectId: '9c9aaee7-3c97-4ca8-8daa-da26beeeaa32'
				})
			).rejects.toMatchObject({ status: 404 });
			const { task: renamed } = await parse<{ task: Task }>(`/api/tasks/${essay.id}`, 'PATCH', {
				title: 'Essay draft'
			});
			expect(renamed).toMatchObject({ dueDate: '2026-10-09', projectId: project.id });
			const { task: done } = await parse<{ task: Task }>(`/api/tasks/${essay.id}`, 'PATCH', {
				done: true
			});
			expect(done.completedAt).not.toBeNull();
			expect(await openTasks()).toHaveLength(2);
			expect((await parse<{ tasks: Task[] }>('/api/tasks?status=done')).tasks).toHaveLength(1);
			await parse(`/api/tasks/${essay.id}`, 'PATCH', { done: false });
			expect(await openTasks()).toHaveLength(3);

			// Events
			const lecture = {
				title: 'Lecture',
				startDate: '2026-10-05',
				startTime: '09:00',
				endDate: '2026-10-05',
				endTime: '10:30',
				repeat: 'weekly',
				projectId: project.id
			};
			const { event: series } = await parse<{ event: CalendarEvent }>(
				'/api/events',
				'POST',
				lecture
			);
			expect(series).toMatchObject({ repeatUntil: null, exceptions: [], projectName: 'Biology' });
			await parse('/api/events', 'POST', {
				title: 'September',
				startDate: '2026-09-10',
				endDate: '2026-09-10'
			});
			expect((await inOctober()).map((item) => item.title)).toEqual(['Lecture']);
			expect(await inOctober(`&projectId=${project.id}`)).toHaveLength(1);
			await expect(call('/api/events?from=2026-01-01&to=2027-12-31')).rejects.toMatchObject({
				status: 400
			});
			await expect(
				call('/api/events', 'POST', { ...lecture, endTime: '08:00' })
			).rejects.toMatchObject({ status: 400 });
			await expect(call('/api/events', 'POST', { ...lecture, endTime: '' })).rejects.toMatchObject({
				status: 400
			});

			const exception = `/api/events/${series.id}/exceptions`;
			await parse(`${exception}/2026-10-12`, 'PUT', { cancelled: true });
			const { event: changed } = await parse<{ event: CalendarEvent }>(
				`${exception}/2026-10-19`,
				'PUT',
				{
					title: 'Lecture (moved)',
					location: 'Room 2',
					notes: '',
					startDate: '2026-10-20',
					startTime: '14:00',
					endDate: '2026-10-20',
					endTime: '15:30'
				}
			);
			expect(changed.exceptions.map((item) => [item.occurrenceDate, item.cancelled])).toEqual([
				['2026-10-12', true],
				['2026-10-19', false]
			]);
			await expect(
				call(`${exception}/2026-10-13`, 'PUT', { cancelled: true })
			).rejects.toMatchObject({ status: 400 });
			const { event: restored } = await parse<{ event: CalendarEvent }>(
				`${exception}/2026-10-12`,
				'DELETE'
			);
			expect(restored.exceptions).toHaveLength(1);
			await parse(`${exception}/2026-10-12`, 'PUT', { cancelled: true });

			// Feed
			expect(await parse<CalendarFeed>('/api/calendar/feed')).toEqual({
				url: null,
				timeZone: null
			});
			await expect(
				call('/api/calendar/feed', 'POST', { timeZone: 'Mars/Olympus' })
			).rejects.toMatchObject({ status: 400 });
			const feed = await parse<CalendarFeed>('/api/calendar/feed', 'POST', {
				timeZone: 'Europe/Berlin'
			});
			const token = feed.url!.split('/').at(-2)!;
			expect(feed.url).toBe(`https://studyloom.test/feed/${token}/studyloom.ics`);
			const first = await feedResponse(token);
			expect(first?.headers.get('content-type')).toBe('text/calendar; charset=utf-8');
			const body = await first!.text();
			expect(body).toContain('SUMMARY:Lecture (moved)');
			expect(body).toContain('SUMMARY:Due: Essay draft');
			expect(await feedResponse('x'.repeat(43))).toBeUndefined();
			expect(await feedResponse('short')).toBeUndefined();
			const regenerated = await parse<CalendarFeed>('/api/calendar/feed', 'POST', {
				timeZone: 'Europe/Berlin'
			});
			expect(await feedResponse(token)).toBeUndefined();
			await parse('/api/calendar/feed', 'DELETE');
			expect(await feedResponse(regenerated.url!.split('/').at(-2)!)).toBeUndefined();

			// Export and import
			const exported = await (await call('/api/calendar/export')).text();
			expect(exported).toContain('RRULE:FREQ=WEEKLY');
			expect(exported).toContain('BEGIN:VTODO');
			const reimport = { ics: exported, timeZone: 'Europe/Berlin' };
			expect(await parse<ImportSummary>('/api/calendar/import', 'POST', reimport)).toEqual({
				events: 2,
				tasks: 3,
				updated: 5,
				skipped: []
			});
			await parse('/api/calendar/import', 'POST', { ...reimport, commit: true });
			expect(await openTasks()).toHaveLength(3);
			const [after] = await inOctober();
			expect(after).toMatchObject({ id: series.id, projectId: project.id });
			expect(after.exceptions).toHaveLength(2);

			const foreign = [
				'BEGIN:VCALENDAR',
				'BEGIN:VEVENT',
				'UID:seminar@example.test',
				'DTSTART:20261008T140000Z',
				'DTEND:20261008T153000Z',
				'SUMMARY:Seminar',
				'RRULE:FREQ=WEEKLY;BYDAY=TU,TH',
				'END:VEVENT',
				'BEGIN:VTODO',
				'UID:reading@example.test',
				'SUMMARY:Reading',
				'DUE;VALUE=DATE:20261020',
				'END:VTODO',
				'END:VCALENDAR'
			].join('\r\n');
			const incoming = { ics: foreign, timeZone: 'Europe/Berlin', projectId: project.id };
			expect(await parse<ImportSummary>('/api/calendar/import', 'POST', incoming)).toMatchObject({
				events: 2,
				tasks: 1,
				updated: 0
			});
			expect(await inOctober()).toHaveLength(1);
			await parse('/api/calendar/import', 'POST', { ...incoming, commit: true });
			expect(
				await parse<ImportSummary>('/api/calendar/import', 'POST', { ...incoming, commit: true })
			).toMatchObject({ updated: 3 });
			const seminars = (await inOctober()).filter((item) => item.title === 'Seminar');
			expect(seminars.map((item) => [item.startDate, item.startTime, item.projectId])).toEqual([
				['2026-10-08', '16:00', project.id],
				['2026-10-13', '16:00', project.id]
			]);
			expect(await openTasks()).toHaveLength(4);
			await expect(
				call('/api/calendar/import', 'POST', { ics: 'hello', timeZone: 'UTC' })
			).rejects.toMatchObject({ status: 400 });

			// Editing the schedule of a series drops its single-occurrence changes.
			const { event: moved } = await parse<{ event: CalendarEvent }>(
				`/api/events/${series.id}`,
				'PATCH',
				{ startDate: '2026-10-06', endDate: '2026-10-06' }
			);
			expect(moved).toMatchObject({ title: 'Lecture', startTime: '09:00', exceptions: [] });

			await db().delete(projects).where(eq(projects.id, project.id));
			expect(await db().select().from(events).where(eq(events.id, series.id))).toEqual([]);
			expect((await openTasks()).map((task) => task.title)).toEqual(['Morning', 'Evening']);
		} finally {
			await db().delete(projects).where(eq(projects.id, project.id));
			await db().delete(events);
			await db().delete(tasks);
			await db().execute('delete from calendar_feed');
			await closeDatabase();
			process.env.DATABASE_URL = previous.url;
			process.env.ORIGIN = previous.origin;
		}
	});
});
