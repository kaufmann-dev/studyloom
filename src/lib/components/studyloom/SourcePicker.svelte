<script lang="ts">
	import { ChevronDown, Files } from '@lucide/svelte';
	import Button from '#lib/components/ui/button/button.svelte';
	import { Checkbox } from '#lib/components/ui/checkbox/index.js';
	import * as Popover from '#lib/components/ui/popover/index.js';
	import { getProject } from '#lib/project.svelte.js';

	/** Chooses which readable sources chat and study tools work with. */
	const project = getProject();
	const uid = $props.id();
	let readable = $derived(project.readable);

	function toggle(id: string, checked: boolean) {
		project.selected = checked
			? [...new Set([...project.selected, id])]
			: project.selected.filter((value) => value !== id);
	}
</script>

<Popover.Root>
	<Popover.Trigger>
		{#snippet child({ props })}
			<Button {...props} variant="outline" size="sm" class="max-w-full">
				<Files />
				<span class="truncate">
					{project.selected.length} of {readable.length}
					{readable.length === 1 ? 'source' : 'sources'} selected
				</span>
				<ChevronDown />
			</Button>
		{/snippet}
	</Popover.Trigger>
	<Popover.Content align="start" class="w-80 max-w-[calc(100vw-2rem)] p-0">
		{#if readable.length}
			<div class="flex items-center gap-3 border-b px-3 py-2 text-xs">
				<button
					type="button"
					class="min-h-6 underline underline-offset-4"
					onclick={() => (project.selected = readable.map((material) => material.id))}
					>Select all</button
				>
				<button
					type="button"
					class="min-h-6 underline underline-offset-4"
					onclick={() => (project.selected = [])}>Clear</button
				>
			</div>
			<ul class="max-h-72 overflow-y-auto py-1">
				{#each readable as material (material.id)}
					<li>
						<label
							for="{uid}-{material.id}"
							class="flex min-h-9 cursor-pointer items-center gap-2 px-3 py-1.5 text-sm hover:bg-muted/50"
						>
							<Checkbox
								id="{uid}-{material.id}"
								checked={project.selected.includes(material.id)}
								onCheckedChange={(checked) => toggle(material.id, checked)}
							/>
							<span class="truncate" title={material.name}>{material.name}</span>
						</label>
					</li>
				{/each}
			</ul>
		{:else}
			<p class="p-3 text-sm text-muted-foreground">
				No source is ready yet. Add one under Sources and wait until it is processed.
			</p>
		{/if}
	</Popover.Content>
</Popover.Root>
