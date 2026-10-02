<script lang="ts">
	import { CalendarPlus, ListPlus } from '@lucide/svelte';
	import type { Occurrence, Task } from '#lib/domain.js';
	import Button from '#lib/components/ui/button/button.svelte';
	import * as Dialog from '#lib/components/ui/dialog/index.js';
	import TaskList from '#lib/components/studyloom/tasks/TaskList.svelte';
	import { dateOf } from '#lib/calendar.js';
	import EventList from './EventList.svelte';

	let {
		date,
		occurrences,
		tasks,
		now,
		onEvent,
		onAddEvent,
		onAddTask,
		onClose
	}: {
		date: string;
		occurrences: Occurrence[];
		tasks: Task[];
		now: Date;
		onEvent: (occurrence: Occurrence) => void;
		onAddEvent: (date: string) => void;
		onAddTask: (date: string) => void;
		onClose: () => void;
	} = $props();
	let title = $derived(
		dateOf(date).toLocaleDateString(undefined, {
			weekday: 'long',
			day: 'numeric',
			month: 'long',
			year: 'numeric'
		})
	);
</script>

<Dialog.Root open onOpenChange={(open) => !open && onClose()}>
	<Dialog.Content class="max-h-[calc(100dvh-2rem)] overflow-y-auto sm:max-w-lg">
		<Dialog.Header>
			<Dialog.Title>{title}</Dialog.Title>
			<Dialog.Description>Events and deadlines on this day.</Dialog.Description>
		</Dialog.Header>
		{#if occurrences.length === 0 && tasks.length === 0}
			<p class="border border-dashed p-5 text-sm text-muted-foreground">Nothing planned.</p>
		{/if}
		{#if occurrences.length}
			<section class="space-y-2" aria-label="Events">
				<h3 class="text-sm font-semibold">Events</h3>
				<EventList {occurrences} {now} {date} onSelect={onEvent} />
			</section>
		{/if}
		{#if tasks.length}
			<section class="space-y-2" aria-label="Tasks">
				<h3 class="text-sm font-semibold">Tasks due</h3>
				<TaskList {tasks} />
			</section>
		{/if}
		<Dialog.Footer>
			<Button variant="outline" onclick={() => onAddTask(date)}><ListPlus />Add task</Button>
			<Button onclick={() => onAddEvent(date)}><CalendarPlus />Add event</Button>
		</Dialog.Footer>
	</Dialog.Content>
</Dialog.Root>
