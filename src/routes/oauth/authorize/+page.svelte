<script lang="ts">
	import { page } from '$app/state';
	import { AudioLines } from '@lucide/svelte';
	import Button from '#lib/components/ui/button/button.svelte';
	import type { PageProps } from './$types';

	let { data }: PageProps = $props();
</script>

<svelte:head><title>Connect app · Studyloom</title></svelte:head>
<div class="mx-auto flex min-h-screen max-w-md flex-col justify-center px-6 py-12">
	<AudioLines class="mb-7 size-10 text-foreground" />
	<h1 class="text-3xl font-semibold tracking-tight break-words">Connect {data.clientName}?</h1>
	<p class="mt-4 leading-relaxed text-muted-foreground">
		{data.clientName} wants to use your Studyloom workspace. It will be able to read your projects, sources,
		overviews, quizzes and chats, add text sources, overviews and quizzes, and read and change your tasks,
		calendar events and Library items.
	</p>
	<p class="mt-4 text-sm leading-relaxed text-muted-foreground">
		Only connect apps you set up yourself. Afterwards you return to <span
			class="font-medium break-all text-foreground">{data.redirectHost}</span
		>.
	</p>
	<!-- A native POST: both actions answer with a redirect to the app's own address. -->
	<form method="POST" class="mt-8 flex gap-3">
		<Button
			type="submit"
			variant="outline"
			class="h-11 flex-1"
			formaction={`${page.url.search}&/deny`}>Deny</Button
		>
		<Button type="submit" class="h-11 flex-1" formaction={`${page.url.search}&/allow`}>Allow</Button
		>
	</form>
</div>
