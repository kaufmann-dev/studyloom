<script lang="ts">
	import { page } from '$app/state';
	import ProjectShell from '#lib/components/studyloom/ProjectShell.svelte';

	let { children } = $props();
	let projectId = $derived(page.params.id ?? '');
</script>

<!-- The layout outlives a change of project; the shell and its state must not. -->
{#key projectId}
	<ProjectShell {projectId}>{@render children()}</ProjectShell>
{/key}
