<script lang="ts">
	import { goto } from '$app/navigation';
	import { resolve } from '$app/paths';
	import { page } from '$app/state';
	import { onMount } from 'svelte';
	import { ArrowLeft, ListChecks, MessageSquare, NotebookText } from '@lucide/svelte';
	import {
		DEFAULT_MODEL,
		isActiveJob,
		type Material,
		type MuseModel,
		type MuseStatus,
		type ProjectWorkspace
	} from '$lib/domain';
	import Button from '$lib/components/ui/button/button.svelte';
	import { Label } from '$lib/components/ui/label';
	import * as Tabs from '$lib/components/ui/tabs';
	import Recorder from '$lib/components/Recorder.svelte';
	import { Pins } from '$lib/pins.svelte';
	import { createPoller } from '$lib/polling';
	import { api, errorText } from '$lib/ui';
	import Chat from './Chat.svelte';
	import ErrorAlert from './ErrorAlert.svelte';
	import JobActivity from './JobActivity.svelte';
	import ModelSelect, { availableModel } from './ModelSelect.svelte';
	import PinButton from './PinButton.svelte';
	import ProjectSettings from './ProjectSettings.svelte';
	import SourceList from './SourceList.svelte';
	import SourceViewer from './SourceViewer.svelte';
	import StudyTools from './StudyTools.svelte';
	import Upload from './Upload.svelte';

	let { projectId }: { projectId: string } = $props();
	const uid = $props.id();
	const pins = new Pins();
	let data = $state.raw<ProjectWorkspace | null>(null);
	let models = $state.raw<MuseModel[]>([]);
	let museNotice = $state('');
	let error = $state('');
	let selected = $state<string[]>([]);
	let selectedTab = $state('chat');
	let preferredModel = $state(DEFAULT_MODEL);
	let requestVersion = 0;
	// Sources that became readable since the last refresh are selected automatically.
	let knownReadable = new Set<string>();

	let materialId = $derived(page.url.searchParams.get('material') ?? '');
	let locator = $derived(page.url.searchParams.get('locator') ?? '');
	let processingModel = $derived(availableModel(models, preferredModel));
	let readable = $derived(data ? readableIds(data) : []);

	function readableIds({ materials, readableMaterialIds }: ProjectWorkspace) {
		return materials
			.filter(
				(material) =>
					(material.status === 'ready' || material.status === 'partial') &&
					readableMaterialIds.includes(material.id)
			)
			.map((material) => material.id);
	}
	const isWorking = (material: Material) =>
		material.status === 'processing' || material.status === 'recording';

	const poller = createPoller(async (interaction) => {
		const version = ++requestVersion;
		try {
			const result = await api<ProjectWorkspace>(`/api/projects/${projectId}`, { interaction });
			if (version !== requestVersion) return false;
			data = result;
			error = '';
			const available = readableIds(result);
			selected = [
				...selected.filter((id) => available.includes(id)),
				...available.filter((id) => !knownReadable.has(id) && !selected.includes(id))
			];
			knownReadable = new Set(available);
			return result.jobs.some(isActiveJob) || result.materials.some(isWorking);
		} catch (cause) {
			error = errorText(cause);
			return false;
		}
	});
	const refresh = (interaction = false) => poller.run(interaction);

	async function loadModels() {
		try {
			const status = await api<MuseStatus>('/api/muse');
			models = status.models;
			museNotice =
				status.error ??
				(status.account.state === 'accountLogin'
					? ''
					: 'Connect your Muse subscription in Settings to use AI tools.');
		} catch (cause) {
			museNotice = errorText(cause);
		}
	}
	async function closeViewer() {
		await goto(resolve('/projects/[id]', { id: projectId }), { noScroll: true });
	}
	async function sourceDeleted(id: string) {
		if (materialId === id) await closeViewer();
		await refresh();
	}

	onMount(() => {
		void refresh(true);
		void loadModels();
		void pins.load().catch(() => {});
		return poller.stop;
	});
</script>

<svelte:head><title>{data?.project.name ?? 'Project'} · Studyloom</title></svelte:head>
<div class="mb-6">
	<a
		href={resolve('/projects')}
		class="inline-flex items-center gap-1 text-sm text-muted-foreground hover:underline"
		><ArrowLeft class="size-4" />Projects</a
	>
