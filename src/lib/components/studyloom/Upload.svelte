<script lang="ts">
	import { Upload } from '@lucide/svelte';
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
				for (
					let offset = 0, sequence = 0;
					offset < file.size;
					offset += started.chunkSize, sequence++
				) {
					const response = await fetch(`/api/materials/${started.materialId}/chunks/${sequence}`, {
						method: 'PUT',
						headers: { 'content-type': 'application/octet-stream', 'x-studyloom-interaction': '1' },
						body: file.slice(offset, offset + started.chunkSize)
					});
					if (!response.ok) {
						const result = await response.json().catch(() => null);
						throw new Error(result?.message ?? `Upload failed for ${file.name}. Please try again.`);
					}
					progress = `${file.name} · ${Math.min(100, Math.round(((offset + started.chunkSize) / file.size) * 100))}%`;
				}
				await api(`/api/materials/${started.materialId}/complete`, { modelId: processingModel });
				await onSaved();
			}
			progress = 'Upload complete. Processing your materials…';
		} catch (e) {
			error = errorText(e);
		} finally {
			busy = false;
			if (input) input.value = '';
		}
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
	<Button variant="outline" class="w-full" disabled={busy} onclick={() => input.click()}
		><Upload />{busy ? 'Uploading…' : 'Upload materials'}</Button
	>
	<p class="text-xs leading-relaxed text-muted-foreground">
		Audio, video, documents, slides, and images.
	</p>
	{#if progress}<p role="status" class="text-xs break-words text-muted-foreground">
			{progress}
		</p>{/if}
	{#if error}<p role="alert" class="text-sm text-destructive">{error}</p>{/if}
</div>
