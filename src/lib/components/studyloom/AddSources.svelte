<script lang="ts">
	import { Label } from '#lib/components/ui/label/index.js';
	import { Switch } from '#lib/components/ui/switch/index.js';
	import Recorder from '#lib/components/Recorder.svelte';
	import { getProject } from '#lib/project.svelte.js';
	import ModelSelect from './ModelSelect.svelte';
	import PasteText from './PasteText.svelte';
	import Upload from './Upload.svelte';
	import WebSource from './WebSource.svelte';

	/** Every way to add a source to the open project. */
	const project = getProject();
	const uid = $props.id();
	const REMEMBERED = 'studyloom:process-immediately';
	// Remembered in this browser only; a private window simply starts with the default.
	function remembered() {
		try {
			return localStorage.getItem(REMEMBERED) !== 'no';
		} catch {
			return true;
		}
	}
	let processNow = $state(remembered());
	function setProcessNow(next: boolean) {
		processNow = next;
		try {
			localStorage.setItem(REMEMBERED, next ? 'yes' : 'no');
		} catch {
			// Not remembered, which changes nothing for this visit.
		}
	}
</script>

<section class="space-y-4 border p-4" aria-labelledby="{uid}-add">
	<h2 id="{uid}-add" class="text-sm font-semibold">Add sources</h2>
	<div class="space-y-2">
		<Label for="{uid}-model">Processing model</Label>
		<ModelSelect id="{uid}-model" models={project.models} bind:value={project.preferredModel} />
	</div>
	<div class="space-y-1.5">
		<div class="flex items-center justify-between gap-3">
			<Label for="{uid}-process">Process immediately</Label>
			<Switch id="{uid}-process" bind:checked={() => processNow, setProcessNow} />
		</div>
		<p class="text-xs leading-relaxed text-muted-foreground">
			{processNow
				? 'Uploads and web pages are read by Claude as soon as they arrive.'
				: 'Uploads and web pages are only stored. Process them later from the list.'}
		</p>
	</div>
	<Upload
		projectId={project.projectId}
		modelId={project.processingModel}
		process={processNow}
		onSaved={project.refresh}
	/>
	<div class="border-t pt-4">
		<WebSource
			projectId={project.projectId}
			modelId={project.processingModel}
			process={processNow}
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
