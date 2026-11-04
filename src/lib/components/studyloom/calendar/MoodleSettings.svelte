<script lang="ts">
	import { onMount } from 'svelte';
	import { defaults, superForm } from 'sveltekit-superforms';
	import { zod4, zod4Client } from 'sveltekit-superforms/adapters';
	import { GraduationCap, Link, RefreshCw, Unplug } from '@lucide/svelte';
	import { moodleInput, type MoodleCalendar } from '#lib/domain.js';
	import Button from '#lib/components/ui/button/button.svelte';
	import * as Form from '#lib/components/ui/form/index.js';
	import Input from '#lib/components/ui/input/input.svelte';
	import * as NativeSelect from '#lib/components/ui/native-select/index.js';
	import ConfirmDialog from '#lib/components/studyloom/ConfirmDialog.svelte';
	import ErrorAlert from '#lib/components/studyloom/ErrorAlert.svelte';
	import { browserTimeZone } from '#lib/calendar.js';
	import { getTasks } from '#lib/tasks.svelte.js';
	import { api, errorText, plural, timeAgo } from '#lib/ui.js';

	const uid = $props.id();
	const tasks = getTasks();
	const editor = superForm(defaults({ url: '', timeZone: '' }, zod4(moodleInput)), {
		validators: zod4Client(moodleInput),
		SPA: true,
		id: 'moodle-calendar'
	});
	const { form } = editor;
	let status = $state.raw<MoodleCalendar | null>(null);
	let zones = $state.raw<string[]>([]);
	let editing = $state(false);
	let busy = $state(false);
	let error = $state('');
	let confirmDisconnect = $state(false);
	let showForm = $derived(status !== null && (!status.connected || editing));

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
	/** Applies a new status; synced Moodle tasks appear in the shared task lists right away. */
	async function show(next: MoodleCalendar) {
		status = next;
		await tasks.load();
	}
	function edit() {
		$form.url = '';
		$form.timeZone = status?.timeZone ?? browserTimeZone();
		editing = true;
	}
	async function connect(event: SubmitEvent) {
		event.preventDefault();
		if (!(await editor.validateForm({ update: true })).valid) return;
		await attempt(async () => {
			await show(await api<MoodleCalendar>('/api/calendar/moodle', { method: 'PUT', body: $form }));
			editing = false;
		});
	}
	const sync = () =>
		attempt(async () => {
			await show(await api<MoodleCalendar>('/api/calendar/moodle/sync', { body: {} }));
		});
	// Rethrows so the confirmation dialog shows the failure itself.
	async function disconnect() {
		await api('/api/calendar/moodle', { method: 'DELETE' });
		await show(await api<MoodleCalendar>('/api/calendar/moodle'));
	}

	onMount(() => {
		zones = Intl.supportedValuesOf('timeZone');
		$form.timeZone = browserTimeZone();
		void attempt(async () => {
			status = await api<MoodleCalendar>('/api/calendar/moodle');
		});
	});
</script>

<section class="mt-8 border p-6" aria-labelledby="{uid}-heading">
	<h2 id="{uid}-heading" class="flex items-center gap-2 text-lg font-semibold">
		<GraduationCap class="size-5" />Moodle calendar
	</h2>
	<p class="mt-1 text-sm text-muted-foreground">
		Show your Moodle calendar here. Sessions become events and due dates become tasks you can tick
		off. Moodle items are read-only and update every 30 minutes.
	</p>
	<ErrorAlert message={error} class="mt-4" />
	{#if !status}
		{#if !error}<p role="status" class="mt-6 text-muted-foreground">Loading…</p>{/if}
	{:else if showForm}
		<form onsubmit={connect} class="mt-6 space-y-4" novalidate>
			<Form.Field form={editor} name="url">
				<Form.Control>
					{#snippet children({ props })}
						<Form.Label>Calendar address</Form.Label>
						<Input
							{...props}
							type="url"
							bind:value={$form.url}
							placeholder="https://…/calendar/export_execute.php?…"
							autocomplete="off"
							class="font-mono text-xs"
						/>
					{/snippet}
				</Form.Control>
				<Form.Description>
					In Moodle, open Calendar → Import or export calendars → Export calendar, choose All events
					and the longest time range, then Get calendar URL. The address works like a password; it
					is never shown again here.
				</Form.Description>
				<Form.FieldErrors />
			</Form.Field>
			<Form.Field form={editor} name="timeZone">
				<Form.Control>
					{#snippet children({ props })}
						<Form.Label>Your time zone</Form.Label>
						<NativeSelect.Root {...props} class="w-full sm:w-72" bind:value={$form.timeZone}>
							{#each zones as zone (zone)}
								<NativeSelect.Option value={zone}>{zone.replaceAll('_', ' ')}</NativeSelect.Option>
							{/each}
						</NativeSelect.Root>
					{/snippet}
				</Form.Control>
				<Form.FieldErrors />
			</Form.Field>
			<div class="flex flex-wrap gap-2">
				<Button type="submit" disabled={busy}>
					<Link />{busy ? 'Connecting…' : status.connected ? 'Save address' : 'Connect Moodle'}
				</Button>
				{#if editing}
					<Button variant="ghost" disabled={busy} onclick={() => (editing = false)}>Cancel</Button>
				{/if}
			</div>
		</form>
	{:else}
		<dl class="mt-6 grid gap-x-6 gap-y-2 text-sm sm:grid-cols-[auto_1fr]">
			<dt class="text-muted-foreground">Site</dt>
			<dd>{status.host}</dd>
			<dt class="text-muted-foreground">Time zone</dt>
			<dd>{status.timeZone?.replaceAll('_', ' ')}</dd>
			<dt class="text-muted-foreground">Synced</dt>
			<dd>
				{status.lastSyncedAt ? timeAgo(status.lastSyncedAt) : 'Not yet'} · {plural(
					status.events,
					'event'
				)}, {plural(status.tasks, 'task')}
			</dd>
		</dl>
		<ErrorAlert
			message={status.lastError ? `The last sync failed: ${status.lastError}` : ''}
			class="mt-4"
		/>
		<div class="mt-5 flex flex-wrap gap-2">
			<Button disabled={busy} onclick={sync}>
				<RefreshCw />{busy ? 'Syncing…' : 'Sync now'}
			</Button>
			<Button variant="outline" disabled={busy} onclick={edit}>Change address</Button>
			<Button variant="ghost" disabled={busy} onclick={() => (confirmDisconnect = true)}>
				<Unplug />Disconnect
			</Button>
		</div>
	{/if}
</section>
<ConfirmDialog
	bind:open={confirmDisconnect}
	title="Disconnect Moodle?"
	description="All events and tasks synced from Moodle are removed from Studyloom. Moodle itself is not changed."
	confirmLabel="Disconnect"
	onConfirm={disconnect}
/>
