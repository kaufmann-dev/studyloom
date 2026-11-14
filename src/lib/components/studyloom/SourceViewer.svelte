<script lang="ts">
	import { goto } from '$app/navigation';
	import { resolve } from '$app/paths';
	import type { Path } from '$app/types';
	import { onMount } from 'svelte';
	import { MediaQuery } from 'svelte/reactivity';
	import { toast } from 'svelte-sonner';
	import { Copy, Download, ExternalLink, FileSearch, RefreshCw, Trash2 } from '@lucide/svelte';
	import type { ChunkKind, MaterialDetails } from '#lib/domain.js';
	import Button from '#lib/components/ui/button/button.svelte';
	import * as Resizable from '#lib/components/ui/resizable/index.js';
	import * as Tabs from '#lib/components/ui/tabs/index.js';
	import { createPoller } from '#lib/polling.js';
	import { getProject } from '#lib/project.svelte.js';
	import { STATUS_LABELS, playingTime, processAction, sourceType } from '#lib/sources.js';
	import { api, copyText, downloadText, errorText, fileSize, plural } from '#lib/ui.js';
	import ConfirmDialog from './ConfirmDialog.svelte';
	import ErrorAlert from './ErrorAlert.svelte';
	import Markdown from './Markdown.svelte';

	/** One source: its original beside what was extracted from it. */
	let { materialId, locator = '' }: { materialId: string; locator?: string } = $props();
	const project = getProject();
	const PENDING = ['uploading', 'processing', 'recording', 'paused'];
	const KIND_FILTERS: { value: ChunkKind | 'all'; label: string }[] = [
		{ value: 'all', label: 'All' },
		{ value: 'text', label: 'Text' },
		{ value: 'exercise', label: 'Exercises' },
		{ value: 'solution', label: 'Solutions' }
	];
	const wide = new MediaQuery('min-width: 1024px');
	let data = $state.raw<MaterialDetails | null>(null);
	let error = $state('');
	let busy = $state(false);
	let confirmingDelete = $state(false);
	let tab = $state('');
	/** Which kind of extracted text is listed. */
	let kind = $state<ChunkKind | 'all'>('all');
	/** The PDF page the original shows; 0 leaves the viewer where it is. */
	let pdfPage = $state(0);
	let media: HTMLMediaElement | undefined;
	let fileHref = $derived(`/api/materials/${materialId}/file`);
	let material = $derived(data?.material);
	/** The same source as the project lists it, which knows how much was extracted. */
	let listed = $derived(project.materials.find((item) => item.id === materialId));
	let action = $derived(listed ? processAction(listed) : '');
	let hasKinds = $derived(data?.chunks.some((chunk) => chunk.kind !== 'text') ?? false);
	// A cited passage is always listed, whatever the filter says.
	let shown = $derived(
		data?.chunks.filter(
			(chunk) => kind === 'all' || chunk.kind === kind || chunk.locator === locator
		) ?? []
	);
	let originalReady = $derived(
		material
			? material.kind === 'file'
				? material.status !== 'uploading'
				: material.status === 'ready' || material.status === 'partial'
			: false
	);
	let preview = $derived.by(() => {
		if (!material || !originalReady) return '';
		const type = material.mimeType;
		if (type.startsWith('audio/') || material.kind === 'recording') return 'audio';
		if (type.startsWith('video/')) return 'video';
		if (type.startsWith('image/')) return 'image';
		return type === 'application/pdf' ? 'pdf' : '';
	});
	let split = $derived(Boolean(preview) && wide.current);
	let figures = $derived(data?.assets.filter((asset) => asset.mimeType.startsWith('image/')) ?? []);
	let tabs = $derived([
		...(preview && !split ? [{ value: 'original', label: 'Original' }] : []),
		...(data?.turns.length ? [{ value: 'transcript', label: 'Transcript' }] : []),
		{ value: 'extracted', label: 'Extracted' },
		...(figures.length ? [{ value: 'figures', label: `Figures (${figures.length})` }] : [])
	]);
	// A cited passage opens on the extracted text; otherwise the first tab that exists.
	let openTab = $derived(
		tabs.some((item) => item.value === tab) ? tab : locator ? 'extracted' : tabs[0].value
	);
	const vttTime = (ms: number) => new Date(Math.max(0, ms)).toISOString().slice(11, 23);
	let captions = $derived(
		`data:text/vtt;charset=utf-8,${encodeURIComponent('WEBVTT\n\n' + (data?.turns.map((turn) => `${vttTime(turn.startMs)} --> ${vttTime(turn.endMs)}\n${turn.text}`).join('\n\n') ?? ''))}`
	);
	let transcript = $derived(
		data?.turns.length
			? data.turns
					.map(
						(turn) =>
							`[${playingTime(turn.startMs)}] ${turn.speaker ? `${turn.speaker}: ` : ''}${turn.text}`
					)
					.join('\n\n')
			: (data?.chunks.map((chunk) => `## ${chunk.locator}\n\n${chunk.text}`).join('\n\n') ?? '')
	);
	const pageOf = (chunkLocator: string) => Number(/^page:(\d+)/.exec(chunkLocator)?.[1] ?? 0);

	const poller = createPoller(async (interaction) => {
		error = '';
		try {
			data = await api<MaterialDetails>(`/api/materials/${materialId}`, { interaction });
			return PENDING.includes(data.material.status);
		} catch (cause) {
			error = errorText(cause);
			return false;
		}
	});
	function trackMedia(element: HTMLMediaElement) {
		media = element;
		return () => {
			media = undefined;
		};
	}
	function focusLocator(element: HTMLElement) {
		if (locator && element.dataset.locator === locator) element.scrollIntoView({ block: 'center' });
	}
	function showFigure(chunkLocator: string) {
		tab = 'extracted';
		void goto(
			resolve(
				`/projects/${project.projectId}/sources/${materialId}?locator=${encodeURIComponent(chunkLocator)}` as Path
			),
			{ reset: false }
		);
	}
	async function process() {
		busy = true;
		try {
			await api(`/api/materials/${materialId}/process`, {
				body: { modelId: project.processingModel }
			});
			await Promise.all([project.refresh(), poller.run()]);
		} catch (cause) {
			toast.error(errorText(cause));
		} finally {
			busy = false;
		}
	}
	async function remove() {
		await api(`/api/materials/${materialId}`, { method: 'DELETE' });
		toast.success(`Deleted “${material?.name}”.`);
		await project.refresh();
		await goto(resolve('/projects/[id]', { id: project.projectId }));
	}
	onMount(() => {
		void poller.run(true);
		return poller.stop;
	});
