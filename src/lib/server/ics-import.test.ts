import { describe, expect, it } from 'vitest';
import { parseIcs } from './ics-import';

const calendar = (...lines: string[]) =>
	['BEGIN:VCALENDAR', 'VERSION:2.0', ...lines, 'END:VCALENDAR'].join('\r\n');
const vevent = (...lines: string[]) => ['BEGIN:VEVENT', ...lines, 'END:VEVENT'];
const read = (...lines: string[]) => parseIcs(calendar(...lines), 'Europe/Berlin');
const one = (...lines: string[]) => read(...vevent('UID:a', ...lines)).events[0];

describe('reading calendar files', () => {
	it('rejects text that is not a calendar', () => {
		expect(() => parseIcs('<html></html>', 'UTC')).toThrow('not an iCalendar file');
	});
	it('unfolds lines, unescapes text and ignores alarms', () => {
		const event = one(
			'DTSTART:20261005T090000',
			'SUMMARY:Lecture\\, part',
			'  two',
			'DESCRIPTION:Line one\\nLine two\\; done',
			'LOCATION;LANGUAGE=en:Room 1',
			'BEGIN:VALARM',
			'DESCRIPTION:Reminder',
			'END:VALARM'
		);
		expect(event).toMatchObject({
			title: 'Lecture, part two',
			notes: 'Line one\nLine two; done',
			location: 'Room 1',
			startTime: '09:00',
			endTime: '09:00'
		});
	});
	it('reads all-day, floating, UTC and zoned times', () => {
		expect(one('DTSTART;VALUE=DATE:20261005', 'DTEND;VALUE=DATE:20261008')).toMatchObject({
			startDate: '2026-10-05',
			startTime: null,
			endDate: '2026-10-07',
			endTime: null
		});
		expect(one('DTSTART:20261005T090000', 'DTEND:20261005T103000')).toMatchObject({
			startTime: '09:00',
			endTime: '10:30'
		});
		// 23:30 UTC is already the next day in Berlin; the offset changes with daylight saving.
		expect(one('DTSTART:20261024T233000Z', 'DTEND:20261025T003000Z')).toMatchObject({
			startDate: '2026-10-25',
			startTime: '01:30',
			endDate: '2026-10-25',
			endTime: '02:30'
		});
		expect(one('DTSTART:20261026T233000Z')).toMatchObject({
			startDate: '2026-10-27',
			startTime: '00:30'
		});
		expect(one('DTSTART;TZID=America/New_York:20261005T090000')).toMatchObject({
			startDate: '2026-10-05',
			startTime: '15:00'
		});
		expect(one('DTSTART;TZID=W. Europe Standard Time:20261005T090000')).toMatchObject({
			startTime: '09:00'
		});
	});
	it('derives the end from a duration', () => {
		expect(one('DTSTART:20261005T230000', 'DURATION:PT1H30M')).toMatchObject({
			endDate: '2026-10-06',
			endTime: '00:30'
		});
		expect(one('DTSTART;VALUE=DATE:20261005', 'DURATION:P3D')).toMatchObject({
			endDate: '2026-10-07'
		});
	});
	it('maps repeat rules that have an equivalent', () => {
		const start = 'DTSTART:20261005T090000';
		expect(one(start, 'RRULE:FREQ=DAILY')).toMatchObject({ repeat: 'daily', repeatUntil: null });
		expect(one(start, 'RRULE:FREQ=WEEKLY;BYDAY=MO')).toMatchObject({ repeat: 'weekly' });
		expect(one(start, 'RRULE:FREQ=WEEKLY;INTERVAL=2')).toMatchObject({ repeat: 'biweekly' });
		expect(one(start, 'RRULE:FREQ=MONTHLY;BYMONTHDAY=5')).toMatchObject({ repeat: 'monthly' });
		expect(one(start, 'RRULE:FREQ=YEARLY;BYMONTH=10;BYMONTHDAY=5')).toMatchObject({
			repeat: 'yearly'
		});
		expect(one(start, 'RRULE:FREQ=WEEKLY;UNTIL=20261019T070000Z')).toMatchObject({
			repeatUntil: '2026-10-19'
		});
		expect(one(start, 'RRULE:FREQ=WEEKLY;UNTIL=20261019T065959Z')).toMatchObject({
			repeatUntil: '2026-10-18'
		});
		expect(one(start, 'RRULE:FREQ=WEEKLY;COUNT=3')).toMatchObject({ repeatUntil: '2026-10-19' });
	});
	it('splits a rule with several weekdays into one series per weekday', () => {
		const { events } = read(
			...vevent('UID:a', 'DTSTART:20261007T090000', 'RRULE:FREQ=WEEKLY;BYDAY=MO,WE;COUNT=4')
		);
		expect(events.map((event) => [event.uid, event.startDate, event.repeatUntil])).toEqual([
			['a-1', '2026-10-07', '2026-10-19'],
			['a-2', '2026-10-12', '2026-10-19']
		]);
		const fortnightly = read(
			...vevent('UID:b', 'DTSTART:20261007T090000', 'RRULE:FREQ=WEEKLY;INTERVAL=2;BYDAY=MO,WE')
		);
		expect(fortnightly.events.map((event) => event.startDate)).toEqual([
			'2026-10-07',
			'2026-10-19'
		]);
	});
	it('imports the first occurrence when a rule has no equivalent', () => {
		const result = read(
			...vevent('UID:a', 'DTSTART:20261005T090000', 'RRULE:FREQ=MONTHLY;BYDAY=1MO'),
			...vevent('UID:b', 'DTSTART:20261005T090000', 'RRULE:FREQ=DAILY;INTERVAL=3')
		);
		expect(result.events.map((event) => event.repeat)).toEqual(['none', 'none']);
		expect(result.skipped).toEqual([
			{ reason: 'Repeat rules without an equivalent (imported as single events)', count: 2 }
		]);
	});
	it('reads skipped and changed occurrences', () => {
		const { events, skipped } = read(
			...vevent(
				'UID:a',
				'DTSTART:20261005T090000',
				'DTEND:20261005T100000',
				'SUMMARY:Lecture',
				'RRULE:FREQ=WEEKLY',
				'EXDATE:20261012T090000,20261013T090000'
			),
			...vevent(
				'UID:a',
				'RECURRENCE-ID:20261019T090000',
				'DTSTART:20261020T140000',
				'DTEND:20261020T150000',
				'SUMMARY:Moved'
			),
			...vevent('UID:a', 'RECURRENCE-ID:20261026T090000', 'STATUS:CANCELLED'),
			...vevent('UID:missing', 'RECURRENCE-ID:20261026T090000', 'DTSTART:20261026T100000')
		);
		expect(events).toHaveLength(1);
		expect(events[0].exceptions.map((item) => [item.occurrenceDate, item.cancelled])).toEqual([
			['2026-10-12', true],
			['2026-10-19', false],
			['2026-10-26', true]
		]);
		expect(events[0].exceptions[1]).toMatchObject({ title: 'Moved', startDate: '2026-10-20' });
		expect(skipped).toEqual([{ reason: 'Changed occurrences without their series', count: 1 }]);
	});
	it('skips cancelled, undated and duplicate entries', () => {
		const result = read(
			...vevent('UID:a', 'DTSTART:20261005T090000'),
			...vevent('UID:a', 'DTSTART:20261006T090000'),
			...vevent('UID:b', 'DTSTART:20261005T090000', 'STATUS:CANCELLED'),
			...vevent('UID:c', 'SUMMARY:No date'),
			...vevent('UID:d', 'DTSTART:20261345T090000')
		);
		expect(result.events).toHaveLength(1);
		expect(result.skipped).toEqual([
			{ reason: 'Duplicate entries', count: 1 },
			{ reason: 'Cancelled entries', count: 1 },
			{ reason: 'Events without a start date', count: 2 }
		]);
	});
	it('reads to-dos as tasks', () => {
		const result = read(
			'BEGIN:VTODO',
			'UID:open',
			'SUMMARY:Essay',
			'DUE;VALUE=DATE:20261009',
			'END:VTODO',
			'BEGIN:VTODO',
			'UID:done',
			'SUMMARY:Reading',
			'DUE:20261003T120000Z',
			'STATUS:COMPLETED',
			'COMPLETED:20261002T080000Z',
			'END:VTODO',
			'BEGIN:VTODO',
			'UID:undated',
			'SUMMARY:Someday',
			'END:VTODO'
		);
		expect(result.tasks).toEqual([
			{
				uid: 'open',
				title: 'Essay',
				notes: '',
				dueDate: '2026-10-09',
				dueTime: null,
				completedAt: null
			},
			{
				uid: 'done',
				title: 'Reading',
				notes: '',
				dueDate: '2026-10-03',
				dueTime: '14:00',
				completedAt: new Date('2026-10-02T08:00:00Z')
			}
		]);
		expect(result.skipped).toEqual([{ reason: 'Tasks without a due date', count: 1 }]);
	});
});
