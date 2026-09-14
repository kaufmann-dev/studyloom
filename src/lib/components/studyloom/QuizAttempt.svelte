<script lang="ts">
	import { onMount, untrack } from 'svelte';
	import { defaults, superForm } from 'sveltekit-superforms';
	import { zod4, zod4Client } from 'sveltekit-superforms/adapters';
	import {
		answersSchema,
		type StudyOutput,
		type QuizAttempt,
		type Job,
		type Material
	} from '$lib/domain';
	import * as Form from '$lib/components/ui/form';
	import Textarea from '$lib/components/ui/textarea/textarea.svelte';
	import Button from '$lib/components/ui/button/button.svelte';
	import Citations from './Citations.svelte';
	import { api, errorText, dateLabel } from '$lib/ui';
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
	const editor = superForm(
		defaults(
			untrack(() => ({
				answers:
					output.quiz?.questions.map((question) => ({ questionId: question.id, value: '' })) ?? []
			})),
			zod4(answersSchema)
		),
		{ validators: zod4Client(answersSchema), SPA: true, dataType: 'json' }
	);
	const { form } = editor;
	let busy = $state(false);
	let error = $state('');
	let currentId = $state('');
	let current = $derived(attempts.find((attempt) => attempt.id === currentId) ?? null);
	let timer: ReturnType<typeof setTimeout> | undefined;
	let mounted = false;
	async function refreshAttempt(id: string) {
		currentId = id;
		await onRefresh();
	}
	async function poll(jobId: string, attemptId: string) {
		try {
			const { job } = await api<{ job: Job }>(`/api/jobs/${jobId}`);
			if (!mounted) return;
			if (job.status === 'queued' || job.status === 'running') {
				timer = setTimeout(() => poll(jobId, attemptId), 1500);
				return;
			}
			busy = false;
			await refreshAttempt(attemptId);
			if (job.status !== 'succeeded')
				error = job.error ?? 'Grading did not complete. You can submit another attempt.';
		} catch (e) {
			error = errorText(e);
			busy = false;
		}
	}
	async function submit(event: SubmitEvent) {
		event.preventDefault();
		if (busy || !(await editor.validateForm()).valid) return;
		busy = true;
		error = '';
		try {
			const result = await api<{ attemptId: string; jobId?: string }>(
				`/api/outputs/${output.id}/attempts`,
				$form
			);
			await refreshAttempt(result.attemptId);
			if (result.jobId) void poll(result.jobId, result.attemptId);
			else busy = false;
		} catch (e) {
			error = errorText(e);
			busy = false;
		}
	}
	function showAttempt(attempt: QuizAttempt) {
		currentId = attempt.id;
		$form.answers =
			output.quiz?.questions.map((question) => ({
				questionId: question.id,
				value: attempt.answers.find((answer) => answer.questionId === question.id)?.value ?? ''
			})) ?? [];
	}
	function reset() {
		currentId = '';
		error = '';
		$form.answers =
			output.quiz?.questions.map((question) => ({ questionId: question.id, value: '' })) ?? [];
	}
	onMount(() => {
		mounted = true;
		return () => {
			mounted = false;
			clearTimeout(timer);
		};
	});
</script>

{#if output.quiz}
	{#if attempts.length}<details class="mb-6">
			<summary class="cursor-pointer text-sm text-muted-foreground underline underline-offset-4"
				>Previous attempts ({attempts.length})</summary
			>
			<div class="mt-3 flex flex-wrap gap-2">
				{#each attempts as attempt (attempt.id)}<Button
						variant="outline"
						size="sm"
						disabled={busy}
						onclick={() => showAttempt(attempt)}
						>{dateLabel(attempt.createdAt)} · {attempt.status === 'complete'
							? `${attempt.score}/${attempt.maxScore}`
							: attempt.status}</Button
					>{/each}
			</div>
		</details>{/if}
	{#if current?.status === 'complete'}<div
			class="mb-6 flex flex-wrap items-center justify-between gap-3 border-l-2 border-primary bg-muted p-4"
		>
			<div>
				<p class="text-lg font-semibold">Score: {current.score} / {current.maxScore}</p>
				<p class="mt-1 text-sm text-muted-foreground">
					Review the feedback and return to the cited sources.
				</p>
			</div>
			<Button variant="outline" onclick={reset}>Try again</Button>
		</div>{/if}
	<form onsubmit={submit} class="space-y-8">
		{#each output.quiz.questions as question, index (question.id)}
			{@const grade = current?.grades.find((item) => item.questionId === question.id)}
			<section class="space-y-3 border-b pb-7">
				<Form.Field form={editor} name={`answers[${index}].value`}>
					{#if question.type === 'multiple_choice'}<fieldset
							disabled={busy || current?.status === 'complete' || current?.status === 'grading'}
							class="space-y-3"
						>
							<legend class="mb-3 text-sm leading-relaxed font-medium"
								>{index + 1}. {question.question}</legend
							>{#each question.options as option (option)}<Form.Control
									>{#snippet children({ props })}<label
											class="flex cursor-pointer items-start gap-3 border p-3 text-sm"
											><input
												{...props}
												type="radio"
												value={option}
												bind:group={$form.answers[index].value}
												required
												class="mt-0.5 size-4 shrink-0 accent-primary"
											/><span class="leading-relaxed">{option}</span></label
										>{/snippet}</Form.Control
								>{/each}
						</fieldset>
					{:else}<Form.Control
							>{#snippet children({ props })}<Form.Label class="leading-relaxed"
									>{index + 1}. {question.question}</Form.Label
								><Textarea
									{...props}
									bind:value={$form.answers[index].value}
									required
									rows={4}
									placeholder="Explain your answer in your own words…"
									disabled={busy || current?.status === 'complete' || current?.status === 'grading'}
								/>{/snippet}</Form.Control
						>{/if}<Form.FieldErrors />
				</Form.Field>
				{#if grade}<div class="space-y-2 bg-muted p-4 text-sm">
						<p class="font-semibold">{grade.score} / {grade.maxScore} points</p>
						<p class="leading-relaxed whitespace-pre-wrap">{grade.feedback}</p>
						<p class="whitespace-pre-wrap">
							<span class="font-medium">Expected answer:</span>
							{grade.correctAnswer}
						</p>
						{#if question.explanation}<p class="whitespace-pre-wrap text-muted-foreground">
								{question.explanation}
							</p>{/if}<Citations
							projectId={output.projectId}
							citations={grade.citations}
							{materials}
						/>
					</div>{/if}
			</section>{/each}
		{#if error}<p role="alert" class="text-sm text-destructive">{error}</p>{/if}
		{#if current?.status !== 'complete'}<Button
				type="submit"
				disabled={busy || current?.status === 'grading'}
				>{busy || current?.status === 'grading'
					? 'Grading your answers…'
					: 'Submit answers'}</Button
			>{/if}
	</form>
{/if}
