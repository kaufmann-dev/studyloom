<script lang="ts">
	import { onMount } from 'svelte';
	import { Copy, Download } from '@lucide/svelte';
	import type { AudioInfo, Material, QuizAttempt, StudyOutput, StudyRun } from '#lib/domain.js';
	import Button from '#lib/components/ui/button/button.svelte';
	import { createPoller } from '#lib/polling.js';
	import { api, copyText, dateLabel, downloadText, errorText, plural } from '#lib/ui.js';
	import Citations from './Citations.svelte';
	import ErrorAlert from './ErrorAlert.svelte';
	import Markdown from './Markdown.svelte';
	import Attempt from './QuizAttempt.svelte';
	import StudySession from './StudySession.svelte';

	let { outputId, materials }: { outputId: string; materials: Material[] } = $props();
	type OutputData = { output: StudyOutput; attempts: QuizAttempt[]; runs: StudyRun[] };
	let data = $state.raw<OutputData | null>(null);
	let error = $state('');
	const SPEAKERS: Record<string, string> = { tutor: 'Tutor', learner: 'Learner' };
	function voiceLabel(audio: AudioInfo) {
		return audio.voices
			.map((voice) =>
				SPEAKERS[voice.speaker] ? `${SPEAKERS[voice.speaker]}: ${voice.voiceName}` : voice.voiceName
			)
			.join(' · ');
	}
	function duration(ms: number) {
		const seconds = Math.round(ms / 1000);
		return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
	}
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
	{@const audioUrl = `/api/outputs/${output.id}/audio`}
	<article class="space-y-6">
		<div>
			<h2 class="text-xl leading-snug font-semibold">{output.title}</h2>
			<p class="mt-2 text-xs break-words text-muted-foreground">
				{[
					dateLabel(output.createdAt),
					output.modelId,
					plural(output.materialIds.length, 'source'),
					...(output.audio
						? [
								voiceLabel(output.audio),
								output.audio.speechModelName,
								duration(output.audio.durationMs)
							]
						: []),
					...(output.study ? [output.study.voiceName, output.study.speechModelName] : [])
				].join(' · ')}
			</p>
		</div>
		{#if output.audio}
			<audio controls preload="metadata" src={audioUrl} class="w-full"></audio>
		{/if}
		<div class="flex flex-wrap gap-2">
			{#if output.audio}
				<Button variant="outline" size="sm" href={`${audioUrl}?download`}>
					<Download />Download MP3
				</Button>
			{/if}
			<Button variant="outline" size="sm" onclick={() => copyText(exported)}>
				<Copy />{quiz ? 'Copy with answers' : 'Copy'}
			</Button>
			<Button
				variant="outline"
				size="sm"
				onclick={() => downloadText(`${output.title}.md`, exported)}
			>
				<Download />{quiz
					? 'Download with answers'
					: output.audio
						? 'Download transcript'
						: output.study
							? 'Download plan'
							: 'Download Markdown'}
			</Button>
		</div>
		{#if output.kind === 'session'}
			<StudySession {output} runs={data.runs} {materials} onRefresh={() => poller.run()} />
		{:else if quiz}
			<Attempt {output} attempts={data.attempts} {materials} onRefresh={() => poller.run()} />
		{:else}
			<Markdown text={output.content} class="leading-7" />
			<Citations projectId={output.projectId} citations={output.citations} {materials} />
		{/if}
	</article>
{/if}
