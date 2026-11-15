<script lang="ts">
	import { onDestroy, untrack } from 'svelte';
	import { ArrowLeft, ArrowRight, Check, CircleHelp, List, RotateCcw } from '@lucide/svelte';
	import type { LessonAnswer, Material, StudyOutput } from '#lib/domain.js';
	import Button from '#lib/components/ui/button/button.svelte';
	import { Progress } from '#lib/components/ui/progress/index.js';
	import * as Sheet from '#lib/components/ui/sheet/index.js';
	import { LessonSession } from '#lib/study/lesson.svelte.js';
	import { plural } from '#lib/ui.js';
	import ConfirmDialog from './ConfirmDialog.svelte';
	import Markdown from './Markdown.svelte';
	import QuestionCard from './QuestionCard.svelte';

	/**
	 * A lesson: chapters and sections to move through freely or in order, each section explaining
	 * on slides before it asks its questions.
	 */
	let {
		output,
		answers,
		materials
	}: { output: StudyOutput; answers: LessonAnswer[]; materials: Material[] } = $props();
	// The viewer keys this component by output, so the lesson never changes during its life.
	const session = untrack(() => new LessonSession(output.id, output.lesson!.lesson, answers));
	const { lesson } = session;
	let contentsOpen = $state(false);
	let confirmingReset = $state(false);
	let step = $derived(session.step);
	let section = $derived(session.section);
	let question = $derived(session.question);
	let answer = $derived(question && session.answerOf(question.id));
	let feedback = $derived(question ? session.feedbackOf(question) : '');
	let total = $derived(session.score(lesson.chapters.flatMap((chapter) => chapter.sections)));
	/** Sections with a question that is open or not fully right, to offer at the end. */
	let toRevisit = $derived(
		lesson.chapters.flatMap((chapter, c) =>
			chapter.sections
				.map((item, s) => ({ chapter: c, section: s, item }))
				.filter(({ item }) =>
					item.questions.some((q) => session.answerOf(q.id)?.result.state !== 'correct')
				)
		)
	);
	const imageUrl = (id: string) => `/api/outputs/${output.id}/images/${id}`;

	function open(chapter: number, sectionIndex: number) {
		session.goTo(chapter, sectionIndex);
		contentsOpen = false;
	}
	function keys(event: KeyboardEvent) {
		const target = event.target as HTMLElement | null;
		// Arrow keys belong to whatever is being typed into or chosen from.
		if (target?.closest('input, textarea, select, [contenteditable], [role="dialog"]')) return;
		if (event.altKey || event.ctrlKey || event.metaKey) return;
		if (event.key === 'ArrowRight') session.next();
		else if (event.key === 'ArrowLeft') session.previous();
	}
	onDestroy(() => session.destroy());
</script>

<svelte:window onkeydown={keys} />

