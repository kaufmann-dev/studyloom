<script lang="ts">
	import { resolve } from '$app/paths';
	import type { Path } from '$app/types';
	import { toast } from 'svelte-sonner';
	import { RefreshCw, Save, Trash2 } from '@lucide/svelte';
	import type { Material } from '#lib/domain.js';
	import Button from '#lib/components/ui/button/button.svelte';
	import { Checkbox } from '#lib/components/ui/checkbox/index.js';
	import { Spinner } from '#lib/components/ui/spinner/index.js';
	import { api, errorText, fileSize } from '#lib/ui.js';
	import ConfirmDialog from './ConfirmDialog.svelte';

	let {
		projectId,
		materials,
		selectable,
		selected = $bindable(),
		modelId,
		onRefresh,
		onDeleted

		/** Ids of the sources that hold readable text and can back chat and study tools. */
		/** Model used when a source is processed again. */
	}: {
		projectId: string;
		materials: Material[];
		selectable: string[];
		selected: string[];
		modelId: string;
		onRefresh: (interaction?: boolean) => void | Promise<void>;
		onDeleted: (id: string) => void | Promise<void>;
	} = $props();

	const STATUS_LABELS: Record<Material['status'], string> = {
		uploading: 'Upload incomplete',
		processing: 'Processing',
		ready: 'Ready',
		partial: 'Partly readable',
		failed: 'Failed',
		recording: 'Recording',
		paused: 'Recording paused'
	};
	let busy = $state('');
	let deleting = $state.raw<Material | null>(null);

	function canRetry(material: Material) {
		return (
			material.status === 'failed' ||
			(material.status === 'partial' && selectable.includes(material.id)) ||
			(material.status === 'uploading' && material.receivedBytes === material.size)
		);
	}
	function toggle(id: string, checked: boolean) {
		selected = checked ? [...new Set([...selected, id])] : selected.filter((value) => value !== id);
	}
	async function act(material: Material, path: string, body: unknown) {
		busy = material.id;
		try {
			await api(path, { body });
			await onRefresh();
		} catch (cause) {
			toast.error(errorText(cause));
		} finally {
			busy = '';
		}
	}
	async function remove() {
		const material = deleting;
		if (!material) return;
		await api(`/api/materials/${material.id}`, { method: 'DELETE' });
		toast.success(`Deleted “${material.name}”.`);
		await onDeleted(material.id);
	}
</script>

<section aria-labelledby="sources-heading">
	<div class="mb-3 flex items-center justify-between">
		<h2 id="sources-heading" class="text-sm font-semibold">
			Sources <span class="font-normal text-muted-foreground">({materials.length})</span>
		</h2>
		<Button
			variant="ghost"
			size="icon-sm"
			aria-label="Refresh sources"
			onclick={() => onRefresh(true)}
		>
			<RefreshCw />
		</Button>
	</div>
	{#if selectable.length}
		<div class="mb-3 flex items-center gap-3 text-xs">
			<button
				type="button"
				class="min-h-6 underline underline-offset-4"
				onclick={() => (selected = selectable)}>Select all</button
			>
			<button
				type="button"
				class="min-h-6 underline underline-offset-4"
				onclick={() => (selected = [])}>Clear</button
			>
			<span class="ml-auto text-muted-foreground">{selected.length} selected</span>
		</div>
	{/if}
	{#if !materials.length}
		<p class="border border-dashed p-4 text-sm leading-relaxed text-muted-foreground">
			Add a file, pasted text, a web page or a recording to give this project its first source.
		</p>
	{:else}
		<ul class="divide-y border">
			{#each materials as material (material.id)}
				<li class="p-3">
					<div class="flex items-start gap-2">
						<Checkbox
							class="mt-0.5"
							aria-label={`Use ${material.name} as a source`}
							checked={selected.includes(material.id)}
							disabled={!selectable.includes(material.id)}
							onCheckedChange={(checked) => toggle(material.id, checked)}
						/>
						<div class="min-w-0 flex-1">
							<a
								href={resolve(`/projects/${projectId}?material=${material.id}` as Path)}
								class="block truncate text-sm font-medium hover:underline"
								title={material.name}>{material.name}</a
							>

							<p class="mt-1 flex items-center gap-1.5 text-xs text-muted-foreground">
								{#if material.status === 'processing'}
									<Spinner class="size-3" role="presentation" />
								{/if}
								<span class={[material.status === 'failed' && 'text-destructive']}
									>{STATUS_LABELS[material.status]}</span
								>
								{#if material.size}
									<span>· {fileSize(material.size)}</span>
								{/if}
								{#if material.sourceUrl}
									<span class="truncate" title={material.sourceUrl}>
										· {new URL(material.sourceUrl).hostname}
									</span>
								{/if}
							</p>
							{#if material.notes && (material.status === 'partial' || material.status === 'failed')}
								<p class="mt-2 line-clamp-3 text-xs text-muted-foreground" title={material.notes}>
									{material.notes}
								</p>
							{/if}
						</div>
						<Button
							variant="ghost"
							size="icon-xs"
							aria-label={`Delete ${material.name}`}
							disabled={busy === material.id}
							onclick={() => (deleting = material)}><Trash2 /></Button
						>
					</div>
					{#if canRetry(material)}
						<Button
							variant="ghost"
							size="sm"
							class="mt-2"
							disabled={busy === material.id}
							onclick={() => act(material, `/api/materials/${material.id}/retry`, { modelId })}
						>
							<RefreshCw />{material.status === 'uploading'
								? 'Continue processing'
								: 'Retry processing'}
						</Button>
					{/if}
					{#if material.kind === 'recording' && material.status === 'paused'}
						<Button
							variant="ghost"
							size="sm"
							class="mt-2"
							disabled={busy === material.id}
							onclick={() =>
								act(material, `/api/recordings/${material.id}/recover`, { finalize: true })}
						>
							<Save />Save recording
						</Button>
					{/if}
				</li>
			{/each}
		</ul>
	{/if}
</section>

<ConfirmDialog
	bind:open={
		() => deleting !== null,
		(open) => {
			if (!open) deleting = null;
		}
	}
	title={`Delete “${deleting?.name}”?`}
	description="The source, its transcript and its extracted text are removed permanently."
	onConfirm={remove}
/>
