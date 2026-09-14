<script lang="ts">
	import { resolve } from '$app/paths';
	import type { Pathname } from '$app/types';
	import { onMount } from 'svelte';
	import { Download, Copy, X } from '@lucide/svelte';
	import type { Material, SourceChunk, TranscriptTurn, Asset } from '$lib/domain';
	import Button from '$lib/components/ui/button/button.svelte';
	import { api, errorText, downloadText } from '$lib/ui';
	let {
		materialId,
		locator = '',
		onClose
	}: { materialId: string; locator?: string; onClose: () => void } = $props();
	let data = $state.raw<{
		material: Material;
		chunks: SourceChunk[];
		turns: TranscriptTurn[];
		assets: Asset[];
	} | null>(null);
	let error = $state('');
	let notice = $state('');
	let media: HTMLMediaElement | undefined;
	let mounted = false;
	let timer: ReturnType<typeof setTimeout> | undefined;
	const vttTime = (ms: number) => new Date(Math.max(0, ms)).toISOString().slice(11, 23);
	let captions = $derived(
		`data:text/vtt;charset=utf-8,${encodeURIComponent('WEBVTT\n\n' + (data?.turns.map((turn) => `${vttTime(turn.startMs)} --> ${vttTime(turn.endMs)}\n${turn.text}`).join('\n\n') ?? ''))}`
	);
	const timestamp = (ms: number) =>
		`${Math.floor(ms / 60000)}:${Math.floor((ms / 1000) % 60)
			.toString()
			.padStart(2, '0')}`;
	let transcript = $derived(
		data?.turns.length
			? data.turns
					.map(
						(turn) =>
							`[${timestamp(turn.startMs)}] ${turn.speaker ? `${turn.speaker}: ` : ''}${turn.text}`
					)
					.join('\n\n')
			: (data?.chunks.map((chunk) => `## ${chunk.locator}\n\n${chunk.text}`).join('\n\n') ?? '')
	);
	async function load(interaction = false) {
		error = '';
		try {
			const result = await api<{
				material: Material;
				chunks: SourceChunk[];
				turns: TranscriptTurn[];
				assets: Asset[];
			}>(`/api/materials/${materialId}`, undefined, 'GET', interaction);
			if (!mounted) return;
			data = result;
			clearTimeout(timer);
			if (['uploading', 'processing', 'recording', 'paused'].includes(result.material.status))
				timer = setTimeout(load, 3000);
		} catch (e) {
			if (mounted) error = errorText(e);
		}
	}
	async function copy() {
		try {
			await navigator.clipboard.writeText(transcript);
			notice = 'Copied.';
		} catch (e) {
			error = errorText(e);
		}
	}
	function focusLocator(element: HTMLElement) {
		if (locator && element.dataset.locator === locator) element.scrollIntoView({ block: 'center' });
	}
	onMount(() => {
		mounted = true;
		void load(true);
		return () => {
			mounted = false;
			clearTimeout(timer);
		};
	});
</script>

