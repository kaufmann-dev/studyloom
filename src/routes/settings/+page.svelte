<script lang="ts">
	import { onMount } from 'svelte';
	import { ExternalLink, Link, RefreshCw, Unplug } from '@lucide/svelte';
	import Button from '#lib/components/ui/button/button.svelte';
	import ErrorAlert from '#lib/components/studyloom/ErrorAlert.svelte';
	import FeedSettings from '#lib/components/studyloom/calendar/FeedSettings.svelte';
	import type { MuseStatus } from '#lib/domain.js';
	import { createPoller } from '#lib/polling.js';
	import { api, errorText } from '#lib/ui.js';

	const STATE_LABELS: Record<string, string> = {
		accountLogin: 'Connected',
		notLoggedIn: 'Not connected'
	};
	let data = $state.raw<MuseStatus | null>(null);
	let loading = $state(true);
	let busy = $state(false);
	let error = $state('');
	let login = $state.raw<{ verificationUrl: string; userCode: string } | null>(null);
	let connected = $derived(data?.account.state === 'accountLogin');

	// Keeps checking while a device login is waiting for approval.
	const poller = createPoller(async (interaction) => {
		try {
			data = await api<MuseStatus>('/api/muse', { interaction });
			if (data.account.state === 'accountLogin') login = null;
		} catch (cause) {
			error = errorText(cause);
		} finally {
			loading = false;
		}
		return login !== null;
	});
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
	const connect = () =>
		attempt(async () => {
			login = await api('/api/muse/login', { body: {} });
			void poller.run();
		});
	const disconnect = (cancelLogin = false) =>
		attempt(async () => {
			await api(cancelLogin ? '/api/muse/cancel-login' : '/api/muse/logout', { body: {} });
			login = null;
			await poller.run();
		});

	onMount(() => {
		void poller.run(true);
		return poller.stop;
	});
</script>

<svelte:head><title>Settings · Studyloom</title></svelte:head>
<div class="max-w-3xl">
	<h1 class="text-3xl font-semibold tracking-tight">Settings</h1>
	<p class="mt-2 text-muted-foreground">
		Connect your Muse account and share your calendar with other devices.
	</p>
	<ErrorAlert message={error} class="mt-6" />
	<section class="mt-8 border p-6" aria-labelledby="muse-heading">
		<div class="flex flex-wrap items-start justify-between gap-4">
			<div>
				<h2 id="muse-heading" class="text-lg font-semibold">Muse subscription</h2>
				<p class="mt-1 text-sm text-muted-foreground">
					Your Studyloom sign-in and Muse connection are separate.
				</p>
			</div>
			<Button variant="ghost" aria-label="Refresh connection" onclick={() => poller.run(true)}
				><RefreshCw /></Button
			>
		</div>
		{#if loading}<p role="status" class="mt-6 text-muted-foreground">Checking connection…</p>
		{:else if data}<p class="mt-6 text-sm">
				<span class="font-medium">Status:</span>
				{STATE_LABELS[data.account.state] ?? data.account.state.replaceAll('_', ' ')}{data.account
					.label
					? ` · ${data.account.label}`
					: ''}
			</p>
			{#if data.error}<p role="alert" class="mt-3 text-sm text-destructive">{data.error}</p>{/if}
			{#if login}<div class="mt-5 space-y-4 bg-muted p-5">
					<p class="text-sm">Open Muse and enter this code to approve the connection.</p>
					<p class="font-mono text-2xl font-semibold tracking-widest break-all">{login.userCode}</p>
					<div class="flex flex-wrap gap-2">
						<Button href={login.verificationUrl} target="_blank" rel="noopener noreferrer"
							>Continue to Muse<ExternalLink /></Button
						><Button variant="outline" disabled={busy} onclick={() => disconnect(true)}
							>Cancel</Button
						>
					</div>
					<p role="status" class="text-sm text-muted-foreground">Waiting for approval…</p>
				</div>
			{:else if connected}<Button
					class="mt-5"
					variant="outline"
					disabled={busy}
					onclick={() => disconnect()}><Unplug />Disconnect Muse</Button
				>
			{:else}<Button class="mt-5" disabled={busy} onclick={connect}
					><Link />{busy ? 'Starting login…' : 'Connect Muse account'}</Button
				>{/if}{/if}
	</section>
	<FeedSettings />
	<section class="mt-8" aria-labelledby="models-heading">
		<h2 id="models-heading" class="text-lg font-semibold">Available models</h2>
		<p class="mt-2 text-sm text-muted-foreground">
			Choose a model when you chat or create study tools. Refresh this page to discover models added
			to your account.
		</p>
		{#if data?.models.length}<div class="mt-5 divide-y border">
				{#each data.models as model (model.modelId)}<div class="p-5">
						<h3 class="font-medium">{model.displayLabel}</h3>
						<p class="mt-1 font-mono text-xs break-all text-muted-foreground">{model.modelId}</p>
						{#if model.description}<p class="mt-2 text-sm text-muted-foreground">
								{model.description}
							</p>{/if}{#if model.contextLimit}<p class="mt-2 text-xs text-muted-foreground">
								Context: {model.contextLimit.toLocaleString()} tokens
							</p>{/if}
					</div>{/each}
			</div>{:else}<p class="mt-5 border border-dashed p-5 text-sm text-muted-foreground">
				Models appear after your Muse account is connected.
			</p>{/if}
	</section>
</div>
