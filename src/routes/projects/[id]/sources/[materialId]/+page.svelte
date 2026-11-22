<script lang="ts">
	import { resolve } from '$app/paths';
	import { page } from '$app/state';
	import { ArrowLeft } from '@lucide/svelte';
	import Button from '#lib/components/ui/button/button.svelte';
	import { getProject } from '#lib/project.svelte.js';
	import SourceViewer from '#lib/components/studyloom/SourceViewer.svelte';

	const project = getProject();
	let materialId = $derived(page.params.materialId ?? '');
	// A completed extraction replaces all chunks and figures in the open viewer.
	let completed = $derived(
		project.data?.jobs.find(
			(job) => job.kind === 'ingest' && job.materialId === materialId && job.status === 'succeeded'
		)
	);
	let lastOpened = '';
	function isNavigation() {
		const navigated = lastOpened !== materialId;
		lastOpened = materialId;
		return navigated;
	}
	let locator = $derived(page.url.searchParams.get('locator') ?? '');
</script>

<Button
	variant="ghost"
	size="sm"
	class="mb-4"
	href={resolve('/projects/[id]', { id: page.params.id ?? '' })}
>
	<ArrowLeft />All sources
</Button>
{#key completed?.id ?? materialId}<SourceViewer {materialId} {locator} {isNavigation} />{/key}
