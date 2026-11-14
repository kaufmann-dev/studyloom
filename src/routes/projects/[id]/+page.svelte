<script lang="ts">
	import AddSources from '#lib/components/studyloom/AddSources.svelte';
	import SourcesTable from '#lib/components/studyloom/SourcesTable.svelte';
</script>

<div class="grid items-start gap-7 lg:grid-cols-[minmax(0,1fr)_300px]">
	<SourcesTable />
	<aside class="min-w-0" aria-label="Add sources"><AddSources /></aside>
</div>
