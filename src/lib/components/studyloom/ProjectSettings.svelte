<script lang="ts">
	import { untrack } from 'svelte';
	import { toast } from 'svelte-sonner';
	import { Settings2 } from '@lucide/svelte';
	import { defaults, superForm } from 'sveltekit-superforms';
	import { zod4, zod4Client } from 'sveltekit-superforms/adapters';
	import { projectInput, type Project } from '#lib/domain.js';
	import * as Dialog from '#lib/components/ui/dialog/index.js';
	import * as Form from '#lib/components/ui/form/index.js';
	import Input from '#lib/components/ui/input/input.svelte';
	import Textarea from '#lib/components/ui/textarea/textarea.svelte';
	import Button from '#lib/components/ui/button/button.svelte';
	import { api, errorText } from '#lib/ui.js';
	import ConfirmDialog from './ConfirmDialog.svelte';

	let {
		project,
		onSaved,
		onDeleted
	}: {
		project: Project;
		onSaved: () => void | Promise<void>;
		onDeleted: () => void | Promise<void>;
	} = $props();
	const editor = superForm(
		defaults(
			untrack(() => ({ name: project.name, description: project.description })),
			zod4(projectInput)
		),
		{
			validators: zod4Client(projectInput),
			SPA: true,
			id: untrack(() => `project-settings-${project.id}`)
		}
	);
	const { form } = editor;
	let open = $state(false);
	let confirmDelete = $state(false);
	let busy = $state(false);
	let error = $state('');

	function show() {
		$form = { name: project.name, description: project.description };
		error = '';
		open = true;
	}
	async function save(event: SubmitEvent) {
		event.preventDefault();
		if (!(await editor.validateForm({ update: true })).valid) return;
		busy = true;
		error = '';
		try {
			await api(`/api/projects/${project.id}`, { method: 'PATCH', body: $form });
			await onSaved();
			open = false;
			toast.success('Project updated.');
		} catch (cause) {
			error = errorText(cause);
		} finally {
			busy = false;
		}
	}
	async function remove() {
		await api(`/api/projects/${project.id}`, { method: 'DELETE' });
		await onDeleted();
	}
</script>

<Button variant="outline" onclick={show}><Settings2 />Project settings</Button>

<Dialog.Root bind:open>
	<Dialog.Content class="sm:max-w-lg">
		<Dialog.Header>
			<Dialog.Title>Project settings</Dialog.Title>
		</Dialog.Header>
		<form onsubmit={save} class="space-y-4" novalidate>
			<Form.Field form={editor} name="name">
				<Form.Control>
					{#snippet children({ props })}
						<Form.Label>Name</Form.Label>
						<Input {...props} bind:value={$form.name} autocomplete="off" />
					{/snippet}
				</Form.Control>
				<Form.FieldErrors />
			</Form.Field>
			<Form.Field form={editor} name="description">
				<Form.Control>
					{#snippet children({ props })}
						<Form.Label>Description</Form.Label>
						<Textarea {...props} bind:value={$form.description} rows={3} />
					{/snippet}
				</Form.Control>
				<Form.FieldErrors />
			</Form.Field>
			{#if error}<p role="alert" class="text-sm text-destructive">{error}</p>{/if}
			<Dialog.Footer class="sm:justify-between">
				<Button variant="ghost" class="text-destructive" onclick={() => (confirmDelete = true)}>
					Delete project…
				</Button>
				<Button type="submit" disabled={busy}>{busy ? 'Saving…' : 'Save changes'}</Button>
			</Dialog.Footer>
		</form>
	</Dialog.Content>
</Dialog.Root>

<ConfirmDialog
	bind:open={confirmDelete}
	title={`Delete “${project.name}”?`}
	description="This deletes the project with all its materials, conversations, and study tools. This cannot be undone."
	confirmLabel="Delete project"
	cancelLabel="Keep project"
	onConfirm={remove}
/>
