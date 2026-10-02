import { describe, expect, it } from 'vitest';
import {
	isOccurrence,
	layoutDay,
	monthGrid,
	occurrences,
	toUtc,
	toWallClock,
	weekDays,
	type Series
} from './calendar';
import type { EventException, Repeat } from './domain';

function event(startDate: string, repeat: Repeat = 'none', extra: Partial<Series> = {}): Series {
	return {
		id: 'event',
		title: 'Lecture',
		location: '',
		notes: '',
		startDate,
		startTime: '09:00',
		endDate: startDate,
		endTime: '10:00',
		repeat,
		repeatUntil: null,
		exceptions: [],
		projectId: null,
		projectName: null,
		...extra
	};
}
const change = (occurrenceDate: string, extra: Partial<EventException> = {}): EventException => ({
	occurrenceDate,
	cancelled: false,
	title: 'Moved',
	location: '',
	notes: '',
	startDate: occurrenceDate,
	startTime: '14:00',
	endDate: occurrenceDate,
	endTime: '15:00',
	...extra
});
const starts = (events: Series[], from: string, to: string) =>
	occurrences(events, from, to).map((occurrence) => occurrence.startDate);

describe('repeating events', () => {
	it('expands each kind of repeat inside the range', () => {
		expect(starts([event('2026-10-05')], '2026-10-01', '2026-10-31')).toEqual(['2026-10-05']);
		expect(starts([event('2026-10-05', 'daily')], '2026-10-07', '2026-10-09')).toEqual([
			'2026-10-07',
			'2026-10-08',
			'2026-10-09'
		]);
		expect(starts([event('2026-10-05', 'weekly')], '2026-10-01', '2026-10-31')).toEqual([
			'2026-10-05',
			'2026-10-12',
			'2026-10-19',
			'2026-10-26'
		]);
		expect(starts([event('2026-10-05', 'biweekly')], '2026-10-06', '2026-11-05')).toEqual([
			'2026-10-19',
			'2026-11-02'
		]);
		expect(starts([event('2026-10-05', 'monthly')], '2026-11-01', '2027-01-31')).toEqual([
			'2026-11-05',
			'2026-12-05',
			'2027-01-05'
		]);
		expect(starts([event('2026-10-05', 'yearly')], '2027-01-01', '2028-12-31')).toEqual([
			'2027-10-05',
			'2028-10-05'
		]);
	});
	it('stops at the end date', () => {
		const series = event('2026-10-05', 'weekly', { repeatUntil: '2026-10-19' });
		expect(starts([series], '2026-10-01', '2026-12-31')).toEqual([
			'2026-10-05',
			'2026-10-12',
			'2026-10-19'
		]);
		expect(isOccurrence(series, '2026-10-26')).toBe(false);
	});
	it('skips months and years that lack the day', () => {
		expect(starts([event('2026-01-31', 'monthly')], '2026-01-01', '2026-05-31')).toEqual([
			'2026-01-31',
			'2026-03-31',
			'2026-05-31'
		]);
		expect(starts([event('2024-02-29', 'yearly')], '2024-01-01', '2028-12-31')).toEqual([
			'2024-02-29',
			'2028-02-29'
		]);
		expect(isOccurrence(event('2026-01-31', 'monthly'), '2026-04-30')).toBe(false);
	});
	it('includes events that started before the range and still run into it', () => {
		const trip = event('2026-10-05', 'none', {
			startTime: null,
			endTime: null,
			endDate: '2026-10-08'
		});
		expect(starts([trip], '2026-10-07', '2026-10-07')).toEqual(['2026-10-05']);
		expect(starts([trip], '2026-10-09', '2026-10-12')).toEqual([]);
	});
	it('drops skipped occurrences and applies changed ones', () => {
		const series = event('2026-10-05', 'weekly', {
			exceptions: [
				change('2026-10-12', { cancelled: true }),
				change('2026-10-19', { startDate: '2026-10-20', endDate: '2026-10-20' })
			]
		});
		const result = occurrences([series], '2026-10-01', '2026-10-31');
		expect(result.map((item) => [item.startDate, item.title, item.modified])).toEqual([
			['2026-10-05', 'Lecture', false],
			['2026-10-20', 'Moved', true],
			['2026-10-26', 'Lecture', false]
		]);
		expect(result[1].occurrenceDate).toBe('2026-10-19');
	});
	it('shows an occurrence that was moved into the range from outside it', () => {
		const series = event('2026-10-05', 'weekly', {
			exceptions: [change('2026-11-02', { startDate: '2026-10-07', endDate: '2026-10-07' })]
		});
		expect(starts([series], '2026-10-06', '2026-10-08')).toEqual(['2026-10-07']);
	});
	it('ignores changes whose date is not part of the series', () => {
		const series = event('2026-10-05', 'weekly', { exceptions: [change('2026-10-06')] });
		expect(starts([series], '2026-10-05', '2026-10-11')).toEqual(['2026-10-05']);
	});
});

describe('calendar layout', () => {
	it('builds weeks from the locale first weekday', () => {
		expect(weekDays('2026-10-01', 'de-DE')[0]).toBe('2026-09-28');
		expect(weekDays('2026-10-01', 'en-US')[0]).toBe('2026-09-27');
		const grid = monthGrid('2026-10-15', 'de-DE');
		expect(grid).toHaveLength(5);
		expect(grid[0][0]).toBe('2026-09-28');
		expect(grid.at(-1)?.at(-1)).toBe('2026-11-01');
	});
	it('places overlapping events side by side', () => {
		const layout = layoutDay([
			{ key: 'a', start: 540, end: 600 },
			{ key: 'b', start: 570, end: 630 },
			{ key: 'c', start: 600, end: 660 },
			{ key: 'd', start: 720, end: 780 }
		]);
		expect(layout.get('a')).toEqual({ column: 0, columns: 2 });
		expect(layout.get('b')).toEqual({ column: 1, columns: 2 });
		expect(layout.get('c')).toEqual({ column: 0, columns: 2 });
		expect(layout.get('d')).toEqual({ column: 0, columns: 1 });
	});
});

describe('time zone conversion', () => {
	it('follows daylight saving time', () => {
		expect(toUtc('2026-10-24', '09:00', 'Europe/Berlin').toISOString()).toBe(
			'2026-10-24T07:00:00.000Z'
		);
		expect(toUtc('2026-10-26', '09:00', 'Europe/Berlin').toISOString()).toBe(
			'2026-10-26T08:00:00.000Z'
		);
		expect(toWallClock(new Date('2026-10-26T23:30:00Z'), 'Europe/Berlin')).toEqual({
			date: '2026-10-27',
			time: '00:30'
		});
	});
});
