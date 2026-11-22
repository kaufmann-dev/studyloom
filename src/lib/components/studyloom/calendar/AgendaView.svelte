<script lang="ts">
	import type { Occurrence, Task } from '#lib/domain.js';
	import Button from '#lib/components/ui/button/button.svelte';
	import TaskList from '#lib/components/studyloom/tasks/TaskList.svelte';
	import { addDays, onDay, relativeDay } from '#lib/calendar.js';
	import EventList from './EventList.svelte';

	let {
		from,
		days,
		occurrences,
		tasks,
		now,
		onEvent,
		onMore
	}: {
		from: string;
		/** How many days the list covers. */
		days: number;
		occurrences: Occurrence[];
		tasks: Task[];
		now: Date;
		onEvent: (occurrence: Occurrence) => void;
		onMore: () => void;
	} = $props();
	let overdue = $derived(
		tasks.filter((task) => !task.moodleFeedbackOpening && task.dueDate < from)
	);
	let agenda = $derived(
		Array.from({ length: days }, (_, index) => addDays(from, index))
			.map((date) => ({
				date,
				tasks: tasks.filter((task) => task.dueDate === date),
				events: occurrences.filter((occurrence) => onDay(occurrence, date))
			}))
			.filter((day) => day.tasks.length || day.events.length)
	);
</script>

<div class="space-y-7">
	{#if overdue.length}
		<section aria-labelledby="agenda-overdue">
			<h2 id="agenda-overdue" class="mb-2 text-sm font-semibold text-destructive">Overdue</h2>
			<TaskList tasks={overdue} />
		</section>
	{/if}
	{#each agenda as day (day.date)}
		<section aria-label={relativeDay(day.date, now)}>
			<h2 class="mb-2 text-sm font-semibold">{relativeDay(day.date, now)}</h2>
			<div class="space-y-2">
				{#if day.tasks.length}<TaskList tasks={day.tasks} />{/if}
				{#if day.events.length}
					<EventList occurrences={day.events} {now} date={day.date} onSelect={onEvent} />
				{/if}
			</div>
		</section>
	{:else}
		{#if !overdue.length}
			<p class="border border-dashed px-6 py-12 text-muted-foreground">
				Nothing planned in these {days} days.
			</p>
		{/if}
	{/each}
	<Button variant="outline" onclick={onMore}>Show more days</Button>
</div>
