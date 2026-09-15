<script lang="ts">
	import { untrack } from 'svelte';
	import { defaults, superForm } from 'sveltekit-superforms';
	import { zod4, zod4Client } from 'sveltekit-superforms/adapters';
	import { projectInput } from '$lib/domain';
	import * as Form from '$lib/components/ui/form';
	import Input from '$lib/components/ui/input/input.svelte';
	import Textarea from '$lib/components/ui/textarea/textarea.svelte';
	import Button from '$lib/components/ui/button/button.svelte';
	import { api, errorText } from '$lib/ui';
	let {
		project,
		onSaved,
		onDeleted
	}: {
		project: { id: string; name: string; description?: string | null };
		onSaved: () => void | Promise<void>;
		onDeleted: () => void | Promise<void>;
	} = $props();
	const schema = projectInput;
	const editor = superForm(
		defaults(
			untrack(() => ({ name: project.name, description: project.description ?? '' })),
			zod4(schema)
		),
		{
			validators: zod4Client(schema),
			SPA: true,
			id: untrack(() => `project-details-${project.id}`)
		}
	);
	const { form } = editor;
	let busy = $state(false);
	let error = $state('');
	let confirmDelete = $state(false);
	let notice = $state('');
	async function save(event: SubmitEvent) {
		event.preventDefault();
		if (!(await editor.validateForm()).valid) return;
		busy = true;
		error = '';
		try {
			await api(`/api/projects/${project.id}`, $form, 'PATCH');
			await onSaved();
			notice = 'Project updated.';
		} catch (e) {
			error = errorText(e);
		} finally {
			busy = false;
		}
	}
	async function remove() {
		busy = true;
		error = '';
		try {
			await api(`/api/projects/${project.id}`, undefined, 'DELETE');
			await onDeleted();
		} catch (e) {
			error = errorText(e);
		} finally {
			busy = false;
		}
	}
</script>

<details class="mt-3 text-sm">
	<summary class="w-fit cursor-pointer text-muted-foreground underline underline-offset-4"
		>Project settings</summary
	>
	<div class="mt-4 max-w-xl border p-5">
		<form onsubmit={save} class="space-y-4">
			<Form.Field form={editor} name="name"
				><Form.Control
					>{#snippet children({ props })}<Form.Label>Name</Form.Label><Input
							{...props}
							bind:value={$form.name}
						/>{/snippet}</Form.Control
				><Form.FieldErrors /></Form.Field
			>
			<Form.Field form={editor} name="description"
				><Form.Control
					>{#snippet children({ props })}<Form.Label>Description</Form.Label><Textarea
							{...props}
							bind:value={$form.description}
							rows={2}
						/>{/snippet}</Form.Control
				><Form.FieldErrors /></Form.Field
			>
			<Button type="submit" disabled={busy}>Save changes</Button>
		</form>
		{#if notice}<p role="status" class="mt-3 text-muted-foreground">{notice}</p>{/if}
		<div class="mt-6 border-t pt-4">
			{#if confirmDelete}<p class="mb-3">
					Delete this project and all its materials, conversations, and study tools? This cannot be
					undone.
				</p>
				<div class="flex gap-2">
					<Button variant="destructive" disabled={busy} onclick={remove}>Delete project</Button
					><Button variant="ghost" onclick={() => (confirmDelete = false)}>Keep project</Button>
				</div>{:else}<Button
					variant="ghost"
					class="text-destructive"
					onclick={() => (confirmDelete = true)}>Delete project…</Button
				>{/if}
		</div>
		{#if error}<p role="alert" class="mt-3 text-destructive">{error}</p>{/if}
	</div>
</details>
