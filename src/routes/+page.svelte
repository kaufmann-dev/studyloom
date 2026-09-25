<script lang="ts">
	import { resolve } from '$app/paths';
	import { onMount } from 'svelte';
	import { ArrowUpRight, FolderOpen, Library, PinOff } from '@lucide/svelte';
	import Button from '$lib/components/ui/button/button.svelte';
	import { api, errorText } from '$lib/ui';
	import type { Pin } from '$lib/domain';

	let { data }: { data: { session: { name: string } | null } } = $props();
	let pins = $state.raw<Pin[]>([]);
	let loading = $state(true);
	let error = $state('');
	let busyId = $state<string | null>(null);
	let firstName = $derived(
		data.session?.name?.trim() && data.session.name.trim() !== 'Your workspace'
			? data.session.name.trim().split(/\s+/)[0]
			: 'there'
	);
	function pinHref(pin: Pin) {
		return pin.targetType === 'project'
			? resolve('/projects/[id]', { id: pin.targetId })
			: resolve('/library/[id]', { id: pin.targetId });
	}

	async function loadPins() {
		loading = true;
		error = '';
		try {
			pins = (await api<{ pins: Pin[] }>('/api/pins', undefined, 'GET', true)).pins;
		} catch (cause) {
			error = errorText(cause);
		} finally {
			loading = false;
		}
	}

	async function unpin(pin: Pin) {
		busyId = pin.id;
		error = '';
		try {
			await api(`/api/pins/${pin.id}`, undefined, 'DELETE');
			pins = pins.filter((item) => item.id !== pin.id);
		} catch (cause) {
			error = errorText(cause);
		} finally {
			busyId = null;
		}
	}

	onMount(() => {
		void loadPins();
	});
</script>

<svelte:head><title>Home · Studyloom</title></svelte:head>
<div class="mx-auto max-w-5xl">
	<h1 class="text-3xl font-semibold tracking-tight">Hello, {firstName}</h1>
	<section aria-labelledby="pins-heading" class="mt-12">
		<div class="mb-5 flex items-center justify-between gap-4">
			<h2 id="pins-heading" class="text-xl font-semibold">Pinned</h2>
		</div>
		{#if error}<div
				role="alert"
				class="mb-5 border border-destructive/30 p-4 text-sm text-destructive"
			>
				{error}
				<Button variant="ghost" onclick={loadPins}>Retry</Button>
			</div>{/if}
		{#if loading}<p role="status" class="py-10 text-muted-foreground">Loading pins…</p>
		{:else if pins.length === 0}<div class="border border-dashed px-6 py-12">
				<p class="text-muted-foreground">
					Pin projects or Library items to keep them close at hand.
				</p>
				<div class="mt-5 flex flex-wrap gap-2">
					<Button href={resolve('/projects')} variant="outline"
						><FolderOpen />Browse projects</Button
					>
					<Button href={resolve('/library')} variant="outline"><Library />Browse Library</Button>
				</div>
			</div>
		{:else}<div class="grid gap-4 sm:grid-cols-2">
				{#each pins as pin (pin.id)}
					<div class="flex min-w-0 items-start justify-between gap-3 border p-5">
						<a
							href={pinHref(pin)}
							class="min-w-0 flex-1 focus-visible:outline-2 focus-visible:outline-primary"
						>
							<p class="truncate font-semibold">{pin.label}</p>
							<p class="mt-1 truncate text-sm text-muted-foreground">
								{pin.subtitle || (pin.targetType === 'project' ? 'Project' : 'Library')}
							</p>
						</a>
						<div class="flex shrink-0 gap-1">
							<Button
								href={pinHref(pin)}
								variant="ghost"
								size="icon"
								aria-label={`Open ${pin.label}`}><ArrowUpRight /></Button
							>
							<Button
								variant="ghost"
								size="icon"
								aria-label={`Unpin ${pin.label}`}
								disabled={busyId === pin.id}
								onclick={() => unpin(pin)}><PinOff /></Button
							>
						</div>
					</div>
				{/each}
			</div>{/if}
	</section>
</div>
