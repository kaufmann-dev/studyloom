<script lang="ts">
	import { GraduationCap, Repeat } from '@lucide/svelte';
	import type { Occurrence } from '#lib/domain.js';
	import { timeRange } from '#lib/calendar.js';

	let {
		occurrence,
		date = occurrence.startDate,
		onSelect
	}: {
		occurrence: Occurrence;
		/** The day the chip is shown on, for events that span several days. */
		date?: string;
		onSelect: (occurrence: Occurrence) => void;
	} = $props();
	let time = $derived(
		occurrence.startTime && date === occurrence.startDate ? `${occurrence.startTime} ` : ''
	);
</script>

<button
	type="button"
	class={[
		'relative flex w-full min-w-0 items-center gap-1 px-1.5 py-0.5 text-left text-xs outline-none focus-visible:ring-2 focus-visible:ring-ring',
		occurrence.source === 'moodle'
			? 'border border-primary/50 bg-background text-foreground hover:bg-muted'
			: 'bg-primary text-primary-foreground hover:bg-primary/85'
	]}
	aria-label={`${occurrence.source === 'moodle' ? 'Moodle event' : 'Event'}: ${occurrence.title}, ${timeRange(occurrence, date)}`}
	onclick={() => onSelect(occurrence)}
>
	{#if occurrence.source === 'moodle'}<GraduationCap class="size-3 shrink-0" />{/if}
	<span class="truncate">{time}{occurrence.title}</span>
	{#if occurrence.repeating}<Repeat class="size-3 shrink-0 opacity-80" />{/if}
</button>
