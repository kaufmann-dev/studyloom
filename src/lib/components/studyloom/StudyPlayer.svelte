<script lang="ts">
	import { Headphones, Mic, Square, SkipForward } from '@lucide/svelte';
	import Button from '#lib/components/ui/button/button.svelte';
	import type { TutorSession } from '#lib/study/tutor.svelte.js';
	import ErrorAlert from './ErrorAlert.svelte';

	let { tutor, onResume }: { tutor: TutorSession; onResume: () => void } = $props();
	const PHASES = {
		connecting: 'Getting ready…',
		presenting: 'Listen',
		listening: 'Your turn. Take your time.',
		thinking: 'Thinking about your answer…',
		feedback: 'Feedback',
		complete: 'Session complete',
		stopped: 'Paused'
	};
	const VERDICTS = {
		correct: 'Correct',
		partial: 'Partly right',
		incorrect: 'Not quite',
		none: 'No answer'
	};
	let active = $derived(tutor.phase !== 'complete' && tutor.phase !== 'stopped');
	let label = $derived(
		tutor.speaking ? 'Skip' : tutor.phase === 'listening' ? "I'm done" : 'Please wait'
	);
	function onkeydown(event: KeyboardEvent) {
		const target = event.target as HTMLElement | null;
		if (event.code !== 'Space' || !active) return;
		if (target?.closest('input, textarea, select, button, a, [contenteditable="true"]')) return;
		event.preventDefault();
		tutor.primary();
	}
</script>

<svelte:window {onkeydown} />

<section class="space-y-5 border p-5" aria-live="polite">
	<div class="flex flex-wrap items-baseline justify-between gap-2">
		<p class="text-sm font-medium">
			{#if tutor.segments}Part {tutor.segment + 1} of {tutor.segments} · {tutor.title}{/if}
		</p>
		<p class="text-xs text-muted-foreground">
			<Headphones class="inline size-3.5" /> Headphones recommended
		</p>
	</div>
	<p class="text-lg font-medium" role="status">
		{#if tutor.phase === 'listening'}<Mic class="mr-1 inline size-5" />{/if}{PHASES[tutor.phase]}
		{#if tutor.verdict && tutor.phase === 'feedback'}
			<span class="ml-2 text-sm font-normal text-muted-foreground">· {VERDICTS[tutor.verdict]}</span
			>
		{/if}
	</p>
	{#if tutor.caption}
		<p class="leading-7">{tutor.caption}</p>
	{/if}
	{#if tutor.partial && (tutor.phase === 'listening' || tutor.phase === 'thinking')}
		<p class="border-l-2 pl-3 text-sm text-muted-foreground">
			<span class="sr-only">Your answer so far: </span>{tutor.partial}
		</p>
	{/if}
	<ErrorAlert message={tutor.error} />
	<div class="flex flex-wrap gap-2">
		{#if active}
			<Button
				size="lg"
				class="min-w-40"
				disabled={!tutor.speaking && tutor.phase !== 'listening'}
				onclick={() => tutor.primary()}
			>
				{#if tutor.speaking}<SkipForward />{:else}<Mic />{/if}{label}
			</Button>
			<Button variant="outline" size="lg" onclick={() => tutor.end()}>
				<Square />End session
			</Button>
		{:else if tutor.phase === 'stopped'}
			<Button size="lg" onclick={onResume}>Resume session</Button>
		{/if}
	</div>
	{#if active}
		<p class="text-xs text-muted-foreground">
			Press Space to skip what is being said, or to finish your answer early. After a pause your
			answer counts as finished on its own.
		</p>
	{/if}
</section>
