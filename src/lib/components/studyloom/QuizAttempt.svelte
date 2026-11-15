<script lang="ts">
	import { onDestroy, untrack } from 'svelte';
	import { defaults, superForm } from 'sveltekit-superforms';
	import { zod4, zod4Client } from 'sveltekit-superforms/adapters';
	import { ArrowLeft, ArrowRight } from '@lucide/svelte';
	import {
		answersSchema,
		quizQuestions,
		type FieldValue,
		type Material,
		type QuestionAnswer,
		type QuizAttempt,
		type StudyOutput
	} from '#lib/domain.js';
	import Button from '#lib/components/ui/button/button.svelte';
	import { waitForJob } from '#lib/polling.js';
	import { api, dateLabel, errorText, plural } from '#lib/ui.js';
	import ConfirmDialog from './ConfirmDialog.svelte';
	import QuestionCard from './QuestionCard.svelte';

	let {
		output,
		attempts,
		materials,
		onRefresh
	}: {
		output: StudyOutput;
		attempts: QuizAttempt[];
		materials: Material[];
		onRefresh: () => void | Promise<void>;
	} = $props();
	const quiz = untrack(() => output.quiz);
	const questions = quiz ? quizQuestions(quiz) : [];
	const DRAFT = untrack(() => `studyloom:quiz-draft:${output.id}`);

	const blank = (): QuestionAnswer[] =>
		questions.map((question) => ({ questionId: question.id, values: {} }));
	/** Answers typed earlier in this browser and not submitted yet. */
	function draft(): QuestionAnswer[] {
		try {
			const saved = answersSchema.safeParse(JSON.parse(localStorage.getItem(DRAFT) ?? 'null'));
			if (!saved.success) return blank();
			return blank().map(
				(answer) =>
					saved.data.answers.find((item) => item.questionId === answer.questionId) ?? answer
			);
		} catch {
			return blank();
		}
	}
	const editor = superForm(defaults({ answers: draft() }, zod4(answersSchema)), {
		validators: zod4Client(answersSchema),
		SPA: true,
		dataType: 'json',
		id: untrack(() => `quiz-attempt-${output.id}`)
	});
	const { form } = editor;
	let busy = $state(false);
	let error = $state('');
	let currentId = $state('');
	let partIndex = $state(0);
	let confirming = $state(false);
	let current = $derived(attempts.find((attempt) => attempt.id === currentId) ?? null);
	let locked = $derived(busy || current?.status === 'complete' || current?.status === 'grading');
	const lifetime = new AbortController();

	const filled = (value: FieldValue | undefined) =>
		value === true ||
		(typeof value === 'string' && value.trim() !== '') ||
		(Array.isArray(value) && value.length > 0);
	const isAnswered = (answer: QuestionAnswer | undefined) =>
		Boolean(answer && Object.values(answer.values).some(filled));
	let answered = $derived($form.answers.filter(isAnswered).length);
	const indexOf = (questionId: string) =>
		questions.findIndex((question) => question.id === questionId);
	const answeredIn = (ids: string[]) =>
		ids.filter((id) => isAnswered($form.answers[indexOf(id)])).length;

	function saveDraft() {
		try {
			localStorage.setItem(DRAFT, JSON.stringify({ answers: $form.answers }));
		} catch {
			// Without storage the answers simply live until the page is left.
		}
	}
	function clearDraft() {
		try {
			localStorage.removeItem(DRAFT);
		} catch {
			// Nothing was stored.
		}
	}
	async function send() {
		if (busy || !(await editor.validateForm({ update: true })).valid) return;
		busy = true;
		error = '';
		try {
			const result = await api<{ attemptId: string; jobId?: string }>(
				`/api/outputs/${output.id}/attempts`,
				{ body: $form }
			);
			clearDraft();
			currentId = result.attemptId;
			await onRefresh();
			// Written answers are graded by a job; everything else is graded at once.
			if (!result.jobId) return;
			const job = await waitForJob(result.jobId, lifetime.signal);
			if (!job) return;
			await onRefresh();
			if (job.status !== 'succeeded')
				error = job.error ?? 'Grading did not complete. You can submit another attempt.';
		} catch (cause) {
			error = errorText(cause);
		} finally {
			busy = false;
		}
	}
	function submit(event: SubmitEvent) {
		event.preventDefault();
		if (answered < questions.length) confirming = true;
		else void send();
	}
	function showAttempt(attempt: QuizAttempt) {
		currentId = attempt.id;
		$form.answers = blank().map(
			(answer) => attempt.answers.find((given) => given.questionId === answer.questionId) ?? answer
		);
	}
	function reset() {
		currentId = '';
		error = '';
		partIndex = 0;
		$form.answers = blank();
	}
	onDestroy(() => lifetime.abort());
