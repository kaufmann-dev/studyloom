import { randomUUID } from 'node:crypto';
import { parseDate, parseDateTime } from '@internationalized/date';
import {
	addDays,
	addMinutes,
	diffDays,
	isOccurrence,
	isTimeZone,
	seriesDates,
	toUtc,
	toWallClock
} from '../calendar';
import { eventInput, occurrenceInput, taskInput, type Repeat } from '../domain';
import { ClientError } from './config';

export interface ParsedException {
	occurrenceDate: string;
	cancelled: boolean;
	title: string | null;
	location: string | null;
	notes: string | null;
	startDate: string | null;
	startTime: string | null;
	endDate: string | null;
	endTime: string | null;
}
export interface ParsedEvent {
	uid: string;
	title: string;
	location: string;
	notes: string;
	startDate: string;
	startTime: string | null;
	endDate: string;
	endTime: string | null;
	repeat: Repeat;
	repeatUntil: string | null;
	exceptions: ParsedException[];
}
export interface ParsedTask {
	uid: string;
	title: string;
	notes: string;
	dueDate: string;
	dueTime: string | null;
	completedAt: Date | null;
}
export interface ParsedCalendar {
	events: ParsedEvent[];
	tasks: ParsedTask[];
	skipped: { reason: string; count: number }[];
}

const MAX_COMPONENTS = 5000;
const MAX_COUNT = 5000;
const WEEKDAYS = ['SU', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA'];
const RULE_KEYS = new Set([
	'FREQ',
	'INTERVAL',
	'UNTIL',
	'COUNT',
	'BYDAY',
	'BYMONTHDAY',
	'BYMONTH',
	'WKST'
]);
const NOT_A_CALENDAR = 'This file is not an iCalendar file.';

interface Property {
	params: Record<string, string>;
	value: string;
}
interface Component {
	name: string;
	properties: Map<string, Property[]>;
}
interface Moment {
	date: string;
	/** Empty for a date without a time. */
	time: string;
}

/** Splits one unfolded content line into name, parameters and value. */
function parseLine(line: string): { name: string; property: Property } | undefined {
	let quoted = false;
	let colon = -1;
	const breaks: number[] = [];
	for (let index = 0; index < line.length; index += 1) {
		const character = line[index];
		if (character === '"') quoted = !quoted;
		else if (!quoted && character === ';') breaks.push(index);
		else if (!quoted && character === ':') {
			colon = index;
			break;
		}
	}
	if (colon < 1) return undefined;
	const bounds = [...breaks, colon];
	const params: Record<string, string> = {};
	for (let index = 0; index < breaks.length; index += 1) {
		const [key, ...rest] = line.slice(bounds[index] + 1, bounds[index + 1]).split('=');
		params[key.toUpperCase()] = rest.join('=').replace(/^"|"$/g, '');
	}
	return {
		name: line.slice(0, bounds[0]).toUpperCase(),
		property: { params, value: line.slice(colon + 1) }
	};
}
function components(text: string): Component[] {
	const lines: string[] = [];
	for (const raw of (text.charCodeAt(0) === 0xfeff ? text.slice(1) : text).split(/\r?\n/)) {
		if (/^[ \t]/.test(raw) && lines.length) lines[lines.length - 1] += raw.slice(1);
		else if (raw) lines.push(raw);
	}
	if (lines[0]?.trim().toUpperCase() !== 'BEGIN:VCALENDAR')
		throw new ClientError(400, NOT_A_CALENDAR);
	const found: Component[] = [];
	const stack: Component[] = [];
	for (const line of lines) {
		const parsed = parseLine(line);
		if (!parsed) continue;
		const { name, property } = parsed;
		if (name === 'BEGIN') {
			const component = { name: property.value.trim().toUpperCase(), properties: new Map() };
			stack.push(component);
			if (component.name === 'VEVENT' || component.name === 'VTODO') {
				found.push(component);
				if (found.length > MAX_COMPONENTS)
					throw new ClientError(400, `A calendar file can hold at most ${MAX_COMPONENTS} entries.`);
			}
		} else if (name === 'END') stack.pop();
		else {
			const properties = stack.at(-1)?.properties;
			if (properties) properties.set(name, [...(properties.get(name) ?? []), property]);
		}
	}
	return found;
}
const unescapeText = (value: string) =>
	value.replace(/\\([\s\S])/g, (_, character: string) =>
		character === 'n' || character === 'N' ? '\n' : character
	);

class Reader {
	constructor(
		private readonly component: Component,
		private readonly timeZone: string
	) {}
	all(name: string) {
		return this.component.properties.get(name) ?? [];
	}
	raw(name: string) {
		return this.all(name)[0]?.value.trim() ?? '';
	}
	text(name: string, limit: number) {
		return unescapeText(this.all(name)[0]?.value ?? '').slice(0, limit);
	}
	/** Reads a date or date-time into wall-clock time of the importing time zone. */
	moment(property: Property | undefined): Moment | undefined {
		if (!property) return undefined;
		return this.value(property.value, property.params.TZID);
	}
	value(value: string, zone?: string): Moment | undefined {
		const match = /^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})\d{2}(Z?))?$/.exec(value.trim());
		if (!match) return undefined;
		const [, year, month, day, hours, minutes, isUtc] = match;
		const date = `${year}-${month}-${day}`;
		const time = hours === undefined ? '' : `${hours}:${minutes}`;
		try {
			parseDateTime(`${date}T${time || '00:00'}`);
			if (!time) return { date, time };
			if (isUtc) return toWallClock(new Date(`${date}T${time}:00Z`), this.timeZone);
			// An unknown zone name cannot be converted, so its time is kept as written.
			if (zone && isTimeZone(zone)) return toWallClock(toUtc(date, time, zone), this.timeZone);
		} catch {
			return undefined;
		}
		return { date, time };
	}
}

