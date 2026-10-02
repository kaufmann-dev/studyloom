import {
	getLocalTimeZone,
	getWeeksInMonth,
	parseAbsolute,
	parseDate,
	parseDateTime,
	startOfMonth,
	startOfWeek,
	toZoned
} from '@internationalized/date';
import type { CalendarEvent, Occurrence } from './domain';

/** The fields that decide when an event happens; shared by browser and server rows. */
export type Series = Pick<
	CalendarEvent,
	| 'id'
	| 'title'
	| 'location'
	| 'notes'
	| 'startDate'
	| 'startTime'
	| 'endDate'
	| 'endTime'
	| 'repeat'
	| 'repeatUntil'
	| 'exceptions'
	| 'projectId'
	| 'projectName'
>;

const pad = (value: number) => String(value).padStart(2, '0');

/** The local calendar day of an instant as `YYYY-MM-DD`. */
export function localDate(now: Date): string {
	return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}
export function localTime(now: Date): string {
	return `${pad(now.getHours())}:${pad(now.getMinutes())}`;
}
export const addDays = (date: string, days: number) => parseDate(date).add({ days }).toString();
export const addMonths = (date: string, months: number) =>
	parseDate(date).add({ months }).toString();
/** Whole calendar days from `b` to `a`; negative when `a` is earlier. */
export const diffDays = (a: string, b: string) => parseDate(a).compare(parseDate(b));
/** Minutes since midnight. */
export function minutesOf(time: string): number {
	const [hours, minutes] = time.split(':').map(Number);
	return hours * 60 + minutes;
}
export const timeOf = (minutes: number) => `${pad(Math.floor(minutes / 60))}:${pad(minutes % 60)}`;
export function addMinutes(date: string, time: string, minutes: number) {
	const moved = parseDateTime(`${date}T${time}`).add({ minutes });
	return { date: moved.toString().slice(0, 10), time: `${pad(moved.hour)}:${pad(moved.minute)}` };
}
export function dateOf(date: string): Date {
	const [year, month, day] = date.split('-').map(Number);
	return new Date(year, month - 1, day);
}
/** "Mon, 5 Oct", with the year when it is not the current one. */
export function dayLabel(date: string, now = new Date()): string {
	const value = dateOf(date);
	return value.toLocaleDateString(undefined, {
		weekday: 'short',
		day: 'numeric',
		month: 'short',
		year: value.getFullYear() === now.getFullYear() ? undefined : 'numeric'
	});
}
/** "Today", "Tomorrow", or the day label. */
export function relativeDay(date: string, now: Date): string {
	const days = diffDays(date, localDate(now));
	return days === 0 ? 'Today' : days === 1 ? 'Tomorrow' : dayLabel(date, now);
}

const STEP_DAYS = { daily: 1, weekly: 7, biweekly: 14 } as const;

/**
 * Whether `date` is an original start date of the series. Monthly and yearly repeats skip
 * months or years that lack the day, exactly as iCalendar repeat rules do.
 */
export function isOccurrence(
	event: Pick<Series, 'startDate' | 'repeat' | 'repeatUntil'>,
	date: string
): boolean {
	if (date < event.startDate) return false;
	if (event.repeat === 'none') return date === event.startDate;
	if (event.repeatUntil && date > event.repeatUntil) return false;
	if (event.repeat === 'monthly') return date.slice(8) === event.startDate.slice(8);
	if (event.repeat === 'yearly') return date.slice(5) === event.startDate.slice(5);
	return diffDays(date, event.startDate) % STEP_DAYS[event.repeat] === 0;
}

/** The original start dates of a series from `from` on, in order; endless without an end date. */
export function* seriesDates(
	event: Pick<Series, 'startDate' | 'repeat' | 'repeatUntil'>,
	from = event.startDate
): Generator<string> {
	const { startDate, repeat } = event;
	const until = repeat === 'none' ? startDate : event.repeatUntil;
	const within = (date: string) => !until || date <= until;
	if (repeat === 'none') {
		if (from <= startDate) yield startDate;
		return;
	}
	if (repeat === 'monthly' || repeat === 'yearly') {
		const start = parseDate(startDate);
		const lower = parseDate(from < startDate ? startDate : from);
		const months = repeat === 'monthly' ? 1 : 12;
		const elapsed = (lower.year - start.year) * 12 + (lower.month - start.month);
		for (let index = Math.max(0, Math.floor(elapsed / months)); ; index += 1) {
			const candidate = start.add({ months: index * months });
			// A clamped day means this month or year has no such day.
			if (candidate.day !== start.day) continue;
			const date = candidate.toString();
			if (!within(date)) return;
			if (date >= from) yield date;
		}
	}
	const step = STEP_DAYS[repeat];
	const first = Math.max(0, Math.ceil(diffDays(from, startDate) / step));
	for (let date = addDays(startDate, first * step); within(date); date = addDays(date, step))
		yield date;
}

const overlaps = (start: string, end: string, from: string, to: string) =>
	start <= to && end >= from;

