import { describe, expect, it } from 'vitest';
import { buildExport, buildFeed, foldLine, type IcsEvent, type IcsTask } from './ics';
import { parseIcs } from './ics-import';

const updatedAt = new Date('2026-10-01T08:00:00Z');
function event(extra: Partial<IcsEvent> = {}): IcsEvent {
	return {
		id: 'e1',
		uid: 'lecture@studyloom',
		title: 'Lecture',
		location: 'Room 1; North, Campus',
		notes: 'Bring notes\nand a pen',
		startDate: '2026-10-05',
		startTime: '09:00',
		endDate: '2026-10-05',
		endTime: '10:30',
		repeat: 'none',
		repeatUntil: null,
		exceptions: [],
		projectId: null,
		projectName: null,
		source: 'custom',
		updatedAt,
		...extra
	};
}
function task(extra: Partial<IcsTask> = {}): IcsTask {
	return {
		uid: 'essay@studyloom',
		title: 'Hand in essay',
		notes: '',
		dueDate: '2026-10-09',
		dueTime: null,
		completedAt: null,
		updatedAt,
		...extra
	};
}
const skipped = {
	occurrenceDate: '2026-10-12',
	cancelled: true,
	title: null,
	location: null,
	notes: null,
	startDate: null,
	startTime: null,
	endDate: null,
	endTime: null
};
const moved = {
	occurrenceDate: '2026-10-26',
	cancelled: false,
	title: 'Lecture (moved)',
	location: 'Room 2',
	notes: '',
	startDate: '2026-10-27',
	startTime: '14:00',
	endDate: '2026-10-27',
	endTime: '15:30'
};
const weekly = event({ repeat: 'weekly', repeatUntil: '2026-11-02', exceptions: [skipped, moved] });
const now = new Date('2026-10-01T10:00:00Z');
const feed = (events: IcsEvent[], tasks: IcsTask[] = []) =>
	buildFeed({ events, tasks, timeZone: 'Europe/Berlin', now });

describe('subscription feed', () => {
	it('escapes text, ends lines with CRLF and folds long lines by octets', () => {
		const output = feed([event({ notes: 'ä'.repeat(100) })]);
		expect(output.startsWith('BEGIN:VCALENDAR\r\nVERSION:2.0\r\n')).toBe(true);
		expect(output.endsWith('END:VCALENDAR\r\n')).toBe(true);
		expect(output).toContain('LOCATION:Room 1\\; North\\, Campus\r\n');
		expect(output.replaceAll('\r\n', '')).not.toContain('\n');
		for (const line of output.split('\r\n'))
			expect(Buffer.byteLength(line)).toBeLessThanOrEqual(75);
		expect(foldLine(`X:${'ä'.repeat(100)}`).replaceAll('\r\n ', '')).toBe(`X:${'ä'.repeat(100)}`);
		expect(feed([event()])).toContain('DESCRIPTION:Bring notes\\nand a pen\r\n');
	});
	it('writes timed events in UTC and all-day events with an exclusive end', () => {
		expect(feed([event()])).toContain('DTSTART:20261005T070000Z\r\nDTEND:20261005T083000Z');
		const allDay = feed([event({ startTime: null, endTime: null, endDate: '2026-10-06' })]);
		expect(allDay).toContain('DTSTART;VALUE=DATE:20261005\r\nDTEND;VALUE=DATE:20261007');
	});
	it('expands a series into single occurrences with stable ids and applied changes', () => {
		const output = feed([weekly]);
		expect(output).not.toContain('RRULE');
		expect(output.match(/BEGIN:VEVENT/g)).toHaveLength(4);
		expect(output).toContain('UID:2026-10-05-lecture@studyloom');
		expect(output).not.toContain('UID:2026-10-12-lecture@studyloom');
		// Daylight saving time ends on 25 October, so the same wall-clock time shifts in UTC.
		expect(output).toContain('DTSTART:20261019T070000Z');
		expect(output).toContain('DTSTART:20261102T080000Z');
		expect(output).toContain('UID:2026-10-26-lecture@studyloom');
		expect(output).toContain('DTSTART:20261027T130000Z');
		expect(output).toContain('SUMMARY:Lecture (moved)');
	});
	it('lists open tasks as deadlines and leaves completed ones out', () => {
		const output = feed(
			[],
			[
				task({ projectName: 'Biology' }),
				task({ uid: 'timed@studyloom', title: 'Quiz', dueTime: '14:00' }),
				task({ uid: 'done@studyloom', title: 'Old', completedAt: now })
			]
		);
		expect(output).toContain('SUMMARY:Due: Hand in essay');
		expect(output).toContain('DTSTART;VALUE=DATE:20261009\r\nDTEND;VALUE=DATE:20261010');
		expect(output).toContain('DESCRIPTION:Project: Biology');
		expect(output).toContain('DTSTART:20261009T120000Z\r\nSUMMARY:Due: Quiz');
		expect(output).not.toContain('Old');
	});
	it('lists Moodle events under their plain title', () => {
		const output = feed([event({ source: 'moodle' })], []);
		expect(output).toContain('SUMMARY:Lecture\r\n');
		expect(output).not.toContain('Moodle');
	});
});

