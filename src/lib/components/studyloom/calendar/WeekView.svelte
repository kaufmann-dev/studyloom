<script lang="ts">
	import type { Occurrence, Task } from '#lib/domain.js';
	import TaskChip from '#lib/components/studyloom/tasks/TaskChip.svelte';
	import { TONES } from '#lib/components/studyloom/tasks/urgency.js';
	import {
		dateOf,
		dayLabel,
		layoutDay,
		localDate,
		localTime,
		minutesOf,
		onDay,
		timeOf,
		timeRange
	} from '#lib/calendar.js';
	import { dueLabel, urgency } from '#lib/tasks.js';
	import EventChip from './EventChip.svelte';

	const HOUR_PX = 48;
	const DAY_MINUTES = 1440;
	/** Shortest block an event is drawn and laid out with, so brief events stay readable. */
	const MIN_MINUTES = 30;
	const FIRST_VISIBLE_HOUR = 7;
	const hours = Array.from({ length: 24 }, (_, hour) => hour);
	let {
		days,
		occurrences,
		tasks,
		now,
		onOpenDay,
		onEvent,
		onTask,
		onSlot
	}: {
		/** The days shown as columns. */
		days: string[];
		occurrences: Occurrence[];
		tasks: Task[];
		now: Date;
		onOpenDay: (date: string) => void;
		onEvent: (occurrence: Occurrence) => void;
		onTask: (task: Task) => void;
		onSlot: (date: string, time: string) => void;
	} = $props();
	let today = $derived(localDate(now));
	let columns = $derived(`3.25rem repeat(${days.length}, minmax(0, 1fr))`);
	let plan = $derived(
		days.map((date) => {
			const onThisDay = occurrences.filter((occurrence) => onDay(occurrence, date));
			const blocks = onThisDay
				.filter((occurrence) => occurrence.startTime && occurrence.endTime)
				.map((occurrence) => {
					const start = date === occurrence.startDate ? minutesOf(occurrence.startTime!) : 0;
					const end = date === occurrence.endDate ? minutesOf(occurrence.endTime!) : DAY_MINUTES;
					return {
						key: occurrence.key,
						occurrence,
						start,
						end: Math.max(end, start + MIN_MINUTES)
					};
				});
			const layout = layoutDay(blocks);
			const due = tasks.filter((task) => task.dueDate === date);
			return {
				date,
				allDay: onThisDay.filter((occurrence) => !occurrence.startTime),
				blocks: blocks.map((block) => ({ ...block, ...layout.get(block.key)! })),
				untimed: due.filter((task) => !task.dueTime),
				timed: due.filter((task) => task.dueTime)
			};
		})
	);
	const offset = (minutes: number) => `${(minutes / 60) * HOUR_PX}px`;
	const scrollToMorning = (node: HTMLElement) => {
		node.scrollTop = FIRST_VISIBLE_HOUR * HOUR_PX;
	};
</script>

<div class="border">
	<div class="grid border-b" style:grid-template-columns={columns}>
		<div></div>
		{#each days as date (date)}
			<button
				type="button"
				class="border-l px-2 py-2 text-left text-xs outline-none hover:bg-muted/40 focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset"
				aria-label={`Open ${dayLabel(date, now)}`}
				aria-current={date === today ? 'date' : undefined}
				onclick={() => onOpenDay(date)}
			>
				<span class="text-muted-foreground"
					>{dateOf(date).toLocaleDateString(undefined, { weekday: 'short' })}</span
				>
				<span
					class={[
						'ml-1 inline-flex size-6 items-center justify-center font-medium',
						date === today && 'bg-foreground text-background'
					]}>{Number(date.slice(8))}</span
				>
			</button>
		{/each}
	</div>
	<div class="grid border-b" style:grid-template-columns={columns}>
		<div class="px-1 py-1.5 text-right text-[0.65rem] text-muted-foreground">All day</div>
		{#each plan as day (day.date)}
			<div class="min-h-8 min-w-0 space-y-0.5 border-l p-1">
				{#each day.untimed as task (task.id)}
					<TaskChip {task} {now} onSelect={onTask} />
				{/each}
				{#each day.allDay as occurrence (occurrence.key)}
					<EventChip {occurrence} date={day.date} onSelect={onEvent} />
				{/each}
			</div>
		{/each}
	</div>
	<div class="max-h-[65vh] overflow-y-auto" {@attach scrollToMorning}>
		<div
			class="relative grid"
			style:grid-template-columns={columns}
			style:height={`${24 * HOUR_PX}px`}
		>
			<div class="relative" aria-hidden="true">
				{#each hours.slice(1) as hour (hour)}
					<span
						class="absolute right-1 -translate-y-1/2 text-[0.65rem] text-muted-foreground"
						style:top={offset(hour * 60)}>{timeOf(hour * 60)}</span
					>
				{/each}
			</div>
			{#each plan as day (day.date)}
				<div class="relative min-w-0 border-l">
					{#each hours as hour (hour)}
						<button
							type="button"
							class="block w-full border-b border-border/60 outline-none hover:bg-muted/40 focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset"
							style:height={`${HOUR_PX}px`}
							aria-label={`Add event on ${dayLabel(day.date, now)} at ${timeOf(hour * 60)}`}
							onclick={() => onSlot(day.date, timeOf(hour * 60))}
						></button>
					{/each}
					{#each day.blocks as block (block.key)}
						<button
							type="button"
							class="absolute flex flex-col items-stretch justify-start overflow-hidden border border-background bg-primary px-1.5 py-0.5 text-left text-xs text-primary-foreground outline-none hover:bg-primary/85 focus-visible:ring-2 focus-visible:ring-ring"
							style:top={offset(block.start)}
							style:height={offset(block.end - block.start)}
							style:left={`${(block.column / block.columns) * 100}%`}
							style:width={`${100 / block.columns}%`}
							aria-label={`Event: ${block.occurrence.title}, ${timeRange(block.occurrence, day.date)}`}
							onclick={() => onEvent(block.occurrence)}
						>
							<span class="block truncate font-medium">{block.occurrence.title}</span>
							<span class="block truncate opacity-90">
								{timeRange(block.occurrence, day.date)}{block.occurrence.location
									? ` · ${block.occurrence.location}`
									: ''}
							</span>
						</button>
					{/each}
					{#each day.timed as task (task.id)}
						{@const tone = TONES[urgency(task, now)]}
						<button
							type="button"
							class={[
								'absolute inset-x-0 z-10 flex -translate-y-px items-start border-t-2 text-left outline-none focus-visible:ring-2 focus-visible:ring-ring',
								tone.line
							]}
							style:top={offset(minutesOf(task.dueTime!))}
							aria-label={`Task: ${task.title}, ${dueLabel(task, now)}`}
							onclick={() => onTask(task)}
						>
							<span class={['ml-auto max-w-full truncate border px-1 text-[0.65rem]', tone.chip]}>
								{task.dueTime}
								{task.title}
							</span>
						</button>
					{/each}
					{#if day.date === today}
						<div
							class="pointer-events-none absolute inset-x-0 z-20 border-t-2 border-foreground"
							style:top={offset(minutesOf(localTime(now)))}
							aria-hidden="true"
						>
							<span class="absolute -top-1 -left-1 size-2 rounded-full bg-foreground"></span>
						</div>
					{/if}
				</div>
			{/each}
		</div>
	</div>
</div>
