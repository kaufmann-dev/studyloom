<script lang="ts">
	import { Repeat } from '@lucide/svelte';
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
	class="relative flex w-full min-w-0 items-center gap-1 bg-primary px-1.5 py-0.5 text-left text-xs text-primary-foreground outline-none hover:bg-primary/85 focus-visible:ring-2 focus-visible:ring-ring"
	aria-label={`Event: ${occurrence.title}, ${timeRange(occurrence, date)}`}
	onclick={() => onSelect(occurrence)}
>
	<span class="truncate">{time}{occurrence.title}</span>
	{#if occurrence.repeating}<Repeat class="size-3 shrink-0 opacity-80" />{/if}
</button>
