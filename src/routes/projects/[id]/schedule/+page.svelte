<script lang="ts">
	import { onMount } from 'svelte';
	import { CalendarPlus, ListPlus } from '@lucide/svelte';
	import type { Occurrence } from '#lib/domain.js';
	import Button from '#lib/components/ui/button/button.svelte';
	import EventDialog from '#lib/components/studyloom/calendar/EventDialog.svelte';
	import EventList from '#lib/components/studyloom/calendar/EventList.svelte';
	import TaskDialog from '#lib/components/studyloom/tasks/TaskDialog.svelte';
	import TaskList from '#lib/components/studyloom/tasks/TaskList.svelte';
	import { addDays, localDate, occurrences } from '#lib/calendar.js';
	import { Events } from '#lib/calendar.svelte.js';
	import { getProject } from '#lib/project.svelte.js';
	import { getTasks } from '#lib/tasks.svelte.js';

	const SCHEDULE_DAYS = 60;
	const { projectId } = getProject();
	const tasks = getTasks();
	const events = new Events();
	let addingTask = $state(false);
	/** The event dialog: an occurrence to edit, or `true` for a new event. */
	let eventOpen = $state.raw<Occurrence | true | null>(null);
	let now = $derived(tasks.clock.now);
	let today = $derived(localDate(now));
	let projectTasks = $derived(tasks.open.filter((task) => task.projectId === projectId));
	let projectEvents = $derived(occurrences(events.items, today, addDays(today, SCHEDULE_DAYS)));

	onMount(() => {
		// The calendar and task pages report loading failures; here an empty list is enough.
		const start = localDate(new Date());
		void events.load(start, addDays(start, SCHEDULE_DAYS), projectId).catch(() => {});
	});
</script>

<div class="max-w-3xl space-y-6">
	<div class="flex flex-wrap gap-2">
		<Button variant="outline" size="sm" onclick={() => (addingTask = true)}>
			<ListPlus />Add task
		</Button>
		<Button variant="outline" size="sm" onclick={() => (eventOpen = true)}>
			<CalendarPlus />Add event
		</Button>
	</div>
	<section aria-labelledby="schedule-tasks" class="space-y-3">
		<h2 id="schedule-tasks" class="text-sm font-semibold">Open tasks</h2>
		{#if projectTasks.length}
			<TaskList tasks={projectTasks} showProject={false} />
		{:else}
			<p class="border border-dashed p-5 text-sm text-muted-foreground">No open tasks.</p>
		{/if}
	</section>
	<section aria-labelledby="schedule-events" class="space-y-3">
		<h2 id="schedule-events" class="text-sm font-semibold">Next {SCHEDULE_DAYS} days</h2>
		{#if projectEvents.length}
			<EventList
				occurrences={projectEvents}
				{now}
				showDay
				showProject={false}
				onSelect={(occurrence) => (eventOpen = occurrence)}
			/>
		{:else}
			<p class="border border-dashed p-5 text-sm text-muted-foreground">No upcoming events.</p>
		{/if}
	</section>
</div>
{#if addingTask}
	<TaskDialog initial={{ dueDate: today, projectId }} onClose={() => (addingTask = false)} />
{/if}
{#if eventOpen}
	{@const occurrence = eventOpen === true ? undefined : eventOpen}
	<EventDialog
		{events}
		event={occurrence && events.find(occurrence.eventId)}
		{occurrence}
		initial={{ startDate: today, endDate: today, projectId }}
		onClose={() => (eventOpen = null)}
	/>
{/if}
