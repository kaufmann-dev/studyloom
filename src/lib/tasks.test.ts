import { describe, expect, it } from 'vitest';
import { compareDue, dueLabel, isUrgent, urgency } from './tasks';

const now = new Date(2026, 9, 1, 12, 0);
const task = (
	dueDate: string,
	dueTime: string | null = null,
	completedAt: string | null = null
) => ({
	dueDate,
	dueTime,
	completedAt,
	createdAt: '2026-09-01T00:00:00.000Z'
});

describe('task urgency', () => {
	it('treats a day without a time as due until the end of that day', () => {
		expect(urgency(task('2026-10-01'), now)).toBe('today');
		expect(urgency(task('2026-09-30'), now)).toBe('overdue');
		expect(dueLabel(task('2026-10-01'), now)).toBe('Today');
		expect(dueLabel(task('2026-09-30'), now)).toBe('1 day overdue');
		expect(dueLabel(task('2026-09-28'), now)).toBe('3 days overdue');
	});
	it('uses the exact time when one is set', () => {
		expect(urgency(task('2026-10-01', '11:00'), now)).toBe('overdue');
		expect(dueLabel(task('2026-10-01', '11:00'), now)).toBe('Overdue since 11:00');
		expect(urgency(task('2026-10-01', '14:00'), now)).toBe('today');
		expect(dueLabel(task('2026-10-01', '14:00'), now)).toBe('Today, 14:00');
	});
	it('warns for the next three days and stays neutral after that', () => {
		expect(urgency(task('2026-10-02'), now)).toBe('soon');
		expect(dueLabel(task('2026-10-02', '09:00'), now)).toBe('Tomorrow, 09:00');
		expect(urgency(task('2026-10-04'), now)).toBe('soon');
		expect(dueLabel(task('2026-10-04'), now)).toBe('In 3 days');
		expect(urgency(task('2026-10-05'), now)).toBe('later');
		expect(urgency(task('2026-10-09'), now)).toBe('later');
		expect(isUrgent(task('2026-10-02'), now)).toBe(false);
		expect(isUrgent(task('2026-10-01'), now)).toBe(true);
	});
	it('never flags a completed task', () => {
		const done = task('2026-09-01', null, '2026-09-02T10:00:00.000Z');
		expect(urgency(done, now)).toBe('done');
		expect(isUrgent(done, now)).toBe(false);
	});
	it('sorts by deadline with timed tasks before end-of-day ones', () => {
		const sorted = [task('2026-10-03'), task('2026-10-02'), task('2026-10-03', '09:00')].sort(
			compareDue
		);
		expect(sorted.map((item) => `${item.dueDate} ${item.dueTime}`)).toEqual([
			'2026-10-02 null',
			'2026-10-03 09:00',
			'2026-10-03 null'
		]);
	});
});
