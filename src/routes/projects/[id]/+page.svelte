<script lang="ts">
	import { page } from '$app/state';
	import Workspace from '$lib/components/studyloom/Workspace.svelte';
	let projectId = $derived(page.params.id ?? '');
</script>

{#key projectId}<Workspace {projectId} />{/key}
