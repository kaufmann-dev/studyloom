<script lang="ts">
	import { onMount } from 'svelte';
	import { RefreshCw } from '@lucide/svelte';
	import Button from '#lib/components/ui/button/button.svelte';
	import ErrorAlert from '#lib/components/studyloom/ErrorAlert.svelte';
	import FeedSettings from '#lib/components/studyloom/calendar/FeedSettings.svelte';
	import MoodleSettings from '#lib/components/studyloom/calendar/MoodleSettings.svelte';
	import type { ClaudeStatus } from '#lib/domain.js';
	import { api, errorText } from '#lib/ui.js';

	let data = $state.raw<ClaudeStatus | null>(null);
	let loading = $state(true);
	let error = $state('');

	async function load() {
		loading = true;
		error = '';
		try {
			data = await api<ClaudeStatus>('/api/claude', { interaction: true });
		} catch (cause) {
			error = errorText(cause);
		} finally {
			loading = false;
		}
	}

	onMount(() => {
		void load();
	});
</script>

<svelte:head><title>Settings · Studyloom</title></svelte:head>
<div class="max-w-3xl">
	<h1 class="text-3xl font-semibold tracking-tight">Settings</h1>
	<p class="mt-2 text-muted-foreground">
		Check the Claude connection, share your calendar with other devices and sync your Moodle
		calendar.
	</p>
	<ErrorAlert message={error} class="mt-6" />
	<section class="mt-8 border p-6" aria-labelledby="claude-heading">
		<div class="flex flex-wrap items-start justify-between gap-4">
			<div>
				<h2 id="claude-heading" class="text-lg font-semibold">Claude</h2>
				<p class="mt-1 text-sm text-muted-foreground">
					Studyloom uses your Claude subscription for chat, study tools and reading sources.
				</p>
			</div>
			<Button variant="ghost" aria-label="Refresh connection" disabled={loading} onclick={load}
				><RefreshCw /></Button
			>
		</div>
		{#if loading}<p role="status" class="mt-6 text-muted-foreground">Checking connection…</p>
		{:else if data}<p class="mt-6 text-sm">
				<span class="font-medium">Status:</span>
				{data.configured ? 'Connected' : 'Not set up'}
			</p>
			{#if data.error}<p role="alert" class="mt-3 text-sm text-destructive">{data.error}</p>{/if}
			{#if !data.configured}<p class="mt-5 bg-muted p-5 text-sm">
					Create a token by running <code class="font-mono">claude setup-token</code> on any
					computer with a Claude Pro, Max or Ultra plan. Set it as
					<code class="font-mono">CLAUDE_CODE_OAUTH_TOKEN</code> in the deployment's environment, then
					restart Studyloom.
				</p>{/if}{/if}
	</section>
	<FeedSettings />
	<MoodleSettings />
	<section class="mt-8" aria-labelledby="models-heading">
		<h2 id="models-heading" class="text-lg font-semibold">Available models</h2>
		<p class="mt-2 text-sm text-muted-foreground">
			Choose a model when you chat or create study tools. The list comes from Claude Code; aliases
			such as Opus always use the newest version.
		</p>
		{#if data?.models.length}<div class="mt-5 divide-y border">
				{#each data.models as model (model.modelId)}<div class="p-5">
						<h3 class="font-medium">{model.displayLabel}</h3>
						<p class="mt-1 font-mono text-xs break-all text-muted-foreground">{model.modelId}</p>
						{#if model.description}<p class="mt-2 text-sm text-muted-foreground">
								{model.description}
							</p>{/if}
					</div>{/each}
			</div>{:else}<p class="mt-5 border border-dashed p-5 text-sm text-muted-foreground">
				Models appear once Claude is set up.
			</p>{/if}
	</section>
</div>
