<script lang="ts">
	import { resolve } from '$app/paths';
	import { onMount } from 'svelte';
	import { goto } from '$app/navigation';
	import { defaults, superForm } from 'sveltekit-superforms';
	import { zod4, zod4Client } from 'sveltekit-superforms/adapters';
	import { projectInput, type Project } from '$lib/domain';
	import { Plus, ArrowUpRight, FolderOpen, Pin, PinOff } from '@lucide/svelte';
	import * as Form from '$lib/components/ui/form';
	import Input from '$lib/components/ui/input/input.svelte';
	import Textarea from '$lib/components/ui/textarea/textarea.svelte';
	import Button from '$lib/components/ui/button/button.svelte';
	import { api, dateLabel, errorText } from '$lib/ui';
	import type { Pin as SavedPin } from '$lib/domain';
	let projects = $state.raw<Project[]>([]);
	let pins = $state.raw<SavedPin[]>([]);
	let pinBusy = $state<string | null>(null);
	let loading = $state(true);
	let error = $state('');
	let creating = $state(false);
	let showCreate = $state(false);
	const schema = projectInput;
	const projectForm = superForm(defaults(zod4(schema)), {
		validators: zod4Client(schema),
		SPA: true,
		id: 'project-create'
	});
	const { form } = projectForm;
	async function loadProjects() {
		loading = true;
		error = '';
		try {
			projects = (await api<{ projects: Project[] }>('/api/projects', undefined, 'GET', true))
				.projects;
			pins = (await api<{ pins: SavedPin[] }>('/api/pins', undefined, 'GET', true)).pins;
		} catch (e) {
			error = errorText(e);
		} finally {
			loading = false;
		}
	}
	async function togglePin(project: Project) {
		pinBusy = project.id;
		error = '';
		try {
			const existing = pins.find(
				(pin) => pin.targetType === 'project' && pin.targetId === project.id
			);
			if (existing) {
				await api(`/api/pins/${existing.id}`, undefined, 'DELETE');
				pins = pins.filter((pin) => pin.id !== existing.id);
			} else {
				const result = await api<{ pin: SavedPin }>('/api/pins', {
					targetType: 'project',
					targetId: project.id
				});
				pins = [result.pin, ...pins];
			}
		} catch (cause) {
			error = errorText(cause);
		} finally {
			pinBusy = null;
		}
	}
	async function createProject(event: SubmitEvent) {
		event.preventDefault();
		if (!(await projectForm.validateForm()).valid) return;
		creating = true;
		error = '';
		try {
			const result = await api<{ project: Project }>('/api/projects', $form);
			await goto(resolve('/projects/[id]', { id: result.project.id }));
		} catch (e) {
			error = errorText(e);
		} finally {
			creating = false;
		}
	}
	onMount(() => {
		void loadProjects();
	});
</script>

<svelte:head><title>Projects · Studyloom</title></svelte:head>
<div class="mx-auto max-w-5xl">
	<div class="mb-9 flex flex-wrap items-start justify-between gap-4">
		<div>
			<h1 class="text-3xl font-semibold tracking-tight">Projects</h1>
			<p class="mt-2 text-muted-foreground">
				Keep each course, research topic, or meeting in its own workspace.
			</p>
		</div>
		<Button onclick={() => (showCreate = !showCreate)}><Plus />New project</Button>
	</div>
	{#if error}<div
			role="alert"
			class="mb-5 border border-destructive/30 p-4 text-sm text-destructive"
		>
			{error}<Button variant="ghost" onclick={loadProjects}>Retry</Button>
		</div>{/if}
	{#if showCreate}
		<form onsubmit={createProject} class="mb-8 space-y-5 border p-6" aria-label="Create project">
			<h2 class="text-lg font-semibold">New project</h2>
			<Form.Field form={projectForm} name="name"
				><Form.Control
					>{#snippet children({ props })}<Form.Label>Name</Form.Label><Input
							{...props}
							bind:value={$form.name}
							placeholder="e.g. Biology — autumn semester"
						/>{/snippet}</Form.Control
				><Form.FieldErrors /></Form.Field
			>
			<Form.Field form={projectForm} name="description"
				><Form.Control
					>{#snippet children({ props })}<Form.Label
							>Description <span class="font-normal text-muted-foreground">(optional)</span
							></Form.Label
						><Textarea {...props} bind:value={$form.description} rows={2} />{/snippet}</Form.Control
				><Form.FieldErrors /></Form.Field
			>
			<div class="flex gap-2">
				<Button type="submit" disabled={creating}
					>{creating ? 'Creating…' : 'Create project'}</Button
				><Button variant="ghost" onclick={() => (showCreate = false)}>Cancel</Button>
			</div>
		</form>{/if}
	{#if loading}<p role="status" class="py-12 text-muted-foreground">Loading projects…</p>
	{:else if !error && projects.length === 0}<div
			class="flex flex-col items-center border border-dashed px-6 py-16 text-center"
		>
			<FolderOpen class="mb-4 size-8 text-muted-foreground" />
			<h2 class="text-xl font-medium">Your first project starts here</h2>
			<p class="mt-2 max-w-md text-sm text-muted-foreground">
				Create a project, add materials or record audio, then turn your sources into study tools.
			</p>
			<Button class="mt-6" onclick={() => (showCreate = true)}><Plus />Create a project</Button>
		</div>
	{:else if projects.length > 0}<div class="grid gap-4 sm:grid-cols-2">
			{#each projects as project (project.id)}<div
					class="group min-w-0 border p-6 hover:bg-muted/40"
				>
					<div class="flex items-start justify-between gap-3">
						<h2 class="min-w-0 truncate text-lg font-semibold">
							<a
								href={resolve('/projects/[id]', { id: project.id })}
								class="hover:underline focus-visible:outline-2 focus-visible:outline-primary"
								>{project.name}</a
							>
						</h2>
						<div class="flex shrink-0 gap-1">
							<Button
								variant="ghost"
								size="icon"
								aria-label={`${pins.some((pin) => pin.targetType === 'project' && pin.targetId === project.id) ? 'Unpin' : 'Pin'} ${project.name}`}
								disabled={pinBusy === project.id}
								onclick={() => togglePin(project)}
								>{#if pins.some((pin) => pin.targetType === 'project' && pin.targetId === project.id)}<PinOff
									/>{:else}<Pin />{/if}</Button
							><Button
								href={resolve('/projects/[id]', { id: project.id })}
								variant="ghost"
								size="icon"
								aria-label={`Open ${project.name}`}><ArrowUpRight /></Button
							>
						</div>
					</div>
					<p class="mt-2 line-clamp-2 min-h-10 text-sm text-muted-foreground">
						{project.description || 'Add sources and start learning.'}
					</p>
					<p class="mt-6 text-xs text-muted-foreground">
						Updated {dateLabel(project.updatedAt)}
					</p>
				</div>{/each}
		</div>{/if}
</div>
