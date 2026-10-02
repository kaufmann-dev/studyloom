<script lang="ts">
	import { onMount } from 'svelte';
	import { CalendarSync, Copy, RefreshCw } from '@lucide/svelte';
	import type { CalendarFeed } from '#lib/domain.js';
	import Button from '#lib/components/ui/button/button.svelte';
	import Input from '#lib/components/ui/input/input.svelte';
	import { Label } from '#lib/components/ui/label/index.js';
	import * as NativeSelect from '#lib/components/ui/native-select/index.js';
	import ConfirmDialog from '#lib/components/studyloom/ConfirmDialog.svelte';
	import ErrorAlert from '#lib/components/studyloom/ErrorAlert.svelte';
	import { browserTimeZone } from '#lib/calendar.js';
	import { api, copyText, errorText } from '#lib/ui.js';

	const uid = $props.id();
	let feed = $state.raw<CalendarFeed | null>(null);
	let zones = $state.raw<string[]>([]);
	let busy = $state(false);
	let error = $state('');
	let confirmRegenerate = $state(false);
	let confirmDisable = $state(false);
	let options = $derived(
		feed?.timeZone && !zones.includes(feed.timeZone) ? [feed.timeZone, ...zones] : zones
	);

	async function attempt(work: () => Promise<void>) {
		busy = true;
		error = '';
		try {
			await work();
		} catch (cause) {
			error = errorText(cause);
		} finally {
			busy = false;
		}
	}
	const request = (method: 'GET' | 'POST' | 'PATCH', timeZone?: string) =>
		api<CalendarFeed>('/api/calendar/feed', { method, body: timeZone && { timeZone } });
	// Rethrows so a confirmation dialog can show the failure itself.
	async function create() {
		feed = await request('POST', feed?.timeZone ?? browserTimeZone());
	}
	async function disable() {
		await api('/api/calendar/feed', { method: 'DELETE' });
		feed = await request('GET');
	}
	const setTimeZone = (timeZone: string) =>
		attempt(async () => {
			feed = await request('PATCH', timeZone);
		});

	onMount(() => {
		zones = Intl.supportedValuesOf('timeZone');
		void attempt(async () => {
			feed = await request('GET');
		});
	});
</script>

<section class="mt-8 border p-6" aria-labelledby="{uid}-heading">
	<h2 id="{uid}-heading" class="text-lg font-semibold">Calendar feed</h2>
	<p class="mt-1 text-sm text-muted-foreground">
		Subscribe to your events and open tasks from a phone or another calendar app.
	</p>
	<ErrorAlert message={error} class="mt-4" />
	{#if !feed}
		{#if !error}<p role="status" class="mt-6 text-muted-foreground">Loading feed…</p>{/if}
	{:else if feed.url}
		<div class="mt-6 space-y-5">
			<div class="space-y-2">
				<Label for="{uid}-url">Feed address</Label>
				<div class="flex gap-2">
					<Input id="{uid}-url" readonly value={feed.url} class="font-mono text-xs" />
					<Button
						variant="outline"
						size="icon"
						aria-label="Copy feed address"
						onclick={() => copyText(feed?.url ?? '', 'Feed address copied.')}><Copy /></Button
					>
				</div>
				<p class="text-xs text-muted-foreground">
					Anyone with this address can read your calendar, so keep it private. Calendar apps refresh
					subscriptions on their own schedule, often every few hours.
				</p>
			</div>
			<div class="space-y-2">
				<Label for="{uid}-zone">Time zone of your events</Label>
				<NativeSelect.Root
					id="{uid}-zone"
					class="w-full sm:w-72"
					disabled={busy}
					bind:value={() => feed?.timeZone ?? '', setTimeZone}
				>
					{#each options as zone (zone)}
						<NativeSelect.Option value={zone}>{zone.replaceAll('_', ' ')}</NativeSelect.Option>
					{/each}
				</NativeSelect.Root>
			</div>
			<div class="flex flex-wrap gap-2">
				<Button href={feed.url.replace(/^https?:/, 'webcal:')}>
					<CalendarSync />Subscribe on this device
				</Button>
				<Button variant="outline" disabled={busy} onclick={() => (confirmRegenerate = true)}>
					<RefreshCw />New address
				</Button>
				<Button variant="ghost" disabled={busy} onclick={() => (confirmDisable = true)}>
					Turn off
				</Button>
			</div>
		</div>
	{:else}
		<Button class="mt-5" disabled={busy} onclick={() => attempt(create)}>
			<CalendarSync />{busy ? 'Turning on…' : 'Turn on feed'}
		</Button>
	{/if}
</section>
<ConfirmDialog
	bind:open={confirmRegenerate}
	title="Create a new feed address?"
	description="The current address stops working, so every device has to subscribe again."
	confirmLabel="Create new address"
	onConfirm={create}
/>
<ConfirmDialog
	bind:open={confirmDisable}
	title="Turn off the calendar feed?"
	description="Subscribed devices stop receiving updates. Turning the feed on again creates a new address."
	confirmLabel="Turn off"
	onConfirm={disable}
/>
