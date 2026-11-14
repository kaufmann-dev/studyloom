<script lang="ts">
	import { beforeNavigate, goto } from '$app/navigation';
	import { resolve } from '$app/paths';
	import { page } from '$app/state';
	import { onMount, untrack, type Snippet } from 'svelte';
	import {
		ArrowLeft,
		CalendarDays,
		Files,
		GraduationCap,
		MessageSquare,
		UserRound
	} from '@lucide/svelte';
	import Button from '#lib/components/ui/button/button.svelte';
	import { Pins } from '#lib/pins.svelte.js';
	import { ProjectState, setProject } from '#lib/project.svelte.js';
	import ErrorAlert from './ErrorAlert.svelte';
	import JobActivity from './JobActivity.svelte';
	import PinButton from './PinButton.svelte';
	import ProjectSettings from './ProjectSettings.svelte';

	/** The frame of every page of one project: its header, its sections and its running jobs. */
	let { projectId, children }: { projectId: string; children: Snippet } = $props();
	// The layout keys this component by project, so the id never changes during its life.
	const project = setProject(new ProjectState(untrack(() => projectId)));
	const pins = new Pins();
	let data = $derived(project.data);
	let path = $derived(page.url.pathname);
	const base = resolve('/projects/[id]', { id: project.projectId });
	const study = resolve('/projects/[id]/study', { id: project.projectId });
	const sections = $derived([
		{
			href: base,
			label: 'Sources',
			icon: Files,
			current: path === base || path.startsWith(`${base}/sources/`)
		},
		{
			href: study,
			label: 'Study',
			icon: GraduationCap,
			current: path.startsWith(study) || path.startsWith(`${base}/outputs/`)
		},
		{
			href: resolve('/projects/[id]/chat', { id: project.projectId }),
			label: 'Chat',
			icon: MessageSquare,
			current: path.startsWith(`${base}/chat`)
		},
		{
			href: resolve('/projects/[id]/schedule', { id: project.projectId }),
			label: 'Schedule',
			icon: CalendarDays,
			current: path.startsWith(`${base}/schedule`)
		}
	]);

	let recording = $derived(project.recorder.needsAttention);

	// A recording keeps running between this project's pages, but not beyond them.
	beforeNavigate((navigation) => {
		if (navigation.shallow || !project.recorder.needsAttention) return;
		const target = navigation.to?.url.pathname;
		if (target && (target === base || target.startsWith(`${base}/`))) return;
		navigation.cancel();
		if (!navigation.willUnload) project.leaveWarning = true;
	});

	onMount(() => {
		void pins.load().catch(() => {});
		return project.start();
	});
</script>

<svelte:head><title>{data?.project.name ?? 'Project'} · Studyloom</title></svelte:head>
<div class="mb-6">
	<a
		href={resolve('projects')}
		class="inline-flex items-center gap-1 text-sm text-muted-foreground hover:underline"
		><ArrowLeft class="size-4" />Projects</a
	>
</div>
<ErrorAlert message={project.error} onRetry={() => project.refresh(true)} class="mb-5" />
{#if !data}
	{#if !project.error}
		<p role="status" class="py-12 text-muted-foreground">Loading project…</p>
	{/if}
{:else}
	<div class="mb-6 flex flex-wrap items-start justify-between gap-4">
		<div class="min-w-0">
			<h1 class="text-3xl font-semibold tracking-tight break-words">{data.project.name}</h1>
			{#if data.project.lecturers.length}
				<p class="mt-2 flex flex-wrap items-center gap-x-1.5 text-sm text-muted-foreground">
					<UserRound class="size-3.5 shrink-0" aria-hidden="true" />
					<span class="sr-only">Lecturers:</span>
					{#each data.project.lecturers as lecturer, index (lecturer.id)}
						<a
							href={resolve('/library/[id]', { id: lecturer.id })}
							class="underline-offset-4 hover:text-foreground hover:underline">{lecturer.name}</a
						>{index < data.project.lecturers.length - 1 ? ',' : ''}
					{/each}
				</p>
			{/if}
			{#if data.project.description}
				<p class="mt-2 max-w-3xl text-sm leading-relaxed whitespace-pre-wrap text-muted-foreground">
					{data.project.description}
				</p>
			{/if}
		</div>
		<div class="flex items-center gap-2">
			<PinButton
				{pins}
				targetType="project"
				targetId={project.projectId}
				name={data.project.name}
			/>
			<ProjectSettings
				project={data.project}
				onSaved={project.refresh}
				onDeleted={() => goto(resolve('projects'))}
			/>
		</div>
	</div>
	{#if project.claudeNotice}
		<div
			class="mb-6 flex flex-wrap items-center justify-between gap-3 border-l-2 border-primary bg-muted px-4 py-3 text-sm"
		>
			<p>{project.claudeNotice}</p>
			<Button href={resolve('settings')} variant="outline" size="sm">Claude settings</Button>
		</div>
	{/if}
	<nav aria-label="Project sections" class="mb-7 flex gap-1 overflow-x-auto border-b pb-2">
		{#each sections as section (section.href)}
			<Button
				href={section.href}
				variant="ghost"
				class="shrink-0 aria-[current=page]:bg-muted"
				aria-current={section.current ? 'page' : undefined}
			>
				<section.icon />{section.label}
				{#if section.label === 'Sources'}
					<span class="font-normal text-muted-foreground">{data.materials.length}</span>
				{/if}
			</Button>
		{/each}
	</nav>
	{#if recording && path !== base}
		<div
			class="mb-7 flex flex-wrap items-center justify-between gap-3 border-l-2 border-primary bg-muted px-4 py-3 text-sm"
		>
			<p role={project.leaveWarning ? 'alert' : undefined}>
				{project.leaveWarning
					? 'Stop and save the recording before leaving this project.'
					: 'A recording is in progress.'}
				<span class="font-mono tabular-nums">{project.recorder.duration}</span>
			</p>
			<Button href={base} variant="outline" size="sm">Open recorder</Button>
		</div>
	{/if}
	<JobActivity jobs={data.jobs} onChanged={project.refresh} class="mb-7" />
	{@render children()}
{/if}
