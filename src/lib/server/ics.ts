import { addDays, isOccurrence, occurrences, toUtc, toWallClock, type Series } from '../calendar';
import type { CalendarSource, Repeat } from '../domain';

export interface IcsEvent extends Series {
	uid: string;
	updatedAt: Date;
}
export interface IcsTask {
	uid: string;
	title: string;
	notes: string;
	dueDate: string;
	dueTime: string | null;
	completedAt: Date | null;
	updatedAt: Date;
	projectName?: string | null;
	source: CalendarSource;
}

/** How far the subscription feed reaches around today. */
const FEED_PAST_DAYS = 90;
const FEED_FUTURE_DAYS = 730;
const LINE_OCTETS = 75;
const RULES: Record<Exclude<Repeat, 'none'>, string> = {
	daily: 'FREQ=DAILY',
	weekly: 'FREQ=WEEKLY',
	biweekly: 'FREQ=WEEKLY;INTERVAL=2',
	monthly: 'FREQ=MONTHLY',
	yearly: 'FREQ=YEARLY'
};

const encoder = new TextEncoder();
const escapeText = (value: string) =>
	value
		.replace(/\\/g, '\\\\')
		.replace(/\r?\n/g, '\\n')
		.replace(/[;,]/g, (mark) => `\\${mark}`);
/** Folds a content line at 75 octets without splitting a multi-byte character. */
export function foldLine(line: string): string {
	const parts: string[] = [];
	let current = '';
	let octets = 0;
	for (const character of line) {
		const size = encoder.encode(character).length;
		if (octets + size > LINE_OCTETS) {
			parts.push(current);
			current = ' ';
			octets = 1;
		}
		current += character;
		octets += size;
	}
	parts.push(current);
	return parts.join('\r\n');
}
const compactDate = (date: string) => date.replaceAll('-', '');
const floating = (date: string, time: string) => `${compactDate(date)}T${time.replace(':', '')}00`;
const utc = (instant: Date) => instant.toISOString().replace(/[-:]|\.\d{3}/g, '');
const text = (name: string, value: string) => (value ? [`${name}:${escapeText(value)}`] : []);
const calendar = (lines: string[]) =>
	[
		'BEGIN:VCALENDAR',
		'VERSION:2.0',
		'PRODID:-//Studyloom//Calendar//EN',
		'CALSCALE:GREGORIAN',
		...lines,
		'END:VCALENDAR'
	]
		.map(foldLine)
		.join('\r\n') + '\r\n';

interface Span {
	startDate: string;
	startTime: string | null;
	endDate: string;
	endTime: string | null;
}
/** Start and end lines: all-day as dates with an exclusive end, otherwise as given by `at`. */
function spanLines(span: Span, at: (date: string, time: string) => string) {
	if (!span.startTime || !span.endTime)
		return [
			`DTSTART;VALUE=DATE:${compactDate(span.startDate)}`,
			`DTEND;VALUE=DATE:${compactDate(addDays(span.endDate, 1))}`
		];
	return [
		`DTSTART:${at(span.startDate, span.startTime)}`,
		`DTEND:${at(span.endDate, span.endTime)}`
	];
}
/** Moodle items are marked in the title and by category, so a phone shows where they came from. */
const fromMoodle = (source: CalendarSource) => source === 'moodle';
const summary = (title: string, source: CalendarSource) =>
	text('SUMMARY', fromMoodle(source) ? `[Moodle] ${title}` : title);
const categories = (source: CalendarSource) => (fromMoodle(source) ? ['CATEGORIES:Moodle'] : []);
const stamps = (updatedAt: Date) => [
	`DTSTAMP:${utc(updatedAt)}`,
	`LAST-MODIFIED:${utc(updatedAt)}`
];

/**
 * The subscription feed: every occurrence near today as its own event with UTC times, so
 * any client shows the right time without repeat rules or time zone definitions.
 */