<section class="min-w-0 border bg-background" aria-label="Source viewer">
	<div class="flex items-start justify-between gap-3 border-b p-5">
		<div class="min-w-0">
			<h2 class="text-lg font-semibold break-words">{data?.material.name ?? 'Source'}</h2>
			{#if data}<p class="mt-1 text-xs text-muted-foreground">
					{data.material.status} · {data.material.mimeType}
				</p>{/if}
		</div>
		<Button variant="ghost" size="icon" aria-label="Close source viewer" onclick={onClose}
			><X /></Button
		>
	</div>
	<div class="max-h-[75vh] space-y-5 overflow-y-auto p-5">
		{#if error}<p role="alert" class="text-sm text-destructive">{error}</p>
			<Button variant="outline" onclick={() => load(true)}>Retry</Button>
		{:else if !data}<p role="status" class="text-sm text-muted-foreground">Loading source…</p>
		{:else}
			{#if data.material.notes}<p
					class="border-l-2 border-primary pl-3 text-sm text-muted-foreground"
				>
					{data.material.notes}
				</p>{/if}
			<div class="flex flex-wrap gap-2">
				<Button variant="outline" size="sm" href={`/api/materials/${materialId}/file?download=1`}
					><Download />Original</Button
				>{#if transcript}<Button variant="ghost" size="sm" onclick={copy}><Copy />Copy text</Button
					><Button
						variant="ghost"
						size="sm"
						onclick={() => downloadText(`${data?.material.name ?? 'source'}.md`, transcript)}
						><Download />Text</Button
					>{/if}
			</div>
			{#if notice}<p role="status" class="text-xs text-muted-foreground">{notice}</p>{/if}
			{#if data.material.mimeType.startsWith('audio/') || data.material.kind === 'recording'}<audio
					controls
					class="w-full"
					src={`/api/materials/${materialId}/file`}
					{@attach (element) => {
						media = element;
						return () => {
							media = undefined;
						};
					}}
				></audio>
			{:else if data.material.mimeType.startsWith('video/')}
				<video
					controls
					class="max-h-80 w-full"
					src={`/api/materials/${materialId}/file`}
					{@attach (element) => {
						media = element;
						return () => {
							media = undefined;
						};
					}}
					><track kind="captions" src={captions} srclang="und" label="Transcript" default /></video
				>
			{:else if data.material.mimeType.startsWith('image/')}<img
					class="max-h-96 w-full object-contain"
					src={`/api/materials/${materialId}/file`}
					alt={data.material.name}
				/>
			{:else if data.material.mimeType === 'application/pdf'}<iframe
					class="h-96 w-full border"
					src={`/api/materials/${materialId}/file`}
					title={`PDF: ${data.material.name}`}
				></iframe>{/if}
			{#if data.turns.length}<div class="space-y-5" aria-label="Transcript">
					{#each data.turns as turn (turn.id)}<div class="grid grid-cols-[auto_1fr] gap-3">
							<button
								class="h-fit min-h-6 font-mono text-xs text-primary underline"
								onclick={() => {
									if (media) media.currentTime = turn.startMs / 1000;
								}}
								aria-label={`Seek to ${timestamp(turn.startMs)}`}>{timestamp(turn.startMs)}</button
							>
							<div>
								{#if turn.speaker}<p class="mb-1 text-xs font-semibold">{turn.speaker}</p>{/if}
								<p class="text-sm leading-relaxed whitespace-pre-wrap">{turn.text}</p>
							</div>
						</div>{/each}
				</div>{/if}
			{#if data.chunks.length}<div class="space-y-6">
					{#each data.chunks as chunk (chunk.id)}<section
							data-locator={chunk.locator}
							{@attach focusLocator}
							class={['scroll-mt-5', locator === chunk.locator && 'border-l-2 border-primary pl-4']}
						>
							<h3 class="mb-2 text-xs font-semibold text-muted-foreground">{chunk.locator}</h3>
							<p class="text-sm leading-relaxed break-words whitespace-pre-wrap">{chunk.text}</p>
						</section>{/each}
				</div>{:else if !data.turns.length}<p class="text-sm text-muted-foreground">
					{data.material.status === 'processing'
						? 'This material is still being processed.'
						: 'No extracted text is available.'}
				</p>{/if}
			{#if data.assets.length}<section class="space-y-3 border-t pt-5">
					<h3 class="font-medium">Images and figures</h3>
					{#each data.assets as asset (asset.id)}<figure class="space-y-2">
							{#if asset.mimeType.startsWith('image/')}<img
									src={`/api/assets/${asset.id}/file`}
									alt={asset.label || asset.locator}
									loading="lazy"
									class="max-h-80 w-full object-contain"
								/>{/if}
							<figcaption class="text-xs text-muted-foreground">
								<a href={resolve(`/api/assets/${asset.id}/file` as Pathname)} class="underline"
									>{asset.label || 'Open asset'}</a
								>
								· {asset.locator}
							</figcaption>
						</figure>{/each}
				</section>{/if}
		{/if}
	</div>
</section>
