<script lang="ts">
	import { goto } from '$app/navigation';
	import { resolve } from '$app/paths';
	import { page } from '$app/state';
	import { onMount } from 'svelte';
	import { defaults, superForm } from 'sveltekit-superforms';
	import { zod4, zod4Client } from 'sveltekit-superforms/adapters';
	import { FolderOpen, Plus, UserRound } from '@lucide/svelte';
	import { projectInput, type Project } from '#lib/domain.js';
	import Button from '#lib/components/ui/button/button.svelte';
	import * as Dialog from '#lib/components/ui/dialog/index.js';
	import * as Form from '#lib/components/ui/form/index.js';
	import Input from '#lib/components/ui/input/input.svelte';
	import * as NativeSelect from '#lib/components/ui/native-select/index.js';
	import Textarea from '#lib/components/ui/textarea/textarea.svelte';
	import ErrorAlert from '#lib/components/studyloom/ErrorAlert.svelte';
	import LecturerSelect from '#lib/components/studyloom/LecturerSelect.svelte';
	import PinButton from '#lib/components/studyloom/PinButton.svelte';
	import { Pins } from '#lib/pins.svelte.js';
	import { isProjectSort, PROJECT_SORTS, sortProjects } from '#lib/projects.js';
	import { api, dateLabel, errorText } from '#lib/ui.js';

	const pins = new Pins();
	const projectForm = superForm(defaults(zod4(projectInput)), {
		validators: zod4Client(projectInput),
		SPA: true,
		id: 'project-create'
	});
	const { form } = projectForm;
	let projects = $state.raw<Project[]>([]);
	let loading = $state(true);
	let error = $state('');
	let showCreate = $state(false);
	let creating = $state(false);
	let createError = $state('');
	const sort = $derived.by(() => {
		const value = page.url.searchParams.get('sort');
		return isProjectSort(value) ? value : 'updated';
	});
	const sorted = $derived(sortProjects(projects, sort));

	function changeSort(value: string) {
		const query = value === 'updated' ? '' : `?${new URLSearchParams({ sort: value })}`;
		// The rule cannot follow the query string appended to the resolve()-built path.
		// eslint-disable-next-line svelte/no-navigation-without-resolve
		void goto(`${resolve('/projects')}${query}`, { replace: true, reset: false });
	}

	async function loadProjects() {
		loading = true;
		error = '';
		try {
			const [list] = await Promise.all([
				api<{ projects: Project[] }>('/api/projects', { interaction: true }),
				pins.load()
			]);
			projects = list.projects;
		} catch (cause) {
			error = errorText(cause);
		} finally {
			loading = false;
		}
	}
	async function createProject(event: SubmitEvent) {
		event.preventDefault();
		if (!(await projectForm.validateForm({ update: true })).valid) return;
		creating = true;
		createError = '';
		try {
			const { project } = await api<{ project: Project }>('/api/projects', { body: $form });
			await goto(resolve('/projects/[id]', { id: project.id }));
		} catch (cause) {
			createError = errorText(cause);
		} finally {
			creating = false;
		}
	}

	onMount(() => {
		void loadProjects();
	});
</script>

