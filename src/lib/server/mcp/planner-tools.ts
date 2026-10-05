import type { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import { addDays, diffDays, occurrences } from '../../calendar';
import {
	eventInput,
	eventPatchInput,
	exceptionInput,
	idSchema,
	occurrencePatchInput,
	taskInput,
	taskPatchInput
} from '../../domain';
import {
	createEvent,
	deleteEvent,
	getEvent,
	listEvents,
	rangeInput,
	restoreOccurrence,
	setOccurrence,
	updateEvent
} from '../endpoints/events';
import { createTask, deleteTask, listTasks, updateTask } from '../endpoints/tasks';
import { guard } from './result';

const taskId = idSchema.describe('Task ID from list_tasks.');
const eventId = idSchema.describe('Event ID from list_events.');
const readOnly = { readOnlyHint: true };
const additive = { destructiveHint: false };
const TASK_FIELDS =
	'dueDate is YYYY-MM-DD; dueTime is HH:MM, or empty for no time. projectId links the task to a project.';
const EVENT_FIELDS =
	'Dates are YYYY-MM-DD and times HH:MM; leave both times empty for an all-day event. endDate equals startDate for a single-day event. repeat is none, daily, weekly, biweekly, monthly or yearly; repeatUntil is an optional last date.';

/** The occurrence as it stands: its own change if it has one, otherwise as the series defines it. */
async function currentOccurrence(id: string, occurrenceDate: string) {
	const event = await getEvent(id);
	const change = event.exceptions.find(
		(exception) => exception.occurrenceDate === occurrenceDate && !exception.cancelled
	);
	if (change)
		return {
			title: change.title ?? event.title,
			location: change.location ?? '',
			notes: change.notes ?? '',
			startDate: change.startDate ?? occurrenceDate,
			startTime: change.startTime ?? '',
			endDate: change.endDate ?? occurrenceDate,
			endTime: change.endTime ?? ''
		};
	return {
		title: event.title,
		location: event.location,
		notes: event.notes,
		startDate: occurrenceDate,
		startTime: event.startTime ?? '',
		endDate: addDays(occurrenceDate, diffDays(event.endDate, event.startDate)),
		endTime: event.endTime ?? ''
	};
}

export function registerPlannerTools(server: McpServer) {
	server.registerTool(
		'list_tasks',
		{
			title: 'List tasks',
			description:
				'Lists open tasks by due date, or the 200 most recently completed tasks with status "done".',
			inputSchema: z.object({ status: z.enum(['open', 'done']).default('open') }),
			annotations: readOnly
		},
		({ status }) => guard(async () => ({ tasks: await listTasks(status) }))
	);
	server.registerTool(
		'create_task',
		{
			title: 'Create task',
			description: `Creates a task. ${TASK_FIELDS}`,
			inputSchema: taskInput,
			annotations: additive
		},
		(input) => guard(async () => ({ task: await createTask(input) }))
	);
	server.registerTool(
		'update_task',
		{
			title: 'Update task',
			description: `Changes the given fields of a task; omitted fields stay. Set done to complete or reopen it. ${TASK_FIELDS}`,
			inputSchema: taskPatchInput.extend({ taskId })
		},
		({ taskId, ...patch }) => guard(async () => ({ task: await updateTask(taskId, patch) }))
	);
	server.registerTool(
		'delete_task',
		{
			title: 'Delete task',
			description: 'Deletes a task permanently. Prefer update_task with done for finished tasks.',
			inputSchema: z.object({ taskId })
		},
		({ taskId }) =>
			guard(async () => {
				await deleteTask(taskId);
				return { deleted: taskId };
			})
	);
	server.registerTool(
		'list_events',
		{
			title: 'List calendar events',
			description:
				'Lists the calendar occurrences between two dates (inclusive, at most 400 days), with repeating events expanded and single-occurrence changes applied.',
			inputSchema: rangeInput,
			annotations: readOnly
		},
		(range) =>
			guard(async () => {
				const series = await listEvents(range);
				const byId = new Map(series.map((event) => [event.id, event]));
				return {
					occurrences: occurrences(series, range.from, range.to).map((o) => ({
						...o,
						repeat: byId.get(o.eventId)?.repeat,
						repeatUntil: byId.get(o.eventId)?.repeatUntil
					}))
				};
			})
	);
	server.registerTool(
		'create_event',
		{
			title: 'Create event',
			description: `Creates a calendar event or repeating series. ${EVENT_FIELDS}`,
			inputSchema: eventInput,
			annotations: additive
		},
		(input) => guard(async () => ({ event: await createEvent(input) }))
	);
	server.registerTool(
		'update_event',
		{
			title: 'Update event',
			description: `Changes the given fields of a whole event series; omitted fields stay. A new startDate or repeat drops all single-occurrence changes. ${EVENT_FIELDS}`,
			inputSchema: eventPatchInput.extend({ eventId })
		},
		({ eventId, ...patch }) => guard(async () => ({ event: await updateEvent(eventId, patch) }))
	);
	server.registerTool(
		'update_occurrence',
		{
			title: 'Change one occurrence',
			description:
				'Changes one occurrence of a repeating event, identified by its original occurrenceDate from list_events. "cancel" skips it, "change" moves or edits it (omitted fields keep their current values), and "restore" undoes an earlier cancel or change.',
			inputSchema: occurrencePatchInput.extend({
				eventId,
				occurrenceDate: z.iso.date().describe('The occurrenceDate from list_events.'),
				action: z.enum(['cancel', 'change', 'restore'])
			})
		},
		({ eventId, occurrenceDate, action, ...changes }) =>
			guard(async () => {
				if (action === 'restore')
					return { event: await restoreOccurrence(eventId, occurrenceDate) };
				const input =
					action === 'cancel'
						? exceptionInput.parse({ cancelled: true })
						: exceptionInput.parse({
								...(await currentOccurrence(eventId, occurrenceDate)),
								...changes
							});
				return { event: await setOccurrence(eventId, occurrenceDate, input) };
			})
	);
	server.registerTool(
		'delete_event',
		{
			title: 'Delete event',
			description:
				'Deletes an event and, for a repeating event, every occurrence. To skip one occurrence use update_occurrence with "cancel".',
			inputSchema: z.object({ eventId })
		},
		({ eventId }) =>
			guard(async () => {
				await deleteEvent(eventId);
				return { deleted: eventId };
			})
	);
}
