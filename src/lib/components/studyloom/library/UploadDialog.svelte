<script lang="ts">
	import { Upload } from '@lucide/svelte';
	import Button from '$lib/components/ui/button/button.svelte';
	import * as Dialog from '$lib/components/ui/dialog';
	import { Progress } from '$lib/components/ui/progress';
	import type { LibraryEntry } from '$lib/domain';
	import { api, errorText, plural } from '$lib/ui';
	import { sendChunks, uploadPercent, type PendingUpload } from '$lib/upload';

	let {
		parentId,
		onClose,
		onUploaded
	}: {
		parentId: string | null;
		onClose: () => void;
		/** Called once the whole selection is stored, with the number of files. */
		onUploaded: (count: number) => void | Promise<void>;
	} = $props();

	let input: HTMLInputElement | undefined;
	let queue = $state.raw<File[]>([]);
	// The file in flight; it survives a failure so the upload can resume or be discarded.
	let pending = $state.raw<PendingUpload | null>(null);
	let uploaded = $state(0);
	let busy = $state(false);
	let dragging = $state(false);
	let error = $state('');
	let total = $derived(uploaded + queue.length + (pending ? 1 : 0));

	async function run() {
		busy = true;
		error = '';
		try {
			while (pending || queue.length) {
				if (!pending) {
					const [file, ...rest] = queue;
					const started = await api<{ entry: LibraryEntry; chunkSize: number }>(
						'/api/library/uploads',
						{
							body: {
								parentId,
								filename: file.name,
								mimeType: file.type || 'application/octet-stream',
								size: file.size
							}
						}
					);
					queue = rest;
					pending = { id: started.entry.id, file, chunkSize: started.chunkSize, nextSequence: 0 };
				}
				const sent = await sendChunks(
					pending,
					(sequence) => `/api/library/${pending!.id}/chunks/${sequence}`,
					(next) => (pending = next)
				);
				await api(`/api/library/${sent.id}/complete`, { body: {} });
				pending = null;
				uploaded += 1;
			}
			await onUploaded(uploaded);
		} catch (cause) {
			error = errorText(cause);
		} finally {
			busy = false;
		}
	}
	function choose(files: FileList | null | undefined) {
		if (busy || pending || !files?.length) return;
		queue = [...files];
		void run();
	}
	async function discard() {
		if (!pending) return;
		busy = true;
		error = '';
		try {
			await api(`/api/library/${pending.id}`, { method: 'DELETE' });
			pending = null;
			queue = [];
			await onUploaded(uploaded);
		} catch (cause) {
			error = errorText(cause);
		} finally {
			busy = false;
		}
	}
</script>

<Dialog.Root
	bind:open={
		() => true,
		(open) => {
			// An unfinished upload must be resumed or discarded, never silently abandoned.
			if (!open && !busy && !pending) onClose();
		}
	}
>
	<Dialog.Content class="sm:max-w-lg" showCloseButton={!busy && !pending}>
		<Dialog.Header>
			<Dialog.Title>Upload files</Dialog.Title>
			<Dialog.Description>
				Files are stored as they are and stay private to this workspace.
			</Dialog.Description>
		</Dialog.Header>
		{#if pending}
			<div class="space-y-2">
				<p class="text-sm break-words">
					{pending.file.name}
					{#if total > 1}
						<span class="text-muted-foreground">· file {uploaded + 1} of {total}</span>
					{/if}
				</p>
				<Progress value={uploadPercent(pending)} aria-label="Upload progress" />
				<p role="status" class="text-xs text-muted-foreground">
					{busy ? `Uploading… ${uploadPercent(pending)}%` : `Stopped at ${uploadPercent(pending)}%`}
				</p>
			</div>
		{:else}
			<input
				{@attach (element) => {
					input = element;
				}}
				type="file"
				multiple
				class="sr-only"
				tabindex="-1"
				aria-label="Choose files"
				onchange={(event) => choose(event.currentTarget.files)}
			/>
			<button
				type="button"
				disabled={busy}
				class={[
					'flex w-full flex-col items-center gap-2 border border-dashed px-6 py-10 text-center text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring',
					dragging ? 'border-primary bg-accent' : 'hover:bg-muted/60'
				]}
				onclick={() => input?.click()}
				ondragover={(event) => {
					event.preventDefault();
					dragging = true;
				}}
				ondragleave={() => (dragging = false)}
				ondrop={(event) => {
					event.preventDefault();
					dragging = false;
					choose(event.dataTransfer?.files);
				}}
			>
				<Upload class="size-6 text-muted-foreground" />
				<span class="font-medium"
					>{busy ? 'Preparing upload…' : 'Choose files or drop them here'}</span
				>
				<span class="text-xs text-muted-foreground">You can select several files at once.</span>
			</button>
		{/if}
		{#if error}<p role="alert" class="text-sm text-destructive">{error}</p>{/if}
		{#if uploaded && (pending || error)}
			<p class="text-xs text-muted-foreground">{plural(uploaded, 'file')} already uploaded.</p>
		{/if}
		<Dialog.Footer>
			{#if pending && !busy}
				<Button variant="destructive" onclick={discard}>Discard upload</Button>
				<Button onclick={run}>Resume upload</Button>
			{:else if !pending}
				<Button variant="ghost" disabled={busy} onclick={onClose}>Cancel</Button>
			{/if}
		</Dialog.Footer>
	</Dialog.Content>
</Dialog.Root>
