<script lang="ts">
	import { resolve } from '$app/paths';
	import type { Pathname } from '$app/types';
	import { BookOpen } from '@lucide/svelte';
	import type { Citation, Material } from '$lib/domain';
	let {
		projectId,
		citations,
		materials = []
	}: { projectId: string; citations: Citation[]; materials?: Material[] } = $props();
	let unique = $derived([
		...new Map(
			citations.map((citation) => [`${citation.materialId}:${citation.locator}`, citation])
		).values()
	]);
</script>

{#if citations.length}<div class="mt-4 flex flex-wrap gap-2" aria-label="Sources">
		{#each unique as citation (`${citation.materialId}:${citation.locator}`)}<a
				class="inline-flex max-w-full items-center gap-1.5 border bg-background px-2 py-1 text-xs text-primary hover:underline"
				href={resolve(
					`/projects/${projectId}?material=${encodeURIComponent(citation.materialId)}&locator=${encodeURIComponent(citation.locator)}` as Pathname
				)}
				title={citation.quote ?? citation.locator}
				><BookOpen class="size-3 shrink-0" /><span class="truncate"
					>{materials.find((material) => material.id === citation.materialId)?.name ?? 'Source'} · {citation.locator}</span
				></a
			>{/each}
	</div>{/if}
