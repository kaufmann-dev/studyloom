<script lang="ts">
	import { resolve } from '$app/paths';
	import { page } from '$app/state';
	import { ArrowLeft } from '@lucide/svelte';
	import Button from '#lib/components/ui/button/button.svelte';
	import SourceViewer from '#lib/components/studyloom/SourceViewer.svelte';

	let materialId = $derived(page.params.materialId ?? '');
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
{#key materialId}<SourceViewer {materialId} {locator} />{/key}
