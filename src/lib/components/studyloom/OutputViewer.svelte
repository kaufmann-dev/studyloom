<script lang="ts">
	import { onMount } from 'svelte';
	import { Copy, Download } from '@lucide/svelte';
	import type { StudyOutput, QuizAttempt, Material } from '$lib/domain';
	import Button from '$lib/components/ui/button/button.svelte';
	import Citations from './Citations.svelte';
	import Attempt from './QuizAttempt.svelte';
	import { api, errorText, downloadText, dateLabel } from '$lib/ui';
	let { outputId, materials }: { outputId: string; materials: Material[] } = $props();
	let data = $state.raw<{ output: StudyOutput; attempts: QuizAttempt[] } | null>(null);
	let error = $state('');
	let notice = $state('');
	let mounted = false;
	let timer: ReturnType<typeof setTimeout> | undefined;
	let exported = $derived(
		data?.output.quiz
			? `# ${data.output.title}\n\n${data.output.quiz.questions.map((q, index) => `## ${index + 1}. ${q.question}\n\n${q.options.map((option) => `- ${option}`).join('\n')}\n\nAnswer: ${q.correctAnswer}\n\n${q.explanation}`).join('\n\n')}`
			: (data?.output.content ?? '')
	);
	async function refresh(interaction = false) {
		try {
			const result = await api<{ output: StudyOutput; attempts: QuizAttempt[] }>(
				`/api/outputs/${outputId}`,
				undefined,
				'GET',
				interaction
			);
			if (!mounted) return;
			data = result;
			clearTimeout(timer);
			if (result.attempts.some((attempt) => attempt.status === 'grading'))
				timer = setTimeout(refresh, 3000);
		} catch (e) {
			error = errorText(e);
		}
	}
	async function copy() {
		try {
			await navigator.clipboard.writeText(exported);
			notice = 'Copied.';
		} catch (e) {
			error = errorText(e);
		}
	}
	onMount(() => {
		mounted = true;
		void refresh(true);
		return () => {
			mounted = false;
			clearTimeout(timer);
		};
	});
</script>

{#if error}<p role="alert" class="text-sm text-destructive">{error}</p>
	<Button variant="outline" onclick={() => refresh(true)}>Retry</Button>
{:else if !data}<p role="status" class="text-sm text-muted-foreground">Loading study tool…</p>
{:else}<article class="space-y-6">
		<div>
			<h2 class="text-xl leading-snug font-semibold">{data.output.title}</h2>
			<p class="mt-2 text-xs break-words text-muted-foreground">
				{dateLabel(data.output.createdAt)} · {data.output.modelId} · {data.output.materialIds
					.length} sources
			</p>
		</div>
		<div class="flex flex-wrap gap-2">
			<Button variant="outline" size="sm" onclick={copy}
				><Copy />{data.output.kind === 'quiz' ? 'Copy with answers' : 'Copy'}</Button
			><Button
				variant="outline"
				size="sm"
				onclick={() => downloadText(`${data?.output.title ?? 'study-tool'}.md`, exported)}
				><Download />{data.output.kind === 'quiz'
					? 'Download with answers'
					: 'Download Markdown'}</Button
			>{#if notice}<span role="status" class="self-center text-xs text-muted-foreground"
					>{notice}</span
				>{/if}
		</div>
		{#if data.output.kind === 'quiz'}<Attempt
				output={data.output}
				attempts={data.attempts}
				{materials}
				onRefresh={refresh}
			/>{:else}<div class="text-sm leading-7 break-words whitespace-pre-wrap">
				{data.output.content}
			</div>
			<Citations
				projectId={data.output.projectId}
				citations={data.output.citations}
				{materials}
			/>{/if}
	</article>{/if}