</div>
<ErrorAlert message={error} onRetry={() => refresh(true)} class="mb-5" />
{#if !data}
	{#if !error}<p role="status" class="py-12 text-muted-foreground">Loading project…</p>{/if}
{:else}
	<div class="mb-8 flex flex-wrap items-start justify-between gap-4">
		<div class="min-w-0">
			<h1 class="text-3xl font-semibold tracking-tight break-words">{data.project.name}</h1>
			{#if data.project.description}
				<p class="mt-2 max-w-3xl text-sm leading-relaxed whitespace-pre-wrap text-muted-foreground">
					{data.project.description}
				</p>
			{/if}
		</div>
		<div class="flex items-center gap-2">
			<PinButton {pins} targetType="project" targetId={projectId} name={data.project.name} />
			{#key data.project.id}
				<ProjectSettings
					project={data.project}
					onSaved={refresh}
					onDeleted={() => goto(resolve('/projects'))}
				/>
			{/key}
		</div>
	</div>
	{#if museNotice}
		<div
			class="mb-6 flex flex-wrap items-center justify-between gap-3 border-l-2 border-primary bg-muted px-4 py-3 text-sm"
		>
			<p>{museNotice}</p>
			<Button href={resolve('/settings')} variant="outline" size="sm">Muse settings</Button>
		</div>
	{/if}
	<div class="grid items-start gap-7 lg:grid-cols-[300px_minmax(0,1fr)]">
		<aside class="min-w-0 space-y-6" aria-label="Project sources">
			<section class="space-y-4 border p-4" aria-labelledby="{uid}-add">
				<h2 id="{uid}-add" class="text-sm font-semibold">Add materials</h2>
				<div class="space-y-2">
					<Label for="{uid}-model">Processing model</Label>
					<ModelSelect id="{uid}-model" {models} bind:value={preferredModel} />
				</div>
				<Upload {projectId} modelId={processingModel} onSaved={refresh} />
				<div class="border-t pt-4">
					<Recorder {projectId} onSaved={() => void refresh()} />
				</div>
			</section>
			<SourceList
				{projectId}
				materials={data.materials}
				selectable={readable}
				bind:selected
				modelId={processingModel}
				onRefresh={refresh}
				onDeleted={sourceDeleted}
			/>
			<JobActivity jobs={data.jobs} onChanged={refresh} />
		</aside>
		<div class="min-w-0">
			{#if materialId}
				<div class="mb-7">
					{#key `${materialId}:${locator}`}
						<SourceViewer {materialId} {locator} onClose={closeViewer} />
					{/key}
				</div>
			{/if}
			<Tabs.Root bind:value={selectedTab}>
				<Tabs.List class="mb-7 flex h-auto w-full justify-start gap-1 bg-muted p-1">
					<Tabs.Trigger value="chat" class="flex-1 gap-2">
						<MessageSquare class="size-4" />Chat
					</Tabs.Trigger>
					<Tabs.Trigger value="summaries" class="flex-1 gap-2">
						<NotebookText class="size-4" />Summaries
					</Tabs.Trigger>
					<Tabs.Trigger value="quizzes" class="flex-1 gap-2">
						<ListChecks class="size-4" />Quizzes
					</Tabs.Trigger>
				</Tabs.List>
				<Tabs.Content value="chat">
					<Chat
						{projectId}
						materialIds={selected}
						materials={data.materials}
						{models}
						conversations={data.conversations}
						jobs={data.jobs}
						onChanged={refresh}
					/>
				</Tabs.Content>
				{#each [{ tab: 'summaries', kind: 'summary' }, { tab: 'quizzes', kind: 'quiz' }] as const as { tab, kind } (kind)}
					<Tabs.Content value={tab}>
						<StudyTools
							{projectId}
							{kind}
							materialIds={selected}
							materials={data.materials}
							{models}
							outputs={data.outputs}
							onChanged={refresh}
						/>
					</Tabs.Content>
				{/each}
			</Tabs.Root>
		</div>
	</div>
{/if}
