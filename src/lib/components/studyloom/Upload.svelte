<script lang="ts">
	import { RefreshCw, Upload } from '@lucide/svelte';
	import Button from '#lib/components/ui/button/button.svelte';
	import { api, errorText } from '#lib/ui.js';
	import { sendChunks, uploadPercent, type PendingUpload } from '#lib/upload.js';

	let {
		projectId,
		modelId,
		onSaved
	}: { projectId: string; modelId: string; onSaved: () => void | Promise<void> } = $props();
	let input: HTMLInputElement | undefined;
	let busy = $state(false);
	let progress = $state('');
	let error = $state('');
	// The source in flight; it survives a failure so the upload can resume or be discarded.
	let pending = $state.raw<PendingUpload | null>(null);

	/** Sends what is left of the pending upload, then queues it for processing. */
	async function finish(upload: PendingUpload, processingModel: string) {
		const sent = await sendChunks(
			upload,
			(sequence) => `/api/materials/${upload.id}/chunks/${sequence}`,
			(next) => {
				pending = next;
				progress = `${next.file.name} · ${uploadPercent(next)}%`;
			}
		);
		await api(`/api/materials/${sent.id}/complete`, { body: { modelId: processingModel } });
		pending = null;
		await onSaved();
	}
	async function attempt(work: () => Promise<void>) {
		busy = true;
		error = '';
		try {
			await work();
		} catch (cause) {
			error = errorText(cause);
		} finally {
			busy = false;
			if (input) input.value = '';
		}
	}
	function upload(files: FileList | null) {
		if (!files?.length || busy) return;
		// The model chosen when the upload starts applies to the whole selection.
		const processingModel = modelId;
		return attempt(async () => {
			for (const file of files) {
				progress = `Preparing ${file.name}…`;
				const started = await api<{ materialId: string; chunkSize: number }>(
					`/api/projects/${projectId}/uploads`,
					{
						body: {
							filename: file.name,
							size: file.size,
							mimeType: file.type || 'application/octet-stream'
						}
					}
				);
				pending = { id: started.materialId, file, chunkSize: started.chunkSize, nextSequence: 0 };
				await finish(pending, processingModel);
			}
			progress = 'Upload complete. Processing your materials…';
		});
	}
	function resumeUpload() {
		const upload = pending;
		if (!upload || busy) return;
		return attempt(async () => {
			await finish(upload, modelId);
			progress = 'Upload complete. Processing your materials…';
		});
	}
	function discardUpload() {
		const upload = pending;
		if (!upload || busy) return;
		return attempt(async () => {
			await api(`/api/materials/${upload.id}`, { method: 'DELETE' });
			pending = null;
			progress = '';
			await onSaved();
		});
	}
</script>

<div class="space-y-3">
	<input
		{@attach (element) => {
			input = element;
		}}
		type="file"
		multiple
		class="sr-only"
		tabindex="-1"
		aria-label="Select study materials"
		onchange={(event) => upload(event.currentTarget.files)}
	/>
	<div class="flex gap-2">
		<Button
			variant="outline"
			class="min-w-0 flex-1"
			disabled={busy || Boolean(pending)}
			onclick={() => input?.click()}
		>
			<Upload />{busy ? 'Uploading…' : 'Upload materials'}
		</Button>
		{#if pending}
			<Button variant="ghost" disabled={busy} onclick={resumeUpload}>
				<RefreshCw /><span class="sr-only">Resume upload</span>
			</Button>
			<Button variant="ghost" disabled={busy} onclick={discardUpload}>Discard</Button>
		{/if}
	</div>
	<p class="text-xs leading-relaxed text-muted-foreground">
		Audio, video, documents, slides, and images.
	</p>
	{#if progress}
		<p role="status" class="text-xs break-words text-muted-foreground">{progress}</p>
	{/if}
	{#if error}<p role="alert" class="text-sm text-destructive">{error}</p>{/if}
</div>
