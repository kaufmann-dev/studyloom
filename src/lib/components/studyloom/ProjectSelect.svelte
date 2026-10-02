<script lang="ts">
	import { onMount } from 'svelte';
	import type { HTMLSelectAttributes } from 'svelte/elements';
	import * as NativeSelect from '#lib/components/ui/native-select/index.js';
	import type { Project } from '#lib/domain.js';
	import { api } from '#lib/ui.js';

	let {
		value = $bindable(),
		currentName = null,
		...rest
	}: Omit<HTMLSelectAttributes, 'size' | 'value'> & {
		value: string | null;
		/** Name of the selected project, shown until the project list has loaded. */
		currentName?: string | null;
	} = $props();
	let projects = $state.raw<Project[]>([]);

	onMount(async () => {
		// Without the list the current choice simply stays as it is.
		projects = await api<{ projects: Project[] }>('/api/projects')
			.then((result) => result.projects)
			.catch(() => []);
	});
</script>

<NativeSelect.Root
	{...rest}
	class="w-full"
	bind:value={() => value ?? '', (next) => (value = next || null)}
>
	<NativeSelect.Option value="">No project</NativeSelect.Option>
	{#if value && !projects.some((project) => project.id === value)}
		<NativeSelect.Option {value}>{currentName ?? 'Current project'}</NativeSelect.Option>
	{/if}
	{#each projects as project (project.id)}
		<NativeSelect.Option value={project.id}>{project.name}</NativeSelect.Option>
	{/each}
</NativeSelect.Root>