describe('file export', () => {
	it('writes series with their rule, skipped dates and changed occurrences', () => {
		const output = buildExport({ events: [weekly], tasks: [] });
		expect(output).toContain('DTSTART:20261005T090000\r\nDTEND:20261005T103000');
		expect(output).toContain('RRULE:FREQ=WEEKLY;UNTIL=20261102T235900');
		expect(output).toContain('EXDATE:20261012T090000');
		expect(output).toContain('RECURRENCE-ID:20261026T090000');
		expect(buildExport({ events: [event({ repeat: 'biweekly' })], tasks: [] })).toContain(
			'RRULE:FREQ=WEEKLY;INTERVAL=2\r\n'
		);
		const allDay = event({
			startTime: null,
			endTime: null,
			repeat: 'yearly',
			repeatUntil: '2030-10-05'
		});
		expect(buildExport({ events: [allDay], tasks: [] })).toContain(
			'RRULE:FREQ=YEARLY;UNTIL=20301005'
		);
	});
	it('writes tasks as to-dos with their state', () => {
		const output = buildExport({
			events: [],
			tasks: [task(), task({ uid: 'done@studyloom', dueTime: '14:00', completedAt: now })]
		});
		expect(output).toContain('DUE;VALUE=DATE:20261009');
		expect(output).toContain('STATUS:NEEDS-ACTION');
		expect(output).toContain('DUE:20261009T140000');
		expect(output).toContain('STATUS:COMPLETED\r\nCOMPLETED:20261001T100000Z');
	});
	it('reads its own export back unchanged', () => {
		const events = [
			weekly,
			event({ uid: 'trip@studyloom', startTime: null, endTime: null, endDate: '2026-10-08' }),
			event({
				uid: 'monthly@studyloom',
				repeat: 'monthly',
				startDate: '2026-01-31',
				endDate: '2026-01-31'
			}),
			event({ uid: 'daily@studyloom', repeat: 'daily', repeatUntil: '2026-10-09' }),
			event({ uid: 'fortnight@studyloom', repeat: 'biweekly' }),
			event({ uid: 'birthday@studyloom', repeat: 'yearly', startTime: null, endTime: null })
		];
		const tasks = [
			task({ notes: 'Two pages; double spaced' }),
			task({ uid: 'done@studyloom', dueTime: '14:00', completedAt: now })
		];
		const parsed = parseIcs(buildExport({ events, tasks }), 'Europe/Berlin');
		expect(parsed.skipped).toEqual([]);
		expect(parsed.events).toEqual(
			events.map(
				({
					uid,
					title,
					location,
					notes,
					startDate,
					startTime,
					endDate,
					endTime,
					repeat,
					repeatUntil,
					exceptions
				}) => ({
					uid,
					title,
					location,
					notes,
					startDate,
					startTime,
					endDate,
					endTime,
					repeat,
					repeatUntil,
					exceptions
				})
			)
		);
		expect(parsed.tasks).toEqual(
			tasks.map(({ uid, title, notes, dueDate, dueTime, completedAt }) => ({
				uid,
				title,
				notes,
				dueDate,
				dueTime,
				completedAt
			}))
		);
	});
});
