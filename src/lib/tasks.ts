import { dayLabel, diffDays, localDate } from './calendar';
import type { Task } from './domain';

type Due = Pick<Task, 'dueDate' | 'dueTime' | 'completedAt' | 'moodleFeedbackOpening'>;
export type Urgency = 'done' | 'overdue' | 'today' | 'soon' | 'later' | 'opening';

/** Days ahead that still count as "soon". */
const SOON_DAYS = 3;

/** The local instant a task is due; a task without a time is due at the end of its day. */
function dueAt(task: Pick<Task, 'dueDate' | 'dueTime'>): Date {
	const [year, month, day] = task.dueDate.split('-').map(Number);
	if (!task.dueTime) return new Date(year, month - 1, day, 23, 59, 59, 999);
	const [hours, minutes] = task.dueTime.split(':').map(Number);
	return new Date(year, month - 1, day, hours, minutes);
}
export function urgency(task: Due, now: Date): Urgency {
	if (task.completedAt) return 'done';
	if (task.moodleFeedbackOpening) return 'opening';
	if (dueAt(task) < now) return 'overdue';
	const days = diffDays(task.dueDate, localDate(now));
	return days === 0 ? 'today' : days <= SOON_DAYS ? 'soon' : 'later';
}
/** Overdue or due today: the tasks that need attention now. */
export function isUrgent(task: Due, now: Date): boolean {
	const state = urgency(task, now);
	return state === 'overdue' || state === 'today';
}
export function dueLabel(task: Due, now: Date): string {
	if (task.completedAt) return 'Done';
	if (task.moodleFeedbackOpening) return 'Opening date';
	const days = diffDays(task.dueDate, localDate(now));
	if (dueAt(task) < now)
		return days === 0
			? `Overdue since ${task.dueTime}`
			: `${-days} ${days === -1 ? 'day' : 'days'} overdue`;
	const time = task.dueTime ? `, ${task.dueTime}` : '';
	if (days === 0) return `Today${time}`;
	if (days === 1) return `Tomorrow${time}`;
	if (days <= 7) return `In ${days} days${time}`;
	return `${dayLabel(task.dueDate, now)}${time}`;
}
/** Earliest deadline first; on the same day a timed task comes before one due by end of day. */
export function compareDue(
	a: Pick<Task, 'dueDate' | 'dueTime' | 'createdAt'>,
	b: Pick<Task, 'dueDate' | 'dueTime' | 'createdAt'>
): number {
	return (
		a.dueDate.localeCompare(b.dueDate) ||
		(a.dueTime ?? '24:00').localeCompare(b.dueTime ?? '24:00') ||
		String(a.createdAt).localeCompare(String(b.createdAt))
	);
}

/** Schedule as supplied by Moodle or entered locally, using wall-clock dates throughout. */
export function taskSchedule(
	task: Pick<Task, 'dueDate' | 'dueTime' | 'opensDate' | 'opensTime' | 'moodleFeedbackOpening'>,
	now: Date
): string {
	const stamp = (date: string, time?: string | null) =>
		dayLabel(date, now) + (time ? `, ${time}` : '');
	const end = stamp(task.dueDate, task.dueTime);
	if (task.moodleFeedbackOpening) return `Opens ${end}`;
	if (task.opensDate) return `Opens ${stamp(task.opensDate, task.opensTime)} · Due ${end}`;
	return `Due ${end}`;
}
