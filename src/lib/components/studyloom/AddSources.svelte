<script lang="ts">
	import { Label } from '#lib/components/ui/label/index.js';
	import Recorder from '#lib/components/Recorder.svelte';
	import { getProject } from '#lib/project.svelte.js';
	import ModelSelect from './ModelSelect.svelte';
	import PasteText from './PasteText.svelte';
	import Upload from './Upload.svelte';
	import WebSource from './WebSource.svelte';

	/** Every way to add a source to the open project. */
	const project = getProject();
	const uid = $props.id();
</script>

<section class="space-y-4 border p-4" aria-labelledby="{uid}-add">
	<h2 id="{uid}-add" class="text-sm font-semibold">Add sources</h2>
	<div class="space-y-2">
		<Label for="{uid}-model">Processing model</Label>
		<ModelSelect id="{uid}-model" models={project.models} bind:value={project.preferredModel} />
	</div>
	<Upload
		projectId={project.projectId}
		modelId={project.processingModel}
		onSaved={project.refresh}
	/>
	<div class="border-t pt-4">
		<WebSource
			projectId={project.projectId}
			modelId={project.processingModel}
			onSaved={project.refresh}
		/>
	</div>
	<div class="border-t pt-4">
		<PasteText projectId={project.projectId} onSaved={project.refresh} />
	</div>
	<div class="border-t pt-4">
		<Recorder onSaved={() => void project.refresh()} />
	</div>
</section>
