<script lang="ts">
	import { onMount } from 'svelte';
	import { page } from '$app/state';
	import { Copy, Unplug } from '@lucide/svelte';
	import type { Connection } from '#lib/domain.js';
	import Button from '#lib/components/ui/button/button.svelte';
	import Input from '#lib/components/ui/input/input.svelte';
	import { Label } from '#lib/components/ui/label/index.js';
	import ConfirmDialog from '#lib/components/studyloom/ConfirmDialog.svelte';
	import ErrorAlert from '#lib/components/studyloom/ErrorAlert.svelte';
	import { api, copyText, dateLabel, errorText } from '#lib/ui.js';

	const uid = $props.id();
	let connections = $state.raw<Connection[] | null>(null);
	let error = $state('');
	// Kept after the dialog closes so its title does not change while it fades out.
	let target = $state.raw<Connection | null>(null);
	let confirmOpen = $state(false);
	let serverUrl = $derived(`${page.url.origin}/mcp`);

	async function load() {
		error = '';
		try {
			({ connections } = await api<{ connections: Connection[] }>('/api/connections'));
		} catch (cause) {
			error = errorText(cause);
		}
	}
	function confirmDisconnect(connection: Connection) {
		target = connection;
		confirmOpen = true;
	}
	// Rethrows so the confirmation dialog can show the failure itself.
	async function disconnect() {
		if (!target) return;
		await api(`/api/connections/${target.id}`, { method: 'DELETE' });
		await load();
	}

	onMount(() => {
		void load();
	});
</script>

<section class="mt-8 border p-6" aria-labelledby="{uid}-heading">
	<h2 id="{uid}-heading" class="text-lg font-semibold">Connected apps</h2>
	<p class="mt-1 text-sm text-muted-foreground">
		Let AI apps such as Claude use your workspace through MCP. Each app signs in with your Pocket ID
		account and asks for approval.
	</p>
	<div class="mt-6 space-y-2">
		<Label for="{uid}-url">MCP server URL</Label>
		<div class="flex gap-2">
			<Input id="{uid}-url" readonly value={serverUrl} class="font-mono text-xs" />
			<Button
				variant="outline"
				size="icon"
				aria-label="Copy MCP server URL"
				onclick={() => copyText(serverUrl, 'MCP server URL copied.')}><Copy /></Button
			>
		</div>
		<ul class="space-y-1 pt-1 text-xs leading-relaxed text-muted-foreground">
			<li>
				<span class="font-medium text-foreground">Claude:</span> Settings → Connectors → Add custom connector,
				then paste the URL.
			</li>
			<li>
				<span class="font-medium text-foreground">Claude Code:</span>
				<code class="bg-muted px-1 py-0.5 font-mono break-all"
					>claude mcp add -s user --transport http studyloom {serverUrl}</code
				>
			</li>
			<li>
				<span class="font-medium text-foreground">Codex:</span>
				<code class="bg-muted px-1 py-0.5 font-mono break-all"
					>codex mcp add studyloom --url {serverUrl}</code
				>, then <code class="bg-muted px-1 py-0.5 font-mono">codex mcp login studyloom</code>
			</li>
		</ul>
	</div>
	<ErrorAlert message={error} class="mt-6" />
	{#if !connections}
		{#if !error}<p role="status" class="mt-6 text-muted-foreground">Loading apps…</p>{/if}
	{:else if connections.length}
		<ul class="mt-6 divide-y border">
			{#each connections as connection (connection.id)}
				<li class="flex flex-wrap items-center justify-between gap-4 p-5">
					<div class="min-w-0">
						<h3 class="font-medium break-words">{connection.clientName}</h3>
						<p class="mt-1 text-sm text-muted-foreground">
							Approved by {connection.userName} · connected
							<time datetime={connection.createdAt}>{dateLabel(connection.createdAt)}</time> · last
							used <time datetime={connection.lastUsedAt}>{dateLabel(connection.lastUsedAt)}</time>
						</p>
					</div>
					<Button
						variant="outline"
						aria-label={`Disconnect ${connection.clientName}`}
						onclick={() => confirmDisconnect(connection)}><Unplug />Disconnect</Button
					>
				</li>
			{/each}
		</ul>
	{:else}
		<p class="mt-6 border border-dashed p-5 text-sm text-muted-foreground">
			No apps are connected.
		</p>
	{/if}
</section>
<ConfirmDialog
	bind:open={confirmOpen}
	title={`Disconnect ${target?.clientName ?? 'app'}?`}
	description="It loses access right away. To use it again, connect it again from the app."
	confirmLabel="Disconnect"
	onConfirm={disconnect}
/>
