<script lang="ts">
	import { GraduationCap, MapPin, Repeat } from '@lucide/svelte';
	import type { Occurrence } from '#lib/domain.js';
	import { Badge } from '#lib/components/ui/badge/index.js';
	import { relativeDay, timeRange } from '#lib/calendar.js';

	let {
		occurrences,
		now,
		date,
		showDay = false,
		showProject = true,
		onSelect,
		class: className = ''
	}: {
		occurrences: Occurrence[];
		now: Date;
		/** The day the list belongs to, for events that span several days. */
		date?: string;
		/** Prefixes each row with its day, for lists that mix several days. */
		showDay?: boolean;
		showProject?: boolean;
		onSelect: (occurrence: Occurrence) => void;
		class?: string;
	} = $props();
</script>

<ul class={['divide-y border', className]}>
	{#each occurrences as occurrence (occurrence.key)}
		<li>
			<button
				type="button"
				class={[
					'flex w-full items-start gap-3 border-l-4 p-3 text-left outline-none hover:bg-muted/40 focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset',
					occurrence.source === 'moodle' ? 'border-l-primary/40' : 'border-l-primary'
				]}
				onclick={() => onSelect(occurrence)}
			>
				<span class="min-w-0 flex-1">
					<span class="flex items-center gap-1.5 font-medium break-words">
						{occurrence.title}
						{#if occurrence.repeating}
							<Repeat class="size-3.5 shrink-0 text-muted-foreground" aria-label="Repeats" />
						{/if}
						{#if occurrence.source === 'moodle'}
							<Badge variant="outline" class="gap-1 font-normal"><GraduationCap />Moodle</Badge>
						{/if}
					</span>
					<span
						class="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground"
					>
						<span>
							{showDay ? `${relativeDay(occurrence.startDate, now)} · ` : ''}{timeRange(
								occurrence,
								date
							)}
						</span>
						{#if occurrence.location}
							<span class="flex min-w-0 items-center gap-1">
								<MapPin class="size-3 shrink-0" /><span class="truncate">{occurrence.location}</span
								>
							</span>
						{/if}
						{#if showProject && occurrence.projectName}<span class="truncate"
								>{occurrence.projectName}</span
							>{/if}
					</span>
				</span>
			</button>
		</li>
	{/each}
</ul>
