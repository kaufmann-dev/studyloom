<script lang="ts">
	import { page } from '$app/state';
	import { AudioLines, ArrowRight } from '@lucide/svelte';
	import Button from '$lib/components/ui/button/button.svelte';
	const legalDomain = 'studyloom.kaufmann.dev';
	let returnTo = $derived(page.url.searchParams.get('returnTo') ?? '/');
	let signInHref = $derived(
		`/auth/start?returnTo=${encodeURIComponent(returnTo.startsWith('/') && !returnTo.startsWith('//') ? returnTo : '/')}`
	);
</script>

<svelte:head><title>Sign in · Studyloom</title></svelte:head>
<div class="mx-auto flex min-h-screen max-w-md flex-col justify-center px-6 py-12">
	<AudioLines class="mb-7 size-10 text-foreground" />
	<h1 class="text-3xl font-semibold tracking-tight">Studyloom</h1>
	<p class="mt-4 leading-relaxed text-muted-foreground">
		Bring your recordings and course materials together. Build understanding with source-backed
		conversations, summaries, and quizzes.
	</p>
	{#if page.url.searchParams.has('error')}<p role="alert" class="mt-5 text-sm text-destructive">
			Sign-in could not be completed. Please try again.
		</p>{/if}
	<Button href={signInHref} class="mt-8 h-11 justify-between"
		>Sign in with Pocket ID<ArrowRight /></Button
	>
	<div class="mt-12 flex gap-5 text-sm text-muted-foreground">
		<a
			class="underline underline-offset-4"
			href={`https://legal.kaufmann.dev/imprint?site=${legalDomain}`}>Imprint</a
		><a
			class="underline underline-offset-4"
			href={`https://legal.kaufmann.dev/privacy?site=${legalDomain}`}>Privacy</a
		>
	</div>
</div>
