<script lang="ts">
	import { onDestroy } from 'svelte';
	import { GraduationCap } from '@lucide/svelte';
	import type { Material, StudyOutput, StudyRun } from '#lib/domain.js';
	import Button from '#lib/components/ui/button/button.svelte';
	import { TutorSession } from '#lib/study/tutor.svelte.js';
	import { api } from '#lib/ui.js';
	import Citations from './Citations.svelte';
	import Markdown from './Markdown.svelte';
	import StudyPlayer from './StudyPlayer.svelte';
	import StudyRunView from './StudyRun.svelte';

	let {
		output,
		runs,
		materials,
		onRefresh
	}: {
		output: StudyOutput;
		runs: StudyRun[];
		materials: Material[];
		onRefresh: () => void;
	} = $props();
	let tutor = $state.raw<TutorSession | null>(null);
	let open = $derived(runs.find((run) => run.status === 'active'));
	let plan = $derived(output.study!.plan);

	function start() {
		tutor?.dispose();
		const session = new TutorSession(onRefresh);
		tutor = session;
		void session.start(output.id, async () => {
			const { runId } = await api<{ runId: string }>(`/api/outputs/${output.id}/runs`, {
				body: {}
			});
			return runId;
		});
	}
	onDestroy(() => tutor?.dispose());
</script>

{#if tutor}
	<StudyPlayer {tutor} onResume={start} />
{:else}
	<div class="space-y-2">
		<Button size="lg" onclick={start}>
			<GraduationCap />{open ? 'Resume session' : 'Start session'}
		</Button>
		<p class="text-xs text-muted-foreground">
			Uses your microphone while you answer. Your answers are transcribed; the audio is not kept.
		</p>
	</div>
{/if}
{#if runs.length}
	<section class="space-y-3">
		<h3 class="text-sm font-semibold">Your runs</h3>
		{#each runs as run (run.id)}
			<StudyRunView {run} {plan} projectId={output.projectId} {materials} />
		{/each}
	</section>
{/if}
<details class="border p-4">
	<summary class="cursor-pointer text-sm font-medium">Session plan</summary>
	<Markdown text={output.content} class="mt-4 leading-7" />
	<Citations projectId={output.projectId} citations={output.citations} {materials} />
</details>
