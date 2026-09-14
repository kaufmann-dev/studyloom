<script lang="ts">
	import { resolve } from '$app/paths';
	import type { Pathname } from '$app/types';
	import { onMount } from 'svelte';
	import { defaults, superForm } from 'sveltekit-superforms';
	import { zod4, zod4Client } from 'sveltekit-superforms/adapters';
	import * as Form from '$lib/components/ui/form';
	import { generationInput, DEFAULT_MODEL } from '$lib/domain';
	import { page } from '$app/state';
	import { goto } from '$app/navigation';
	import {
		ArrowLeft,
		Trash2,
		RefreshCw,
		MessageSquare,
		NotebookText,
		ListChecks
	} from '@lucide/svelte';
	import type {
		Project,
		Material,
		Conversation,
		StudyOutput,
		Job,
		MuseModel,
		MuseAccount
	} from '$lib/domain';
	import Button from '$lib/components/ui/button/button.svelte';
	import * as Tabs from '$lib/components/ui/tabs';
	import Recorder from '$lib/components/Recorder.svelte';
	import Upload from './Upload.svelte';
	import ProjectDetails from './ProjectDetails.svelte';
	import SourceViewer from './SourceViewer.svelte';
	import Chat from './Chat.svelte';
	import StudyTools from './StudyTools.svelte';
	import { api, errorText } from '$lib/ui';
	let { projectId }: { projectId: string } = $props();
	const ingestionSchema = generationInput.pick({ modelId: true });
	const ingestionForm = superForm(defaults({ modelId: DEFAULT_MODEL }, zod4(ingestionSchema)), {
		validators: zod4Client(ingestionSchema),
		SPA: true
	});
	const { form: ingestionData } = ingestionForm;
	let busyJob = $state('');
	type WorkspaceData = {
		project: Project;
		materials: Material[];
		conversations: Conversation[];
		outputs: StudyOutput[];
		jobs: Job[];
	};
	let data = $state.raw<WorkspaceData | null>(null);
	let models = $state.raw<MuseModel[]>([]);
	let museError = $state('');
	let error = $state('');
	let busyMaterial = $state('');
	let deleteId = $state('');
	let selected = $state<string[]>([]);
	let selectedTab = $state('chat');
	let timer: ReturnType<typeof setTimeout> | undefined;
	let mounted = false;
	let requestVersion = 0;
	let previousReady = new Set<string>();
	let materialId = $derived(page.url.searchParams.get('material') ?? '');
	let locator = $derived(page.url.searchParams.get('locator') ?? '');
	let ready = $derived(
		data?.materials.filter(
			(material) => material.status === 'ready' || material.status === 'partial'
		) ?? []
	);
	let activeJobs = $derived(
		data?.jobs.filter((job) => job.status === 'queued' || job.status === 'running') ?? []
	);
	let failedJobs = $derived(
		data?.jobs
			.filter((job) => job.status === 'failed' || job.status === 'cancelled')
			.slice(0, 10) ?? []
	);
	async function refresh(interaction = false) {
		const version = ++requestVersion;
		try {
			const result = await api<WorkspaceData>(
				`/api/projects/${projectId}`,
				undefined,
				'GET',
				interaction
			);
			if (!mounted || version !== requestVersion) return;
			data = result;
			error = '';
			const available = result.materials
				.filter((material) => material.status === 'ready' || material.status === 'partial')
				.map((material) => material.id);
			selected = [
				...selected.filter((id) => available.includes(id)),
				...available.filter((id) => !previousReady.has(id) && !selected.includes(id))
			];
			previousReady = new Set(available);
			clearTimeout(timer);
			if (
				result.jobs.some((job) => job.status === 'queued' || job.status === 'running') ||
				result.materials.some((material) =>
					['uploading', 'processing', 'recording', 'paused'].includes(material.status)
				)
			)
				timer = setTimeout(refresh, 3000);
		} catch (e) {
			if (mounted) error = errorText(e);
		}
	}
	async function loadModels() {
		try {
			const result = await api<{ account: MuseAccount; models: MuseModel[]; error?: string }>(
				'/api/muse'
			);
			models = result.models;
			museError =
				result.error ??
				(result.account.state === 'accountLogin'
					? ''
					: 'Connect your Muse subscription in Settings to use AI tools.');
		} catch (e) {
			museError = errorText(e);
		}
	}
	function toggleSource(id: string, checked: boolean) {
		selected = checked ? [...new Set([...selected, id])] : selected.filter((value) => value !== id);
	}
	async function removeMaterial(id: string) {
		busyMaterial = id;
		try {
			await api(`/api/materials/${id}`, undefined, 'DELETE');
			deleteId = '';
			if (materialId === id)
				await goto(resolve('/projects/[id]', { id: projectId }), { noScroll: true });
			await refresh();
		} catch (e) {
			error = errorText(e);
		} finally {
			busyMaterial = '';
		}
	}
	async function retryMaterial(id: string) {
		busyMaterial = id;
		try {
			await api(`/api/materials/${id}/retry`, { modelId: $ingestionData.modelId });
			await refresh();
		} catch (e) {
			error = errorText(e);
		} finally {
			busyMaterial = '';
		}
	}
	async function cancelJob(id: string) {
		try {
			await api(`/api/jobs/${id}/cancel`, {});
			await refresh();
		} catch (e) {
			error = errorText(e);
		}
	}
	async function retryJob(id: string) {
		busyJob = id;
		try {
			await api(`/api/jobs/${id}/retry`, {});
			await refresh();
		} catch (e) {
			error = errorText(e);
		} finally {
			busyJob = '';
		}
	}
	onMount(() => {
		mounted = true;
		void refresh(true);
		void loadModels();
		return () => {
			mounted = false;
			clearTimeout(timer);
		};
	});
