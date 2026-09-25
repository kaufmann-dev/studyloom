<script lang="ts">
	import { page } from '$app/state';
	import LibraryBrowser from '$lib/components/studyloom/LibraryBrowser.svelte';
	let folderId = $derived(page.params.id ?? '');
</script>

{#key folderId}<LibraryBrowser {folderId} />{/key}
