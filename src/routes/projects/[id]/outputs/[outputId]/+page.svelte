<script lang="ts">
	import { resolve } from '$app/paths';
	import { page } from '$app/state';
	import { ArrowLeft } from '@lucide/svelte';
	import Button from '#lib/components/ui/button/button.svelte';
	import OutputViewer from '#lib/components/studyloom/OutputViewer.svelte';
	import { getProject } from '#lib/project.svelte.js';

	const project = getProject();
	let outputId = $derived(page.params.outputId ?? '');
</script>

<Button
	variant="ghost"
	size="sm"
	class="mb-4"
	href={resolve('/projects/[id]/study', { id: project.projectId })}
>
	<ArrowLeft />All study tools
</Button>
{#key outputId}<OutputViewer {outputId} materials={project.materials} />{/key}