{#snippet contents()}
	<div class="space-y-4">
		<div class="space-y-1.5">
			<Progress
				value={session.questionCount ? (session.answeredCount / session.questionCount) * 100 : 0}
				aria-label="Questions answered"
			/>
			<p class="text-xs text-muted-foreground">
				{session.answeredCount} of {plural(session.questionCount, 'question')} answered
			</p>
		</div>
		<nav aria-label="Lesson contents" class="space-y-1">
			{#each lesson.chapters as chapter, c (chapter.id)}
				{@const current = !session.finished && step.chapter === c}
				<details open={current}>
					<summary class="cursor-pointer py-1.5 text-sm font-medium">
						{c + 1}. {chapter.title}
					</summary>
					<ul class="mb-2 ml-1 border-l">
						{#each chapter.sections as item, s (item.id)}
							{@const here = current && step.section === s}
							<li>
								<button
									type="button"
									class={[
										'flex w-full items-start gap-2 px-3 py-1.5 text-left text-sm hover:bg-muted/50',
										here && 'bg-muted font-medium'
									]}
									aria-current={here ? 'step' : undefined}
									onclick={() => open(c, s)}
								>
									<span class="mt-0.5 size-4 shrink-0">
										{#if session.isDone(item)}
											<Check class="size-4 text-primary" aria-label="Done" />
										{/if}
									</span>
									<span class="min-w-0 break-words">{item.title}</span>
								</button>
							</li>
						{/each}
					</ul>
				</details>
			{/each}
		</nav>
		<Button variant="ghost" size="sm" onclick={() => (confirmingReset = true)}>
			<RotateCcw />Start over
		</Button>
	</div>
{/snippet}

<div class="grid items-start gap-8 lg:grid-cols-[280px_minmax(0,1fr)]">
	<aside class="hidden lg:block" aria-label="Lesson contents">{@render contents()}</aside>
	<div class="min-w-0 space-y-6">
		<Sheet.Root bind:open={contentsOpen}>
			<Sheet.Trigger>
				{#snippet child({ props })}
					<Button {...props} variant="outline" size="sm" class="lg:hidden">
						<List />Contents
					</Button>
				{/snippet}
			</Sheet.Trigger>
			<Sheet.Content side="left" class="overflow-y-auto">
				<Sheet.Header><Sheet.Title>Contents</Sheet.Title></Sheet.Header>
				<div class="px-4 pb-6">{@render contents()}</div>
			</Sheet.Content>
		</Sheet.Root>
		{#if session.finished}
			<section class="space-y-6" aria-labelledby="lesson-summary">
				<div>
					<h3 id="lesson-summary" class="text-lg font-semibold">You reached the end</h3>
					{#if total.possible}
						<p class="mt-1 text-sm text-muted-foreground">
							{total.earned} of {total.possible} points across {plural(
								session.questionCount,
								'question'
							)}.
						</p>
					{/if}
				</div>
				{#if total.possible}
					<ul class="divide-y border">
						{#each lesson.chapters as chapter, c (chapter.id)}
							{@const score = session.score(chapter.sections)}
							<li class="flex items-center justify-between gap-3 px-4 py-2.5 text-sm">
								<span class="min-w-0 truncate">{c + 1}. {chapter.title}</span>
								<span class="shrink-0 text-muted-foreground tabular-nums">
									{score.possible ? `${score.earned} / ${score.possible}` : 'No questions'}
								</span>
							</li>
						{/each}
					</ul>
				{/if}
				{#if toRevisit.length}
					<div class="space-y-2">
						<h4 class="text-sm font-semibold">Worth another look</h4>
						<ul class="flex flex-wrap gap-2">
							{#each toRevisit as entry (entry.item.id)}
								<li>
									<Button
										variant="outline"
										size="sm"
										class="h-auto max-w-full py-1.5 whitespace-normal"
										onclick={() => open(entry.chapter, entry.section)}
									>
										{entry.item.title}
									</Button>
								</li>
							{/each}
						</ul>
					</div>
				{/if}
				<Button variant="outline" onclick={session.previous}><ArrowLeft />Back</Button>
			</section>
		{:else}
			<header class="space-y-2">
				<p class="text-xs text-muted-foreground">
					{step.chapter + 1}. {session.chapter.title}
				</p>
				<h3 class="text-lg leading-snug font-semibold">{section.title}</h3>
				<div class="flex flex-wrap gap-1" role="group" aria-label="Steps of this section">
					{#each session.sectionSteps as item (item.position)}
						{@const active = item.position === session.position}
						<button
							type="button"
							class={[
								'flex h-6 min-w-6 items-center justify-center border px-1 text-xs',
								active ? 'border-primary bg-primary text-primary-foreground' : 'hover:bg-muted'
							]}
							aria-current={active ? 'step' : undefined}
							aria-label={item.step.kind === 'beat'
								? `Slide ${item.step.index + 1}`
								: `Question ${item.step.index + 1}`}
							onclick={() => session.goToStep(item.position)}
						>
							{#if item.step.kind === 'beat'}
								{item.step.index + 1}
							{:else}
								<CircleHelp class="size-3.5" />
							{/if}
						</button>
					{/each}
				</div>
			</header>
			{#if step.kind === 'beat'}
				{@const beat = section.beats[step.index]}
				{#key beat.id}
					<div class="space-y-5">
						{#if beat.slide.kind === 'image'}
							<figure class="space-y-2">
								<img
									src={imageUrl(beat.slide.image)}
									alt={beat.slide.caption}
									class="max-h-[60vh] w-full border bg-white object-contain"
								/>
								{#if beat.slide.caption}
									<figcaption class="text-xs text-muted-foreground">
										{beat.slide.caption}
									</figcaption>
								{/if}
							</figure>
						{:else}
							<div class="border p-5">
								<Markdown text={beat.slide.markdown} outputId={output.id} class="text-base" />
							</div>
						{/if}
						<p class="max-w-3xl text-base leading-relaxed">{beat.narration}</p>
					</div>
				{/key}
			{:else if question}
				{#key question.id}
					<QuestionCard
						{question}
						bind:values={
							() => session.valuesOf(question.id), (next) => session.setDraft(question.id, next)
						}
						grade={answer?.result}
						locked={Boolean(answer) || session.busy === question.id}
						heading={`Question ${step.index + 1} of ${section.questions.length}`}
						outputId={output.id}
						projectId={output.projectId}
						{materials}
					/>
				{/key}
				{#if feedback}
					<div class="border-l-2 border-primary bg-muted px-4 py-3" role="status">
						<p class="text-xs font-semibold text-muted-foreground">Feedback</p>
						<p class="mt-1 max-w-3xl text-base leading-relaxed">{feedback}</p>
					</div>
				{/if}
				{#if session.error}<p role="alert" class="text-sm text-destructive">{session.error}</p>{/if}
			{/if}
			<div class="flex flex-wrap items-center gap-2 border-t pt-4">
				<Button variant="outline" disabled={session.position === 0} onclick={session.previous}>
					<ArrowLeft />Back
				</Button>
				{#if question && !answer}
					<Button disabled={session.busy === question.id} onclick={() => session.submit(question)}>
						{session.busy === question.id ? 'Checking…' : 'Check'}
					</Button>
					<Button variant="ghost" onclick={session.next}>Skip<ArrowRight /></Button>
				{:else}
					{#if question && answer?.status !== 'grading'}
						<Button variant="ghost" onclick={() => session.retry(question)}>
							<RotateCcw />Try again
						</Button>
					{/if}
					<Button onclick={session.next}>Continue<ArrowRight /></Button>
				{/if}
			</div>
		{/if}
	</div>
</div>

<ConfirmDialog
	bind:open={confirmingReset}
	title="Start this lesson over?"
	description="Your answers to all its questions are removed."
	confirmLabel="Start over"
	onConfirm={session.reset.bind(session)}
/>
