<script lang="ts">
	import { resolve } from '$app/paths';
	import { onMount } from 'svelte';
	import { toast } from 'svelte-sonner';
	import { FolderOpen, Library, PinOff } from '@lucide/svelte';
	import Button from '$lib/components/ui/button/button.svelte';
	import ErrorAlert from '$lib/components/studyloom/ErrorAlert.svelte';
	import type { Pin } from '$lib/domain';
	import { Pins } from '$lib/pins.svelte';
	import { errorText } from '$lib/ui';

	let { data }: { data: { session: { name: string } | null } } = $props();
	const pins = new Pins();
	let loading = $state(true);
	let error = $state('');
	let firstName = $derived.by(() => {
		const name = data.session?.name.trim();
		return name && name !== 'Your workspace' ? name.split(/\s+/)[0] : 'there';
	});

	async function load() {
		loading = true;
		error = '';
		try {
			await pins.load();
		} catch (cause) {
			error = errorText(cause);
		} finally {
			loading = false;
		}
	}
	async function unpin(pin: Pin) {
		try {
			await pins.remove(pin);
		} catch (cause) {
			toast.error(errorText(cause));
		}
	}

	onMount(() => {
		void load();
	});
</script>

<svelte:head><title>Home · Studyloom</title></svelte:head>
<h1 class="text-3xl font-semibold tracking-tight">Hello, {firstName}</h1>
<section aria-labelledby="pins-heading" class="mt-12">
	<h2 id="pins-heading" class="mb-5 text-xl font-semibold">Pinned</h2>
	<ErrorAlert message={error} onRetry={load} class="mb-5" />
	{#if loading}
		<p role="status" class="py-10 text-muted-foreground">Loading pins…</p>
	{:else if error}
		<!-- The alert above already explains the failure. -->
	{:else if pins.items.length === 0}
		<div class="border border-dashed px-6 py-12">
			<p class="text-muted-foreground">Pin projects or Library items to keep them close at hand.</p>
			<div class="mt-5 flex flex-wrap gap-2">
				<Button href={resolve('/projects')} variant="outline"><FolderOpen />Browse projects</Button>
				<Button href={resolve('/library')} variant="outline"><Library />Browse Library</Button>
			</div>
		</div>
	{:else}
		<ul class="grid gap-4 sm:grid-cols-2">
			{#each pins.items as pin (pin.id)}
				<li
					class="relative flex min-w-0 items-start justify-between gap-3 border p-5 hover:bg-muted/40"
				>
					<a
						href={resolve(pin.targetType === 'project' ? '/projects/[id]' : '/library/[id]', {
							id: pin.targetId
						})}
						class="min-w-0 flex-1 outline-none after:absolute after:inset-0 focus-visible:after:ring-2 focus-visible:after:ring-ring focus-visible:after:ring-inset"
					>
						<p class="truncate font-semibold">{pin.label}</p>
						<p class="mt-1 truncate text-sm text-muted-foreground">{pin.subtitle}</p>
					</a>
					<Button
						variant="ghost"
						size="icon"
						class="relative shrink-0"
						aria-label={`Unpin ${pin.label}`}
						disabled={pins.busy === pin.targetId}
						onclick={() => unpin(pin)}><PinOff /></Button
					>
				</li>
			{/each}
		</ul>
	{/if}
</section>
