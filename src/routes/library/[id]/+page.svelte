<script lang="ts">
	import { page } from '$app/state';
	import LibraryBrowser from '#lib/components/studyloom/library/LibraryBrowser.svelte';
	let entryId = $derived(page.params.id ?? '');
</script>

{#key entryId}<LibraryBrowser {entryId} />{/key}
