<script lang="ts">
	import { GraduationCap, Headphones, ListChecks, NotebookText, Sparkles } from '@lucide/svelte';
	import type { StudyOutput } from '#lib/domain.js';
	import Button from '#lib/components/ui/button/button.svelte';
	import * as Dialog from '#lib/components/ui/dialog/index.js';
	import GenerateForm from '#lib/components/studyloom/GenerateForm.svelte';
	import OutputList from '#lib/components/studyloom/OutputList.svelte';
	import SourcePicker from '#lib/components/studyloom/SourcePicker.svelte';
	import { getProject } from '#lib/project.svelte.js';
	import { STUDY_TOOLS } from '#lib/study-tools.js';

	const project = getProject();
	const TOOLS = [
		{ kind: 'summary', icon: NotebookText },
		{ kind: 'quiz', icon: ListChecks },
		{ kind: 'audio', icon: Headphones },
		{ kind: 'session', icon: GraduationCap }
	] as const;
	/** The kind of study tool being created in the dialog. */
	let creating = $state<StudyOutput['kind'] | null>(null);
	let outputs = $derived(project.data?.outputs ?? []);
</script>

<div class="grid items-start gap-6 xl:grid-cols-2">
	{#each TOOLS as tool (tool.kind)}
		{@const copy = STUDY_TOOLS[tool.kind]}
		<section class="min-w-0 space-y-4 border p-5" aria-labelledby="study-{tool.kind}">
			<div class="flex items-start justify-between gap-4">
				<div class="min-w-0">
					<h2 id="study-{tool.kind}" class="flex items-center gap-2 text-lg font-medium">
						<tool.icon class="size-4 shrink-0" aria-hidden="true" />{copy.heading}
					</h2>
					<p class="mt-1 text-sm leading-relaxed text-muted-foreground">{copy.intro}</p>
				</div>
				<Button
					class="shrink-0"
					aria-label={`Create ${copy.one}`}
					onclick={() => (creating = tool.kind)}
				>
					<Sparkles />Create
				</Button>
			</div>
			<OutputList
				outputs={outputs.filter((output) => output.kind === tool.kind)}
				empty={`Your ${copy.many} will appear here.`}
			/>
		</section>
	{/each}
</div>

<Dialog.Root
	bind:open={
		() => creating !== null,
		(open) => {
			if (!open) creating = null;
		}
	}
>
	<Dialog.Content class="max-h-[90vh] overflow-y-auto sm:max-w-xl">
		{#if creating}
			<Dialog.Header>
				<Dialog.Title>{STUDY_TOOLS[creating].title}</Dialog.Title>
				<Dialog.Description>{STUDY_TOOLS[creating].intro}</Dialog.Description>
			</Dialog.Header>
			<div><SourcePicker /></div>
			{#key creating}
				<GenerateForm
					projectId={project.projectId}
					kind={creating}
					materialIds={project.selected}
					models={project.models}
					onCreated={() => {
						creating = null;
						return project.refresh();
					}}
				/>
			{/key}
		{/if}
	</Dialog.Content>
</Dialog.Root>
