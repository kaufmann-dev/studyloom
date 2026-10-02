<script lang="ts">
	import { Square } from '@lucide/svelte';
	import type { Task } from '#lib/domain.js';
	import { dueLabel, urgency } from '#lib/tasks.js';
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
	aria-label={`Task: ${task.title}, ${dueLabel(task, now)}`}
	onclick={() => onSelect(task)}
>
	<Square class="size-3 shrink-0" />
	<span class="truncate">{task.dueTime ? `${task.dueTime} ` : ''}{task.title}</span>
</button>