</script>

<svelte:head><title>{data?.project.name ?? 'Project'} · Studyloom</title></svelte:head>
<div class="mb-6">
	<a
		href={resolve('/')}
		class="inline-flex items-center gap-1 text-sm text-muted-foreground hover:underline"
		><ArrowLeft class="size-4" />Projects</a
	>
</div>
{#if error}<div
		role="alert"
		class="mb-5 flex flex-wrap items-center gap-3 border border-destructive/30 p-4 text-sm text-destructive"
	>
		{error}<Button variant="ghost" size="sm" onclick={() => refresh(true)}>Retry</Button>
	</div>{/if}
{#if !data}<p role="status" class="py-12 text-muted-foreground">
		{error ? 'The project could not be loaded.' : 'Loading project…'}
	</p>
{:else}
	<div class="mb-8">
		<h1 class="text-3xl font-semibold tracking-tight break-words">{data.project.name}</h1>
		{#if data.project.description}<p
				class="mt-2 max-w-3xl text-sm leading-relaxed whitespace-pre-wrap text-muted-foreground"
			>
				{data.project.description}
			</p>{/if}<ProjectDetails
			project={data.project}
			onSaved={refresh}
			onDeleted={() => goto(resolve('/'))}
		/>
	</div>
	{#if museError}<div
			class="mb-6 flex flex-wrap items-center justify-between gap-3 border-l-2 border-primary bg-muted px-4 py-3 text-sm"
		>
			<p>{museError}</p>
			<Button href={resolve('/settings')} variant="outline" size="sm">Muse settings</Button>
		</div>{/if}
	<div class="grid items-start gap-7 lg:grid-cols-[280px_minmax(0,1fr)]">
		<aside class="min-w-0 space-y-6" aria-label="Project sources">
			<section class="border p-4">
				<h2 class="mb-4 text-sm font-semibold">Add materials</h2>
				<div class="mb-4">
					<Form.Field form={ingestionForm} name="modelId"
						><Form.Control
							>{#snippet children({ props })}<Form.Label>Processing model</Form.Label><select
									{...props}
									bind:value={$ingestionData.modelId}
									class="h-9 w-full border bg-background px-2 text-xs"
									><option value={DEFAULT_MODEL}
										>{models.find((model) => model.modelId === DEFAULT_MODEL)?.displayLabel ??
											DEFAULT_MODEL}</option
									>{#each models.filter((model) => model.modelId !== DEFAULT_MODEL) as model (model.modelId)}<option
											value={model.modelId}>{model.displayLabel}</option
										>{/each}</select
								>{/snippet}</Form.Control
						><Form.FieldErrors /></Form.Field
					>
				</div>
				<Upload {projectId} modelId={$ingestionData.modelId} onSaved={refresh} />
				<div class="mt-5 border-t pt-5">
					{#key projectId}<Recorder
							{projectId}
							onSaved={() => {
								void refresh();
							}}
						/>{/key}
				</div>
			</section>
			<section>
				<div class="mb-3 flex items-center justify-between">
					<h2 class="text-sm font-semibold">
						Sources <span class="font-normal text-muted-foreground">({data.materials.length})</span>
					</h2>
					<Button
						variant="ghost"
						size="icon-sm"
						aria-label="Refresh sources"
						onclick={() => refresh(true)}><RefreshCw /></Button
					>
				</div>
				{#if ready.length}<div class="mb-3 flex items-center gap-3 text-xs">
						<button
							class="min-h-6 underline underline-offset-4"
							onclick={() => (selected = ready.map((material) => material.id))}>Select all</button
						><button class="min-h-6 underline underline-offset-4" onclick={() => (selected = [])}
							>Clear</button
						><span class="ml-auto text-muted-foreground">{selected.length} selected</span>
					</div>{/if}
				{#if !data.materials.length}<p
						class="border border-dashed p-4 text-sm leading-relaxed text-muted-foreground"
					>
						Add a file or record audio to give this project its first source.
					</p>{:else}<ul class="divide-y border">
						{#each data.materials as material (material.id)}<li class="p-3">
								<div class="flex items-start gap-2">
									<input
										type="checkbox"
										aria-label={`Use ${material.name} as a source`}
										checked={selected.includes(material.id)}
										disabled={material.status !== 'ready' && material.status !== 'partial'}
										onchange={(event) => toggleSource(material.id, event.currentTarget.checked)}
										class="mt-1 size-4 shrink-0 accent-primary"
									/>
									<div class="min-w-0 flex-1">
										<a
											href={resolve(`/projects/${projectId}?material=${material.id}` as Pathname)}
											class="block truncate text-sm font-medium hover:underline"
											title={material.name}>{material.name}</a
										>
										<p class="mt-1 text-xs text-muted-foreground">
											{material.status.replaceAll('_', ' ')}{material.size
												? ` · ${(material.size / 1024 / 1024).toFixed(1)} MB`
												: ''}
										</p>
										{#if material.notes && (material.status === 'partial' || material.status === 'failed')}<p
												class="mt-2 line-clamp-3 text-xs text-muted-foreground"
											>
												{material.notes}
											</p>{/if}
									</div>
									<Button
										variant="ghost"
										size="icon-xs"
										aria-label={`Delete ${material.name}`}
										disabled={busyMaterial === material.id}
										onclick={() => (deleteId = deleteId === material.id ? '' : material.id)}
										><Trash2 /></Button
									>
								</div>
								{#if material.status === 'failed' || material.status === 'partial'}<Button
										variant="ghost"
										size="sm"
										class="mt-2"
										disabled={busyMaterial === material.id}
										onclick={() => retryMaterial(material.id)}><RefreshCw />Retry processing</Button
									>{/if}
								{#if deleteId === material.id}<div class="mt-3 bg-muted p-3 text-xs">
										<p>Delete this source permanently?</p>
										<div class="mt-2 flex gap-2">
											<Button
												variant="destructive"
												size="sm"
												disabled={busyMaterial === material.id}
												onclick={() => removeMaterial(material.id)}>Delete</Button
											><Button variant="ghost" size="sm" onclick={() => (deleteId = '')}
												>Keep</Button
											>
										</div>
									</div>{/if}
							</li>{/each}
					</ul>{/if}
			</section>
			{#if activeJobs.length}<section aria-label="Background work" class="space-y-3">
					<h2 class="text-sm font-semibold">In progress</h2>
					{#each activeJobs as job (job.id)}<div class="border p-3">
							<p class="text-xs font-medium">{job.kind.replaceAll('_', ' ')} · {job.status}</p>
							<p class="mt-1 text-xs break-words text-muted-foreground">
								{job.progress || 'Waiting for processing…'}
							</p>
							<Button variant="ghost" size="sm" class="mt-2" onclick={() => cancelJob(job.id)}
								>Cancel</Button
							>
						</div>{/each}
				</section>{/if}
			{#if failedJobs.length}<details>
					<summary class="cursor-pointer text-xs text-muted-foreground"
						>Interrupted jobs ({failedJobs.length})</summary
					>
					<div class="mt-2 space-y-2">
						{#each failedJobs as job (job.id)}<p
								class="border p-3 text-xs break-words text-destructive"
							>
								{job.kind.replaceAll('_', ' ')}: {job.error || job.status}
								<Button
									variant="ghost"
									size="sm"
									disabled={busyJob === job.id}
									onclick={() => retryJob(job.id)}>Retry</Button
								>
							</p>{/each}
					</div>
				</details>{/if}
		</aside>
		<div class="min-w-0">
			{#if materialId}<div class="mb-7">
					{#key `${materialId}:${locator}`}<SourceViewer
							{materialId}
							{locator}
							onClose={() => {
								void goto(resolve('/projects/[id]', { id: projectId }), { noScroll: true });
							}}
						/>{/key}
				</div>{/if}
			<Tabs.Root bind:value={selectedTab}
				><Tabs.List class="mb-7 flex h-auto w-full justify-start gap-1 bg-muted p-1"
					><Tabs.Trigger value="chat" class="flex-1 gap-2"
						><MessageSquare class="size-4" />Chat</Tabs.Trigger
					><Tabs.Trigger value="summaries" class="flex-1 gap-2"
						><NotebookText class="size-4" />Summaries</Tabs.Trigger
					><Tabs.Trigger value="quizzes" class="flex-1 gap-2"
						><ListChecks class="size-4" />Quizzes</Tabs.Trigger
					></Tabs.List
				><Tabs.Content value="chat"
					><Chat
						{projectId}
						materialIds={selected}
						materials={data.materials}
						{models}
						conversations={data.conversations}
						jobs={data.jobs}
						onChanged={refresh}
					/></Tabs.Content
				><Tabs.Content value="summaries"
					><StudyTools
						{projectId}
						kind="summary"
						materialIds={selected}
						materials={data.materials}
						{models}
						outputs={data.outputs}
						onChanged={refresh}
					/></Tabs.Content
				><Tabs.Content value="quizzes"
					><StudyTools
						{projectId}
						kind="quiz"
						materialIds={selected}
						materials={data.materials}
						{models}
						outputs={data.outputs}
						onChanged={refresh}
					/></Tabs.Content
				></Tabs.Root
			>
		</div>
	</div>
{/if}
