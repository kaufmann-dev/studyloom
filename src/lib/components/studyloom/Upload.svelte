<script lang="ts">
	import { RefreshCw, Upload } from '@lucide/svelte';
	import Button from '$lib/components/ui/button/button.svelte';
	import { api, errorText } from '$lib/ui';
	let {
		projectId,
		modelId,
		onSaved
	}: { projectId: string; modelId: string; onSaved: () => void | Promise<void> } = $props();
	let input: HTMLInputElement;
	let busy = $state(false);
	let progress = $state('');
	let error = $state('');
	type PendingUpload = {
		materialId: string;
		file: File;
		chunkSize: number;
		nextSequence: number;
	};
	let pending = $state<PendingUpload | null>(null);

	async function sendChunks(upload: PendingUpload) {
		let next = upload;
		for (
			let offset = next.nextSequence * next.chunkSize, sequence = next.nextSequence;
			offset < next.file.size;
			offset += next.chunkSize, sequence++
		) {
			pending = next;
			const response = await fetch(`/api/materials/${next.materialId}/chunks/${sequence}`, {
				method: 'PUT',
				headers: { 'content-type': 'application/octet-stream', 'x-studyloom-interaction': '1' },
				body: next.file.slice(offset, offset + next.chunkSize)
			});
			if (!response.ok) {
				const result = await response.json().catch(() => null);
				throw new Error(
					result?.message ?? `Upload failed for ${next.file.name}. Please try again.`
				);
			}
			next = { ...next, nextSequence: sequence + 1 };
			progress = `${next.file.name} · ${Math.min(100, Math.round(((offset + next.chunkSize) / next.file.size) * 100))}%`;
		}
		return next;
	}

	async function complete(upload: PendingUpload, processingModel: string) {
		await api(`/api/materials/${upload.materialId}/complete`, { modelId: processingModel });
		pending = null;
		await onSaved();
	}

	async function upload(files: FileList | null) {
		if (!files?.length || busy) return;
		const processingModel = modelId;
		busy = true;
		error = '';
		try {
			for (const file of Array.from(files)) {
				progress = `Preparing ${file.name}…`;
				const started = await api<{ materialId: string; chunkSize: number }>(
					`/api/projects/${projectId}/uploads`,
					{
						filename: file.name,
						size: file.size,
						mimeType: file.type || 'application/octet-stream'
					}
				);
				const upload = {
					materialId: started.materialId,
					file,
					chunkSize: started.chunkSize,
					nextSequence: 0
				};
				pending = upload;
				await complete(await sendChunks(upload), processingModel);
			}
			progress = 'Upload complete. Processing your materials…';
		} catch (e) {
			error = errorText(e);
		} finally {
			busy = false;
			if (input) input.value = '';
		}
	}
	async function resumeUpload() {
		if (!pending || busy) return;
		const upload = pending;
		busy = true;
		error = '';
		try {
			await complete(await sendChunks(upload), modelId);
			progress = 'Upload complete. Processing your materials…';
		} catch (e) {
			error = errorText(e);
		} finally {
			busy = false;
			if (input) input.value = '';
		}
	}
	function discardUpload() {
		if (busy) return;
		pending = null;
		progress = '';
		error = '';
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
		accept=".pdf,.docx,.pptx,.txt,.md,.png,.jpg,.jpeg,.webp,.mp3,.wav,.m4a,.webm,.ogg,.mp4,.mov"
	/>
	<div class="flex gap-2">
		<Button
			variant="outline"
			class="min-w-0 flex-1"
			disabled={busy || Boolean(pending)}
			onclick={() => input.click()}><Upload />{busy ? 'Uploading…' : 'Upload materials'}</Button
		>
		{#if pending}<Button variant="ghost" disabled={busy} onclick={resumeUpload}
				><RefreshCw /><span class="sr-only">Resume upload</span></Button
			><Button variant="ghost" disabled={busy} onclick={discardUpload}>Discard</Button>{/if}
	</div>
	<p class="text-xs leading-relaxed text-muted-foreground">
		Audio, video, documents, slides, and images.
	</p>
	{#if progress}<p role="status" class="text-xs break-words text-muted-foreground">
			{progress}
		</p>{/if}
	{#if error}<p role="alert" class="text-sm text-destructive">{error}</p>{/if}
</div>
