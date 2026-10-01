<script lang="ts">
	import { onMount } from 'svelte';
	import { Copy, Download } from '@lucide/svelte';
	import type { Material, QuizAttempt, StudyOutput } from '#lib/domain.js';
	import Button from '#lib/components/ui/button/button.svelte';
	import { createPoller } from '#lib/polling.js';
	import { api, copyText, dateLabel, downloadText, errorText, plural } from '#lib/ui.js';
	import Citations from './Citations.svelte';
	import ErrorAlert from './ErrorAlert.svelte';
	import Markdown from './Markdown.svelte';
	import Attempt from './QuizAttempt.svelte';

	let { outputId, materials }: { outputId: string; materials: Material[] } = $props();
	type OutputData = { output: StudyOutput; attempts: QuizAttempt[] };
	let data = $state.raw<OutputData | null>(null);
	let error = $state('');
	let exported = $derived.by(() => {
		if (!data) return '';
		const { title, quiz, content } = data.output;
		if (!quiz) return content;
		const questions = quiz.questions.map(
			(q, index) =>
				`## ${index + 1}. ${q.question}\n\n${q.options.map((option) => `- ${option}`).join('\n')}\n\nAnswer: ${q.correctAnswer}\n\n${q.explanation}`
		);
		return `# ${title}\n\n${questions.join('\n\n')}`;
	});

	const poller = createPoller(async (interaction) => {
		error = '';
		try {
			data = await api<OutputData>(`/api/outputs/${outputId}`, { interaction });
			return data.attempts.some((attempt) => attempt.status === 'grading');
		} catch (cause) {
			error = errorText(cause);
			return false;
		}
	});
	onMount(() => {
		void poller.run(true);
		return poller.stop;
	});
</script>

<ErrorAlert message={error} onRetry={() => poller.run(true)} />
{#if !data}
	{#if !error}<p role="status" class="text-sm text-muted-foreground">Loading study tool…</p>{/if}
{:else}
	{@const { output } = data}
	{@const quiz = output.kind === 'quiz'}
	<article class="space-y-6">
		<div>
			<h2 class="text-xl leading-snug font-semibold">{output.title}</h2>
			<p class="mt-2 text-xs break-words text-muted-foreground">
				{dateLabel(output.createdAt)} · {output.modelId} · {plural(
					output.materialIds.length,
					'source'
				)}
			</p>
		</div>
		<div class="flex flex-wrap gap-2">
			<Button variant="outline" size="sm" onclick={() => copyText(exported)}>
				<Copy />{quiz ? 'Copy with answers' : 'Copy'}
			</Button>
			<Button
				variant="outline"
				size="sm"
				onclick={() => downloadText(`${output.title}.md`, exported)}
			>
				<Download />{quiz ? 'Download with answers' : 'Download Markdown'}
			</Button>
		</div>
		{#if quiz}
			<Attempt {output} attempts={data.attempts} {materials} onRefresh={() => poller.run()} />
		{:else}
			<Markdown text={output.content} class="leading-7" />
			<Citations projectId={output.projectId} citations={output.citations} {materials} />
		{/if}
	</article>
{/if}
