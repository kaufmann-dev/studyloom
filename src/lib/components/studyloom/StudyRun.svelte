<script lang="ts">
	import type { Material, StudyPlan, StudyRun } from '#lib/domain.js';
	import Badge from '#lib/components/ui/badge/badge.svelte';
	import { dateLabel } from '#lib/ui.js';
	import Citations from './Citations.svelte';

	let {
		run,
		plan,
		projectId,
		materials
	}: { run: StudyRun; plan: StudyPlan; projectId: string; materials: Material[] } = $props();
	const VERDICTS = {
		correct: 'Correct',
		partial: 'Partly right',
		incorrect: 'Not quite',
		none: 'No answer'
	};
	let review = $derived(run.answers.filter((answer) => answer.gap));
	let parts = $derived(
		plan.segments
			.map((segment, index) => ({
				segment,
				index,
				answers: run.answers.filter((answer) => answer.segmentIndex === index)
			}))
			.filter((part) => part.answers.length)
	);
</script>

<details class="border p-4">
	<summary class="cursor-pointer text-sm font-medium">
		{dateLabel(run.createdAt)} · {run.status === 'complete' ? 'Finished' : 'In progress'} · {run.answers.filter(
			(answer) => answer.verdict === 'correct'
		).length} of {parts.length} parts correct
	</summary>
	<div class="mt-4 space-y-5">
		{#if review.length}
			<div>
				<h4 class="text-sm font-semibold">Review these</h4>
				<ul class="mt-2 list-disc space-y-1 pl-5 text-sm">
					{#each review as answer (answer.id)}
						<li>{plan.segments[answer.segmentIndex]?.title}: {answer.gap}</li>
					{/each}
				</ul>
			</div>
		{/if}
		{#each parts as part (part.index)}
			{@const last = part.answers[part.answers.length - 1]}
			<div class="space-y-2 border-t pt-4">
				<p class="text-sm font-medium">{part.index + 1}. {part.segment.question}</p>
				{#each part.answers as answer (answer.id)}
					<div class="space-y-1 text-sm">
						<p>
							<Badge variant={answer.verdict === 'correct' ? 'secondary' : 'outline'}
								>{VERDICTS[answer.verdict]}</Badge
							>
							<span class="ml-1 text-muted-foreground"
								>{answer.answer ? `“${answer.answer}”` : 'No answer given'}</span
							>
						</p>
						<p class="leading-6">{answer.feedback}</p>
					</div>
				{/each}
				{#if last.verdict !== 'correct'}
					<div class="bg-muted/50 p-3 text-sm">
						<p><span class="font-medium">Model answer:</span> {part.segment.modelAnswer}</p>
						<ul class="mt-2 list-disc space-y-1 pl-5">
							{#each [...new Set(part.segment.keyPoints)] as point (point)}<li>{point}</li>{/each}
						</ul>
						<Citations {projectId} citations={part.segment.citations} {materials} />
					</div>
				{/if}
			</div>
		{/each}
	</div>
</details>