</script>

{#if quiz}
	{@const part = quiz.parts[partIndex]}
	{#if attempts.length}
		<details class="mb-6">
			<summary class="cursor-pointer text-sm text-muted-foreground underline underline-offset-4">
				Previous attempts ({attempts.length})
			</summary>
			<div class="mt-3 flex flex-wrap gap-2">
				{#each attempts as attempt (attempt.id)}
					<Button variant="outline" size="sm" disabled={busy} onclick={() => showAttempt(attempt)}>
						{dateLabel(attempt.createdAt)} · {attempt.status === 'complete'
							? `${attempt.score}/${attempt.maxScore}`
							: attempt.status}
					</Button>
				{/each}
			</div>
		</details>
	{/if}
	{#if current?.status === 'complete'}
		<div
			class="mb-6 flex flex-wrap items-center justify-between gap-3 border-l-2 border-primary bg-muted p-4"
		>
			<div>
				<p class="text-lg font-semibold">Score: {current.score} / {current.maxScore}</p>
				<p class="mt-1 text-sm text-muted-foreground">
					Review the feedback and return to the cited sources.
				</p>
			</div>
			<Button variant="outline" onclick={reset}>Try again</Button>
		</div>
	{/if}
	<form onsubmit={submit} class="space-y-8" novalidate>
		{#if quiz.parts.length > 1}
			<nav aria-label="Quiz parts" class="flex flex-wrap gap-1">
				{#each quiz.parts as item, index (item.id)}
					{@const ids = item.questions.map((question) => question.id)}
					<Button
						variant={index === partIndex ? 'secondary' : 'ghost'}
						size="sm"
						class="h-auto max-w-full flex-col items-start gap-0 py-1.5 text-left"
						aria-current={index === partIndex ? 'step' : undefined}
						onclick={() => (partIndex = index)}
					>
						<span class="max-w-56 truncate">{index + 1}. {item.title}</span>
						<span class="text-xs font-normal text-muted-foreground">
							{answeredIn(ids)} of {ids.length} answered
						</span>
					</Button>
				{/each}
			</nav>
			<h2 class="text-lg font-medium">{partIndex + 1}. {part.title}</h2>
		{/if}
		{#key part.id}
			{#each part.questions as question (question.id)}
				{@const index = indexOf(question.id)}
				<div class="border-b pb-7">
					<QuestionCard
						{question}
						bind:values={$form.answers[index].values}
						grade={current?.grades.find((item) => item.questionId === question.id)}
						{locked}
						heading={`Question ${index + 1} of ${questions.length}`}
						outputId={output.id}
						projectId={output.projectId}
						{materials}
						onChange={saveDraft}
					/>
				</div>
			{/each}
		{/key}
		{#if quiz.parts.length > 1}
			<div class="flex flex-wrap justify-between gap-2">
				<Button variant="outline" disabled={partIndex === 0} onclick={() => partIndex--}>
					<ArrowLeft />Previous part
				</Button>
				<Button
					variant="outline"
					disabled={partIndex === quiz.parts.length - 1}
					onclick={() => partIndex++}
				>
					Next part<ArrowRight />
				</Button>
			</div>
		{/if}
		{#if error}<p role="alert" class="text-sm text-destructive">{error}</p>{/if}
		{#if current?.status !== 'complete'}
			<div class="flex flex-wrap items-center gap-3">
				<Button type="submit" disabled={locked}>
					{locked ? 'Grading your answers…' : 'Submit answers'}
				</Button>
				<p class="text-sm text-muted-foreground">
					{answered} of {plural(questions.length, 'question')} answered
				</p>
			</div>
		{/if}
	</form>
	<ConfirmDialog
		bind:open={confirming}
		title={`Submit with ${plural(questions.length - answered, 'unanswered question')}?`}
		description="Questions without an answer score no points."
		confirmLabel="Submit"
		onConfirm={() => void send()}
	/>
{/if}
