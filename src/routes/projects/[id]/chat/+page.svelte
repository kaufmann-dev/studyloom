<script lang="ts">
	import Chat from '#lib/components/studyloom/Chat.svelte';
	import SourcePicker from '#lib/components/studyloom/SourcePicker.svelte';
	import { getProject } from '#lib/project.svelte.js';

	const project = getProject();
</script>

{#if project.data}
	<div class="max-w-5xl space-y-5">
		<SourcePicker />
		<Chat
			projectId={project.projectId}
			materialIds={project.selected}
			materials={project.materials}
			models={project.models}
			conversations={project.data.conversations}
			jobs={project.data.jobs}
			onChanged={project.refresh}
		/>
	</div>
{/if}
