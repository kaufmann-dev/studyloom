<script lang="ts">
	import { GraduationCap, Square } from '@lucide/svelte';
	import type { Task } from '#lib/domain.js';
	import { dueLabel, taskSchedule, urgency } from '#lib/tasks.js';
	import { TONES } from './urgency.js';

	let { task, now, onSelect }: { task: Task; now: Date; onSelect: (task: Task) => void } = $props();
	let tone = $derived(TONES[urgency(task, now)]);
</script>

<button
	type="button"
	class={[
		'relative flex w-full min-w-0 items-center gap-1 border px-1.5 py-0.5 text-left text-xs outline-none hover:brightness-95 focus-visible:ring-2 focus-visible:ring-ring',
		tone.chip
	]}
	title={taskSchedule(task, now)}
	aria-label={`${task.source === 'moodle' ? 'Moodle task' : 'Task'}: ${task.title}, ${task.opensDate || task.moodleFeedbackOpening ? taskSchedule(task, now) : dueLabel(task, now)}`}
	onclick={() => onSelect(task)}
>
	<Square class="size-3 shrink-0" />
	{#if task.source === 'moodle'}<GraduationCap class="size-3 shrink-0" />{/if}
	<span class="truncate"
		>{task.moodleFeedbackOpening ? 'Opens ' : ''}{task.dueTime
			? `${task.dueTime} `
			: ''}{task.title}</span
	>
</button>
