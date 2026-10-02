<script lang="ts">
	import type { Occurrence, Task } from '#lib/domain.js';
	import TaskChip from '#lib/components/studyloom/tasks/TaskChip.svelte';
	import { TONES } from '#lib/components/studyloom/tasks/urgency.js';
	import { dateOf, dayLabel, localDate, onDay } from '#lib/calendar.js';
	import { urgency } from '#lib/tasks.js';
	import { plural } from '#lib/ui.js';
	import EventChip from './EventChip.svelte';

	const VISIBLE = 3;
	let {
		weeks,
		anchor,
		occurrences,
		tasks,
		now,
		onOpenDay,
		onEvent,
		onTask
	}: {
		weeks: string[][];
		/** Any day of the month being shown; days of other months are dimmed. */
		anchor: string;
		occurrences: Occurrence[];
		tasks: Task[];
		now: Date;
		onOpenDay: (date: string) => void;
		onEvent: (occurrence: Occurrence) => void;
		onTask: (task: Task) => void;
	} = $props();
	let today = $derived(localDate(now));
	let days = $derived(
		new Map(
			weeks.flat().map((date) => [
				date,
				{
					tasks: tasks.filter((task) => task.dueDate === date),
					events: occurrences.filter((occurrence) => onDay(occurrence, date))
				}
			])
		)
	);
</script>

<div class="border-t border-l">
	<div class="grid grid-cols-7" aria-hidden="true">
		{#each weeks[0] as date (date)}
			<div class="border-r border-b px-2 py-1.5 text-xs font-medium text-muted-foreground">
				{dateOf(date).toLocaleDateString(undefined, { weekday: 'short' })}
			</div>
		{/each}
	</div>
	{#each weeks as week (week[0])}
		<div class="grid grid-cols-7">
			{#each week as date (date)}
				{@const day = days.get(date)!}
				{@const count = day.tasks.length + day.events.length}
				<div
					class={[
						'relative min-h-16 min-w-0 border-r border-b p-1 hover:bg-muted/40 md:min-h-28',
						date.slice(0, 7) !== anchor.slice(0, 7) && 'bg-muted/30 text-muted-foreground'
					]}
				>
					<!-- The stretched button makes the whole cell open the day; chips sit above it. -->
					<button
						type="button"
						class="outline-none after:absolute after:inset-0 focus-visible:after:ring-2 focus-visible:after:ring-ring focus-visible:after:ring-inset"
						aria-label={`${dayLabel(date, now)}, ${count ? plural(count, 'item') : 'nothing planned'}`}
						aria-current={date === today ? 'date' : undefined}
						onclick={() => onOpenDay(date)}
					>
						<span
							class={[
								'flex size-6 items-center justify-center text-xs',
								date === today && 'bg-foreground font-semibold text-background'
							]}>{Number(date.slice(8))}</span
						>
					</button>
					<div class="mt-1 hidden space-y-0.5 md:block">
						{#each day.tasks.slice(0, VISIBLE) as task (task.id)}
							<TaskChip {task} {now} onSelect={onTask} />
						{/each}
						{#each day.events.slice(0, Math.max(0, VISIBLE - day.tasks.length)) as occurrence (occurrence.key)}
							<EventChip {occurrence} {date} onSelect={onEvent} />
						{/each}
						{#if count > VISIBLE}
							<p class="px-1 text-xs text-muted-foreground">+{count - VISIBLE} more</p>
						{/if}
					</div>
					<div class="mt-1 flex flex-wrap gap-1 md:hidden" aria-hidden="true">
						{#each day.tasks.slice(0, VISIBLE) as task (task.id)}
							<span class={['size-1.5 rounded-full', TONES[urgency(task, now)].dot]}></span>
						{/each}
						{#each day.events.slice(0, VISIBLE) as occurrence (occurrence.key)}
							<span class="size-1.5 bg-primary"></span>
						{/each}
					</div>
				</div>
			{/each}
		</div>
	{/each}
</div>