export function buildFeed(input: {
	events: IcsEvent[];
	tasks: IcsTask[];
	timeZone: string;
	now: Date;
}): string {
	const { timeZone } = input;
	const today = toWallClock(input.now, timeZone).date;
	const at = (date: string, time: string) => utc(toUtc(date, time, timeZone));
	const byId = new Map(input.events.map((event) => [event.id, event]));
	const lines = [
		'X-WR-CALNAME:Studyloom',
		'REFRESH-INTERVAL;VALUE=DURATION:PT1H',
		'X-PUBLISHED-TTL:PT1H'
	];
	for (const occurrence of occurrences(
		input.events,
		addDays(today, -FEED_PAST_DAYS),
		addDays(today, FEED_FUTURE_DAYS)
	)) {
		const event = byId.get(occurrence.eventId)!;
		lines.push(
			'BEGIN:VEVENT',
			`UID:${occurrence.occurrenceDate}-${event.uid}`,
			...stamps(event.updatedAt),
			...spanLines(occurrence, at),
			...summary(occurrence.title, occurrence.source),
			...categories(occurrence.source),
			...text('LOCATION', occurrence.location),
			...text('DESCRIPTION', describe(occurrence.notes, occurrence.projectName)),
			'END:VEVENT'
		);
	}
	for (const task of input.tasks) {
		if (task.completedAt) continue;
		lines.push(
			'BEGIN:VEVENT',
			`UID:due-${task.uid}`,
			...stamps(task.updatedAt),
			...(task.dueTime
				? [`DTSTART:${at(task.dueDate, task.dueTime)}`]
				: [
						`DTSTART;VALUE=DATE:${compactDate(task.dueDate)}`,
						`DTEND;VALUE=DATE:${compactDate(addDays(task.dueDate, 1))}`
					]),
			...summary(`Due: ${task.title}`, task.source),
			...categories(task.source),
			...text('DESCRIPTION', describe(task.notes, task.projectName)),
			'END:VEVENT'
		);
	}
	return calendar(lines);
}
const describe = (notes: string, projectName?: string | null) =>
	[notes, projectName ? `Project: ${projectName}` : ''].filter(Boolean).join('\n\n');

/**
 * The file export: events as series with their repeat rule and single-occurrence changes,
 * tasks as to-dos, all in zone-less local time exactly as stored.
 */
export function buildExport(input: { events: IcsEvent[]; tasks: IcsTask[] }): string {
	const lines: string[] = [];
	for (const event of input.events) {
		const allDay = !event.startTime;
		const moment = (date: string) =>
			allDay ? `;VALUE=DATE:${compactDate(date)}` : `:${floating(date, event.startTime!)}`;
		const changes =
			event.repeat === 'none'
				? []
				: event.exceptions
						.filter((exception) => isOccurrence(event, exception.occurrenceDate))
						.sort((a, b) => a.occurrenceDate.localeCompare(b.occurrenceDate));
		lines.push(
			'BEGIN:VEVENT',
			`UID:${event.uid}`,
			...stamps(event.updatedAt),
			...spanLines(event, floating),
			...text('SUMMARY', event.title),
			...text('LOCATION', event.location),
			...text('DESCRIPTION', event.notes)
		);
		if (event.repeat !== 'none') {
			const until = event.repeatUntil
				? `;UNTIL=${allDay ? compactDate(event.repeatUntil) : floating(event.repeatUntil, '23:59')}`
				: '';
			lines.push(`RRULE:${RULES[event.repeat]}${until}`);
		}
		for (const change of changes)
			if (change.cancelled) lines.push(`EXDATE${moment(change.occurrenceDate)}`);
		lines.push('END:VEVENT');
		for (const change of changes) {
			if (change.cancelled || !change.startDate || !change.endDate) continue;
			lines.push(
				'BEGIN:VEVENT',
				`UID:${event.uid}`,
				`RECURRENCE-ID${moment(change.occurrenceDate)}`,
				...stamps(event.updatedAt),
				...spanLines(change as Span, floating),
				...text('SUMMARY', change.title ?? event.title),
				...text('LOCATION', change.location ?? ''),
				...text('DESCRIPTION', change.notes ?? ''),
				'END:VEVENT'
			);
		}
	}
	for (const task of input.tasks)
		lines.push(
			'BEGIN:VTODO',
			`UID:${task.uid}`,
			...stamps(task.updatedAt),
			task.dueTime
				? `DUE:${floating(task.dueDate, task.dueTime)}`
				: `DUE;VALUE=DATE:${compactDate(task.dueDate)}`,
			...text('SUMMARY', task.title),
			...text('DESCRIPTION', task.notes),
			...(task.completedAt
				? ['STATUS:COMPLETED', `COMPLETED:${utc(task.completedAt)}`]
				: ['STATUS:NEEDS-ACTION']),
			'END:VTODO'
		);
	return calendar(lines);
}