/** Expands events into the occurrences that touch the inclusive range `from`…`to`. */
export function occurrences(events: Series[], from: string, to: string): Occurrence[] {
	const result: Occurrence[] = [];
	for (const event of events) {
		const repeating = event.repeat !== 'none';
		const base = {
			eventId: event.id,
			repeating,
			projectId: event.projectId,
			projectName: event.projectName
		};
		const length = diffDays(event.endDate, event.startDate);
		const changes = new Map(
			repeating
				? event.exceptions
						.filter((exception) => isOccurrence(event, exception.occurrenceDate))
						.map((exception) => [exception.occurrenceDate, exception])
				: []
		);
		for (const date of seriesDates(event, addDays(from, -length))) {
			if (date > to) break;
			if (changes.has(date)) continue;
			result.push({
				...base,
				key: `${event.id}:${date}`,
				occurrenceDate: date,
				title: event.title,
				location: event.location,
				notes: event.notes,
				startDate: date,
				startTime: event.startTime,
				endDate: addDays(date, length),
				endTime: event.endTime,
				modified: false
			});
		}
		// A changed occurrence may have been moved into the range from a date outside it.
		for (const change of changes.values()) {
			if (change.cancelled || !change.startDate || !change.endDate) continue;
			if (!overlaps(change.startDate, change.endDate, from, to)) continue;
			result.push({
				...base,
				key: `${event.id}:${change.occurrenceDate}`,
				occurrenceDate: change.occurrenceDate,
				title: change.title ?? event.title,
				location: change.location ?? '',
				notes: change.notes ?? '',
				startDate: change.startDate,
				startTime: change.startTime,
				endDate: change.endDate,
				endTime: change.endTime,
				modified: true
			});
		}
	}
	return result.sort(
		(a, b) =>
			a.startDate.localeCompare(b.startDate) ||
			(a.startTime ?? '').localeCompare(b.startTime ?? '') ||
			a.title.localeCompare(b.title) ||
			a.key.localeCompare(b.key)
	);
}
/** Whether an occurrence covers the given day. */
export const onDay = (occurrence: Pick<Occurrence, 'startDate' | 'endDate'>, date: string) =>
	occurrence.startDate <= date && occurrence.endDate >= date;

/** The seven days of the week containing `anchor`, starting on the locale's first weekday. */
export function weekDays(anchor: string, locale: string): string[] {
	const first = startOfWeek(parseDate(anchor), locale);
	return Array.from({ length: 7 }, (_, index) => first.add({ days: index }).toString());
}
/** The weeks shown for the month containing `anchor`, including days of adjacent months. */
export function monthGrid(anchor: string, locale: string): string[][] {
	const date = parseDate(anchor);
	const first = startOfWeek(startOfMonth(date), locale);
	return Array.from({ length: getWeeksInMonth(date, locale) }, (_, week) =>
		Array.from({ length: 7 }, (_, day) => first.add({ days: week * 7 + day }).toString())
	);
}

/**
 * Side-by-side placement for timed items of one day: items that overlap share the width,
 * each getting a column index and the column count of its cluster.
 */
export function layoutDay<T extends { key: string; start: number; end: number }>(items: T[]) {
	const placed = new Map<string, { column: number; columns: number }>();
	const sorted = [...items].sort((a, b) => a.start - b.start || b.end - a.end);
	let cluster: T[] = [];
	let clusterEnd = -1;
	let columnEnds: number[] = [];
	const close = () => {
		for (const item of cluster) placed.get(item.key)!.columns = columnEnds.length;
		cluster = [];
		columnEnds = [];
	};
	for (const item of sorted) {
		if (cluster.length && item.start >= clusterEnd) close();
		let column = columnEnds.findIndex((end) => end <= item.start);
		if (column < 0) column = columnEnds.length;
		columnEnds[column] = item.end;
		placed.set(item.key, { column, columns: 1 });
		cluster.push(item);
		clusterEnd = Math.max(clusterEnd, item.end);
	}
	close();
	return placed;
}

/** The instant of a wall-clock date and time in an IANA time zone. */
export function toUtc(date: string, time: string, timeZone: string): Date {
	return toZoned(parseDateTime(`${date}T${time}`), timeZone).toDate();
}
/** The wall-clock date and time of an instant in an IANA time zone. */
export function toWallClock(instant: Date, timeZone: string) {
	const zoned = parseAbsolute(instant.toISOString(), timeZone);
	return {
		date: `${String(zoned.year).padStart(4, '0')}-${pad(zoned.month)}-${pad(zoned.day)}`,
		time: `${pad(zoned.hour)}:${pad(zoned.minute)}`
	};
}
export function isTimeZone(value: string): boolean {
	try {
		new Intl.DateTimeFormat('en', { timeZone: value });
		return true;
	} catch {
		return false;
	}
}
export const browserTimeZone = () => getLocalTimeZone();
/** "09:00 – 10:30", or "All day"; on other days of a longer event only the part that applies. */
export function timeRange(
	occurrence: Pick<Occurrence, 'startDate' | 'startTime' | 'endDate' | 'endTime'>,
	date = occurrence.startDate
): string {
	if (!occurrence.startTime || !occurrence.endTime) return 'All day';
	const starts = date === occurrence.startDate;
	const ends = date === occurrence.endDate;
	if (starts && ends)
		return occurrence.startTime === occurrence.endTime
			? occurrence.startTime
			: `${occurrence.startTime} – ${occurrence.endTime}`;
	if (starts) return `From ${occurrence.startTime}`;
	return ends ? `Until ${occurrence.endTime}` : 'All day';
}