/** Minutes of an iCalendar duration such as `P1DT2H30M` or `P2W`. */
function durationMinutes(value: string): number | undefined {
	const match = /^\+?P(?:(\d+)W)?(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/.exec(value);
	if (!match) return undefined;
	const [, weeks, days, hours, minutes] = match.map((part) => Number(part ?? 0));
	return ((weeks * 7 + days) * 24 + hours) * 60 + minutes;
}
interface Span {
	startDate: string;
	startTime: string | null;
	endDate: string;
	endTime: string | null;
}
function readSpan(reader: Reader): Span | undefined {
	const start = reader.moment(reader.all('DTSTART')[0]);
	if (!start) return undefined;
	const end = reader.moment(reader.all('DTEND')[0]);
	const duration = durationMinutes(reader.raw('DURATION'));
	if (!start.time) {
		// An all-day end is exclusive in the file and inclusive here.
		let endDate = start.date;
		if (end) endDate = addDays(end.date, -1);
		else if (duration) endDate = addDays(start.date, Math.ceil(duration / 1440) - 1);
		return {
			startDate: start.date,
			startTime: null,
			endDate: endDate < start.date ? start.date : endDate,
			endTime: null
		};
	}
	let finish = { date: start.date, time: start.time };
	if (end) finish = { date: end.date, time: end.time || start.time };
	else if (duration) finish = addMinutes(start.date, start.time, duration);
	if (`${finish.date}T${finish.time}` < `${start.date}T${start.time}`) finish = start;
	return {
		startDate: start.date,
		startTime: start.time,
		endDate: finish.date,
		endTime: finish.time
	};
}

interface Rule {
	repeat: Repeat;
	/** First dates of the series this rule splits into; one unless several weekdays repeat. */
	starts: string[];
	until: string | null;
}
/** Maps a repeat rule onto the repeats Studyloom has, or nothing when it has no equivalent. */
function readRule(reader: Reader, span: Span): Rule | undefined {
	const parts = new Map<string, string>();
	for (const part of reader.raw('RRULE').split(';')) {
		const [key, value = ''] = part.split('=');
		if (key) parts.set(key.toUpperCase(), value.toUpperCase());
	}
	if ([...parts.keys()].some((key) => !RULE_KEYS.has(key))) return undefined;
	const interval = Number(parts.get('INTERVAL') ?? 1);
	const start = parseDate(span.startDate);
	const numbers = (key: string) => parts.get(key)?.split(',').map(Number);
	const restates = (key: string, expected: number) => {
		const values = numbers(key);
		return !values || (values.length === 1 && values[0] === expected);
	};
	let repeat: Repeat;
	let starts = [span.startDate];
	const frequency = parts.get('FREQ');
	const days = parts.get('BYDAY')?.split(',');
	if (frequency === 'WEEKLY') {
		if ((interval !== 1 && interval !== 2) || parts.has('BYMONTHDAY') || parts.has('BYMONTH'))
			return undefined;
		repeat = interval === 1 ? 'weekly' : 'biweekly';
		if (days) {
			if (days.some((day) => !WEEKDAYS.includes(day))) return undefined;
			const weekStart = WEEKDAYS.indexOf(parts.get('WKST') ?? 'MO');
			if (weekStart < 0) return undefined;
			const position = (weekday: number) => (weekday - weekStart + 7) % 7;
			const startDay = new Date(`${span.startDate}T00:00:00Z`).getUTCDay();
			// A weekday earlier in the week than the start first occurs one interval later.
			starts = [...new Set(days)]
				.map((day) => position(WEEKDAYS.indexOf(day)) - position(startDay))
				.map((offset) => addDays(span.startDate, offset < 0 ? offset + 7 * interval : offset))
				.sort();
		}
	} else {
		if (interval !== 1 || days) return undefined;
		if (frequency === 'DAILY' && !parts.has('BYMONTHDAY') && !parts.has('BYMONTH'))
			repeat = 'daily';
		else if (frequency === 'MONTHLY' && !parts.has('BYMONTH') && restates('BYMONTHDAY', start.day))
			repeat = 'monthly';
		else if (
			frequency === 'YEARLY' &&
			restates('BYMONTH', start.month) &&
			restates('BYMONTHDAY', start.day)
		)
			repeat = 'yearly';
		else return undefined;
	}
	let until: string | null = null;
	if (parts.has('UNTIL')) {
		const last = reader.value(parts.get('UNTIL')!);
		if (!last) return undefined;
		// An occurrence on the final day only happens if it starts by the final time.
		until =
			last.time && span.startTime && last.time < span.startTime
				? addDays(last.date, -1)
				: last.date;
	} else if (parts.has('COUNT')) {
		const count = Number(parts.get('COUNT'));
		if (!Number.isInteger(count) || count < 1 || count > MAX_COUNT) return undefined;
		const series = starts.map((startDate) => seriesDates({ startDate, repeat, repeatUntil: null }));
		const heads = series.map((dates) => dates.next().value as string);
		for (let taken = 0; taken < count; taken += 1) {
			const next = heads.indexOf([...heads].sort()[0]);
			until = heads[next];
			heads[next] = series[next].next().value as string;
		}
	}
	return { repeat, starts: until ? starts.filter((date) => date <= until) : starts, until };
}

/**
 * Reads an iCalendar file into events and tasks. Times given in UTC or a known time zone
 * become wall-clock time in `timeZone`; everything else is kept as written.
 */
export function parseIcs(text: string, timeZone: string): ParsedCalendar {
	const skips = new Map<string, number>();
	const skip = (reason: string) => void skips.set(reason, (skips.get(reason) ?? 0) + 1);
	const events = new Map<string, ParsedEvent[]>();
	const changes: { uid: string; reader: Reader }[] = [];
	const tasks = new Map<string, ParsedTask>();
	const content = (reader: Reader) => ({
		title: reader.text('SUMMARY', 200).trim() || 'Untitled',
		location: reader.text('LOCATION', 300),
		notes: reader.text('DESCRIPTION', 4000)
	});
	const cancelled = (reader: Reader) => reader.raw('STATUS').toUpperCase() === 'CANCELLED';

	for (const component of components(text)) {
		const reader = new Reader(component, timeZone);
		const uid = reader.raw('UID').slice(0, 500) || `${randomUUID()}@studyloom`;
		if (component.name === 'VTODO') {
			const due = reader.moment(reader.all('DUE')[0] ?? reader.all('DTSTART')[0]);
			if (cancelled(reader)) skip('Cancelled entries');
			else if (!due) skip('Tasks without a due date');
			else if (tasks.has(uid)) skip('Duplicate entries');
			else {
				const completed = reader.all('COMPLETED')[0];
				const done = reader.raw('STATUS').toUpperCase() === 'COMPLETED' || Boolean(completed);
				const stamp = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/.exec(
					completed?.value.trim() ?? ''
				);
				const task = {
					uid,
					title: content(reader).title,
					notes: content(reader).notes,
					dueDate: due.date,
					dueTime: due.time || null,
					completedAt: !done
						? null
						: stamp
							? new Date(`${stamp.slice(1, 4).join('-')}T${stamp.slice(4, 7).join(':')}Z`)
							: new Date()
				};
				if (taskInput.safeParse({ ...task, dueTime: task.dueTime ?? '' }).success)
					tasks.set(uid, task);
				else skip('Entries that could not be read');
			}
			continue;
		}
		if (reader.all('RECURRENCE-ID').length) {
			changes.push({ uid, reader });
			continue;
		}
		const span = readSpan(reader);
		if (cancelled(reader)) skip('Cancelled entries');
		else if (!span) skip('Events without a start date');
		else if (events.has(uid)) skip('Duplicate entries');
		else {
			const rule = reader.raw('RRULE') ? readRule(reader, span) : undefined;
			if (reader.raw('RRULE') && !rule)
				skip('Repeat rules without an equivalent (imported as single events)');
			const length = diffDays(span.endDate, span.startDate);
			const series = (rule?.starts ?? [span.startDate]).map(
				(startDate, index, all): ParsedEvent => ({
					uid: all.length > 1 ? `${uid}-${index + 1}` : uid,
					...content(reader),
					...span,
					startDate,
					endDate: addDays(startDate, length),
					repeat: rule?.repeat ?? 'none',
					repeatUntil: rule?.until ?? null,
					exceptions: []
				})
			);
			const valid = series.filter(
				(event) =>
					eventInput.safeParse({
						...event,
						startTime: event.startTime ?? '',
						endTime: event.endTime ?? '',
						repeatUntil: event.repeatUntil ?? '',
						projectId: null
					}).success
			);
			if (valid.length < series.length || !valid.length) skip('Entries that could not be read');
			if (!valid.length) continue;
			for (const property of reader.all('EXDATE'))
				for (const value of property.value.split(',')) {
					const date = reader.value(value, property.params.TZID)?.date;
					const owner = date && valid.find((event) => isOccurrence(event, date));
					if (owner && date)
						owner.exceptions.push({
							occurrenceDate: date,
							cancelled: true,
							title: null,
							location: null,
							notes: null,
							startDate: null,
							startTime: null,
							endDate: null,
							endTime: null
						});
				}
			events.set(uid, valid);
		}
	}
	for (const { uid, reader } of changes) {
		const date = reader.moment(reader.all('RECURRENCE-ID')[0])?.date;
		const owner =
			date &&
			events.get(uid)?.find((event) => event.repeat !== 'none' && isOccurrence(event, date));
		if (!owner || !date) {
			skip('Changed occurrences without their series');
			continue;
		}
		const span = readSpan(reader);
		const override = span && { ...content(reader), ...span };
		const usable =
			override &&
			occurrenceInput.safeParse({
				...override,
				startTime: override.startTime ?? '',
				endTime: override.endTime ?? ''
			}).success;
		if (!cancelled(reader) && !usable) {
			skip('Entries that could not be read');
			continue;
		}
		owner.exceptions = owner.exceptions.filter((existing) => existing.occurrenceDate !== date);
		owner.exceptions.push(
			cancelled(reader) || !override
				? {
						occurrenceDate: date,
						cancelled: true,
						title: null,
						location: null,
						notes: null,
						startDate: null,
						startTime: null,
						endDate: null,
						endTime: null
					}
				: { occurrenceDate: date, cancelled: false, ...override }
		);
	}
	return {
		events: [...events.values()].flat(),
		tasks: [...tasks.values()],
		skipped: [...skips].map(([reason, count]) => ({ reason, count }))
	};
}