</script>

{#snippet original()}
	{#if preview === 'audio'}
		<audio controls class="w-full" src={fileHref} {@attach trackMedia}></audio>
	{:else if preview === 'video'}
		<video controls class="max-h-full w-full" src={fileHref} {@attach trackMedia}>
			<track kind="captions" src={captions} srclang="und" label="Transcript" default />
		</video>
	{:else if preview === 'image'}
		<img class="max-h-full w-full object-contain" src={fileHref} alt={material?.name} />
	{:else if preview === 'pdf'}
		{#key pdfPage}
			<iframe
				class="h-full min-h-[70vh] w-full border"
				src={pdfPage ? `${fileHref}#page=${pdfPage}` : fileHref}
				title={`PDF: ${material?.name}`}
			></iframe>
		{/key}
	{/if}
{/snippet}

{#snippet extracted(details: MaterialDetails)}
	{#if details.chunks.length}
		{#if hasKinds}
			<div class="mb-5 flex flex-wrap gap-1" role="group" aria-label="Show">
				{#each KIND_FILTERS as filter (filter.value)}
					<Button
						variant={kind === filter.value ? 'secondary' : 'ghost'}
						size="sm"
						aria-pressed={kind === filter.value}
						onclick={() => (kind = filter.value)}>{filter.label}</Button
					>
				{/each}
			</div>
		{/if}
		<div class="space-y-6">
			{#each shown as chunk (chunk.id)}
				{@const page = preview === 'pdf' ? pageOf(chunk.locator) : 0}
				<section
					data-locator={chunk.locator}
					{@attach focusLocator}
					class={['scroll-mt-5', locator === chunk.locator && 'border-l-2 border-primary pl-4']}
				>
					<div class="mb-2 flex items-center gap-2">
						<h3 class="text-xs font-semibold text-muted-foreground">
							{chunk.locator}{chunk.kind === 'text' ? '' : ` · ${chunk.kind}`}
						</h3>
						{#if page}
							<Button
								variant="ghost"
								size="xs"
								onclick={() => {
									pdfPage = page;
									if (!split) tab = 'original';
								}}
							>
								<FileSearch />Show page
							</Button>
						{/if}
					</div>
					{#if details.material.contentFormat === 'markdown'}
						<Markdown text={chunk.text} />
					{:else}
						<p class="text-sm leading-relaxed break-words whitespace-pre-wrap">{chunk.text}</p>
					{/if}
				</section>
			{/each}
		</div>
	{:else}
		<p class="text-sm text-muted-foreground">
			{details.material.status === 'processing'
				? 'This source is still being processed.'
				: 'No extracted text is available.'}
		</p>
	{/if}
{/snippet}

{#snippet content(details: MaterialDetails)}
	<Tabs.Root bind:value={() => openTab, (next) => (tab = next)} class="min-w-0">
		{#if tabs.length > 1}
			<Tabs.List class="mb-5">
				{#each tabs as item (item.value)}
					<Tabs.Trigger value={item.value}>{item.label}</Tabs.Trigger>
				{/each}
			</Tabs.List>
		{/if}
		{#if !split && preview}
			<Tabs.Content value="original">{@render original()}</Tabs.Content>
		{/if}
		<Tabs.Content value="transcript">
			<div class="space-y-5">
				{#each details.turns as turn (turn.id)}
					<div class="grid grid-cols-[auto_1fr] gap-3">
						<button
							class="h-fit min-h-6 font-mono text-xs text-primary underline"
							onclick={() => {
								if (media) media.currentTime = turn.startMs / 1000;
							}}
							aria-label={`Seek to ${playingTime(turn.startMs)}`}
							>{playingTime(turn.startMs)}</button
						>
						<div>
							{#if turn.speaker}<p class="mb-1 text-xs font-semibold">{turn.speaker}</p>{/if}
							<p class="text-sm leading-relaxed whitespace-pre-wrap">{turn.text}</p>
						</div>
					</div>
				{/each}
			</div>
		</Tabs.Content>
		<Tabs.Content value="extracted">{@render extracted(details)}</Tabs.Content>
		<Tabs.Content value="figures">
			<div class="grid gap-5 sm:grid-cols-2">
				{#each figures as figure (figure.id)}
					<figure class="space-y-2">
						<img
							src={`/api/assets/${figure.id}/file`}
							alt={figure.label || figure.locator}
							loading="lazy"
							class="max-h-80 w-full border bg-white object-contain"
						/>
						<figcaption class="text-xs text-muted-foreground">
							{figure.label || 'Figure'} ·
							<button
								type="button"
								class="underline underline-offset-4"
								onclick={() => showFigure(figure.locator)}>{figure.locator}</button
							>
						</figcaption>
					</figure>
				{/each}
			</div>
		</Tabs.Content>
	</Tabs.Root>
{/snippet}

<ErrorAlert message={error} onRetry={() => poller.run(true)} />
{#if !data || !material}
	{#if !error}<p role="status" class="text-sm text-muted-foreground">Loading source…</p>{/if}
{:else}
	<article class="min-w-0 space-y-5" aria-label="Source">
		<div>
			<h2 class="text-xl font-semibold break-words">{material.name}</h2>
			<p class="mt-1 text-xs text-muted-foreground">
				{[
					sourceType(material),
					STATUS_LABELS[material.status],
					...(material.size ? [fileSize(material.size)] : []),
					...(material.durationMs ? [playingTime(material.durationMs)] : []),
					...(data.chunks.length ? [plural(data.chunks.length, 'section')] : [])
				].join(' · ')}
			</p>
		</div>
		{#if material.notes}
			<p class="border-l-2 border-primary pl-3 text-sm text-muted-foreground">{material.notes}</p>
		{/if}
		<div class="flex flex-wrap gap-2">
			{#if material.sourceUrl}
				<Button
					variant="outline"
					size="sm"
					href={material.sourceUrl}
					target="_blank"
					rel="noopener noreferrer"><ExternalLink />Open page</Button
				>
			{/if}
			{#if originalReady}
				<Button variant="outline" size="sm" href={`${fileHref}?download=1`}>
					<Download />Original
				</Button>
			{/if}
			{#if transcript}
				<Button variant="ghost" size="sm" onclick={() => copyText(transcript)}>
					<Copy />Copy text
				</Button>
				<Button
					variant="ghost"
					size="sm"
					onclick={() => downloadText(`${material.name}.md`, transcript)}
				>
					<Download />Text
				</Button>
			{/if}
			{#if action}
				<Button variant="ghost" size="sm" disabled={busy} onclick={process}>
					<RefreshCw />{action}
				</Button>
			{/if}
			<Button variant="ghost" size="sm" onclick={() => (confirmingDelete = true)}>
				<Trash2 />Delete
			</Button>
		</div>
		{#if split}
			<Resizable.PaneGroup direction="horizontal" class="h-[78vh] border">
				<Resizable.Pane defaultSize={50} minSize={25} class="p-4">
					<div class="h-full overflow-y-auto">{@render original()}</div>
				</Resizable.Pane>
				<Resizable.Handle withHandle />
				<Resizable.Pane defaultSize={50} minSize={25}>
					<div class="h-full overflow-y-auto p-5">{@render content(data)}</div>
				</Resizable.Pane>
			</Resizable.PaneGroup>
		{:else}
			{@render content(data)}
		{/if}
	</article>
	<ConfirmDialog
		bind:open={confirmingDelete}
		title={`Delete “${material.name}”?`}
		description="The source, its transcript and its extracted text are removed permanently."
		onConfirm={remove}
	/>
{/if}
