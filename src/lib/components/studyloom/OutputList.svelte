<script lang="ts">
	import { resolve } from '$app/paths';
	import type { OutputSummary } from '#lib/domain.js';
	import { dateLabel, plural } from '#lib/ui.js';

	/** Saved outputs of one kind, each linking to its own page. */
	let { outputs, empty }: { outputs: OutputSummary[]; empty: string } = $props();
</script>

{#if outputs.length}
	<ul class="divide-y border">
		{#each outputs as output (output.id)}
			<li>
				<a
					href={resolve('/projects/[id]/outputs/[outputId]', {
						id: output.projectId,
						outputId: output.id
					})}
					class="block min-w-0 p-4 hover:bg-muted/50"
				>
					<span class="block truncate font-medium" title={output.title}>{output.title}</span>
					<span class="mt-1 block text-xs text-muted-foreground">
						{dateLabel(output.createdAt)} · {plural(output.materialIds.length, 'source')}
					</span>
				</a>
			</li>
		{/each}
	</ul>
{:else}
	<p class="border border-dashed p-5 text-sm text-muted-foreground">{empty}</p>
{/if}