<svelte:head><title>Projects · Studyloom</title></svelte:head>
<div class="mb-9 flex flex-wrap items-start justify-between gap-4">
	<div>
		<h1 class="text-3xl font-semibold tracking-tight">Projects</h1>
		<p class="mt-2 text-muted-foreground">
			Keep each course, research topic, or meeting in its own workspace.
		</p>
	</div>
	<div class="flex flex-wrap items-center gap-2">
		{#if projects.length > 1}
			<NativeSelect.Root
				aria-label="Sort projects"
				value={sort}
				onchange={(event) => changeSort(event.currentTarget.value)}
			>
				{#each Object.entries(PROJECT_SORTS) as [value, label] (value)}
					<NativeSelect.Option {value}>Sort: {label}</NativeSelect.Option>
				{/each}
			</NativeSelect.Root>
		{/if}
		<Button onclick={() => (showCreate = true)}><Plus />New project</Button>
	</div>
</div>
<ErrorAlert message={error} onRetry={loadProjects} class="mb-5" />
{#if loading}
	<p role="status" class="py-12 text-muted-foreground">Loading projects…</p>
{:else if error}
	<!-- The alert above already explains the failure. -->
{:else if projects.length === 0}
	<div class="flex flex-col items-center border border-dashed px-6 py-16 text-center">
		<FolderOpen class="mb-4 size-8 text-muted-foreground" />
		<h2 class="text-xl font-medium">Your first project starts here</h2>
		<p class="mt-2 max-w-md text-sm text-muted-foreground">
			Create a project, add materials or record audio, then turn your sources into study tools.
		</p>
		<Button class="mt-6" onclick={() => (showCreate = true)}><Plus />Create a project</Button>
	</div>
{:else}
	<ul class="grid gap-4 sm:grid-cols-2">
		{#each sorted as project (project.id)}
			<li class="relative min-w-0 border p-6 hover:bg-muted/40">
				<div class="flex items-start justify-between gap-3">
					<h2 class="min-w-0 truncate text-lg font-semibold">
						<!-- The stretched link makes the whole card a target; the pin button sits above it. -->
						<a
							href={resolve('/projects/[id]', { id: project.id })}
							class="outline-none after:absolute after:inset-0 focus-visible:after:ring-2 focus-visible:after:ring-ring focus-visible:after:ring-inset"
							>{project.name}</a
						>
					</h2>
					<div class="relative -mt-1.5 -mr-2 shrink-0">
						<PinButton {pins} targetType="project" targetId={project.id} name={project.name} />
					</div>
				</div>
				<p
					class={[
						'mt-2 line-clamp-2 text-sm text-muted-foreground',
						!project.description && 'opacity-60'
					]}
				>
					{project.description || 'No description'}
				</p>
				<p
					class={[
						'mt-1 flex items-center gap-1.5 text-sm text-muted-foreground',
						!project.lecturers.length && 'opacity-60'
					]}
				>
					<UserRound class="size-3.5 shrink-0" aria-hidden="true" />
					<span class="sr-only">Lecturers:</span>
					<span class="truncate">
						{project.lecturers.map((lecturer) => lecturer.name).join(', ') || 'No lecturers'}
					</span>
				</p>
				<p class="mt-6 text-xs text-muted-foreground">Updated {dateLabel(project.updatedAt)}</p>
			</li>
		{/each}
	</ul>
{/if}

<Dialog.Root bind:open={showCreate}>
	<Dialog.Content class="sm:max-w-lg">
		<Dialog.Header>
			<Dialog.Title>New project</Dialog.Title>
			<Dialog.Description
				>Give the course, topic or meeting a name you will recognise.</Dialog.Description
			>
		</Dialog.Header>
		<form onsubmit={createProject} class="space-y-4" novalidate>
			<Form.Field form={projectForm} name="name">
				<Form.Control>
					{#snippet children({ props })}
						<Form.Label>Name</Form.Label>
						<Input
							{...props}
							bind:value={$form.name}
							placeholder="e.g. Biology — autumn semester"
							autocomplete="off"
						/>
					{/snippet}
				</Form.Control>
				<Form.FieldErrors />
			</Form.Field>
			<Form.Field form={projectForm} name="description">
				<Form.Control>
					{#snippet children({ props })}
						<Form.Label>
							Description <span class="font-normal text-muted-foreground">(optional)</span>
						</Form.Label>
						<Textarea
							{...props}
							bind:value={$form.description}
							rows={2}
							placeholder="e.g. SpFB26: 17/1 - Techn III"
						/>
					{/snippet}
				</Form.Control>
				<Form.FieldErrors />
			</Form.Field>
			<Form.Field form={projectForm} name="lecturerIds">
				<Form.Control>
					{#snippet children({ props })}
						<Form.Label>
							Lecturers <span class="font-normal text-muted-foreground">(optional)</span>
						</Form.Label>
						<LecturerSelect {...props} bind:value={$form.lecturerIds} />
					{/snippet}
				</Form.Control>
				<Form.FieldErrors />
			</Form.Field>
			{#if createError}<p role="alert" class="text-sm text-destructive">{createError}</p>{/if}
			<Dialog.Footer>
				<Button variant="ghost" onclick={() => (showCreate = false)}>Cancel</Button>
				<Button type="submit" disabled={creating}>
					{creating ? 'Creating…' : 'Create project'}
				</Button>
			</Dialog.Footer>
		</form>
	</Dialog.Content>
</Dialog.Root>
