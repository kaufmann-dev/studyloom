<script lang="ts">
	import { toast } from 'svelte-sonner';
	import type { ImportSummary } from '#lib/domain.js';
	import Button from '#lib/components/ui/button/button.svelte';
	import * as Dialog from '#lib/components/ui/dialog/index.js';
	import Input from '#lib/components/ui/input/input.svelte';
	import { Label } from '#lib/components/ui/label/index.js';
	import ProjectSelect from '#lib/components/studyloom/ProjectSelect.svelte';
	import { browserTimeZone } from '#lib/calendar.js';
	import { api, errorText, plural } from '#lib/ui.js';

	// The API accepts JSON bodies up to 1 MB; the file travels inside one.
	const MAX_BYTES = 900 * 1024;
	let { onImported, onClose }: { onImported: () => void | Promise<void>; onClose: () => void } =
		$props();
	const uid = $props.id();
	let ics = $state('');
	let projectId = $state<string | null>(null);
	let preview = $state.raw<ImportSummary | null>(null);
	let busy = $state(false);
	let error = $state('');
	let empty = $derived(preview !== null && preview.events + preview.tasks === 0);

	const send = (commit: boolean) =>
		api<ImportSummary>('/api/calendar/import', {
			body: { ics, projectId, commit, timeZone: browserTimeZone() }
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
	async function choose(event: Event & { currentTarget: HTMLInputElement }) {
		const file = event.currentTarget.files?.[0];
		preview = null;
		ics = '';
		error = '';
		if (!file) return;
		if (file.size > MAX_BYTES) {
			error = 'This file is too large. Calendar files up to 900 KB can be imported.';
			return;
		}
		await attempt(async () => {
			ics = await file.text();
			preview = await send(false);
		});
	}
	const commit = () =>
		attempt(async () => {
			const result = await send(true);
			await onImported();
			toast.success(
				`Imported ${plural(result.events, 'event')} and ${plural(result.tasks, 'task')}.`
			);
			onClose();
		});
</script>

<Dialog.Root open onOpenChange={(open) => !open && onClose()}>
	<Dialog.Content class="sm:max-w-lg">
		<Dialog.Header>
			<Dialog.Title>Import calendar file</Dialog.Title>
			<Dialog.Description>
				Add the events and to-dos of an .ics file. Importing the same file again updates what is
				already here.
			</Dialog.Description>
		</Dialog.Header>
		<div class="space-y-4">
			<div class="space-y-2">
				<Label for="{uid}-file">Calendar file</Label>
				<Input id="{uid}-file" type="file" accept=".ics,text/calendar" onchange={choose} />
			</div>
			<div class="space-y-2">
				<Label for="{uid}-project">
					Add to project <span class="font-normal text-muted-foreground">(optional)</span>
				</Label>
				<ProjectSelect id="{uid}-project" bind:value={projectId} />
			</div>
			{#if preview}
				<div class="space-y-2 bg-muted p-4 text-sm" role="status">
					<p class="font-medium">
						{plural(preview.events, 'event')} and {plural(preview.tasks, 'task')} found{preview.updated
							? `, ${preview.updated} of them already here and updated`
							: ''}.
					</p>
					{#if preview.skipped.length}
						<ul class="list-disc space-y-1 pl-5 text-muted-foreground">
							{#each preview.skipped as item (item.reason)}
								<li>{item.reason}: {item.count}</li>
							{/each}
						</ul>
					{/if}
				</div>
			{/if}
			{#if error}<p role="alert" class="text-sm text-destructive">{error}</p>{/if}
		</div>
		<Dialog.Footer>
			<Button variant="ghost" onclick={onClose}>Cancel</Button>
			<Button disabled={busy || !preview || empty} onclick={commit}>
				{busy ? 'Working…' : 'Import'}
			</Button>
		</Dialog.Footer>
	</Dialog.Content>
</Dialog.Root>
