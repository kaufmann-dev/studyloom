<script lang="ts">
	import { untrack } from 'svelte';
	import { defaults, superForm } from 'sveltekit-superforms';
	import { zod4, zod4Client } from 'sveltekit-superforms/adapters';
	import { libraryPatchInput, type LibraryEntry } from '$lib/domain';
	import * as Form from '$lib/components/ui/form';
	import Input from '$lib/components/ui/input/input.svelte';
	import Button from '$lib/components/ui/button/button.svelte';
	import { api, errorText } from '$lib/ui';

	let {
		entry,
		onSaved,
		onCancel
	}: { entry: LibraryEntry; onSaved: () => void | Promise<void>; onCancel: () => void } = $props();
	const schema = libraryPatchInput.pick({ name: true });
	const editor = superForm(
		defaults(
			untrack(() => ({ name: entry.name })),
			zod4(schema)
		),
		{
			validators: zod4Client(schema),
			SPA: true,
			id: untrack(() => `library-file-${entry.id}`)
		}
	);
	const { form } = editor;
	let busy = $state(false);
	let error = $state('');
	async function save(event: SubmitEvent) {
		event.preventDefault();
		if (!(await editor.validateForm()).valid) return;
		busy = true;
		error = '';
		try {
			await api(`/api/library/${entry.id}`, $form, 'PATCH');
			await onSaved();
		} catch (cause) {
			error = errorText(cause);
		} finally {
			busy = false;
		}
	}
</script>

<form onsubmit={save} class="space-y-4 border p-5" aria-label={`Rename ${entry.name}`}>
	<h2 class="text-lg font-semibold">Rename file</h2>
	<Form.Field form={editor} name="name"
		><Form.Control
			>{#snippet children({ props })}<Form.Label>Name</Form.Label><Input
					{...props}
					bind:value={$form.name}
				/>{/snippet}</Form.Control
		><Form.FieldErrors /></Form.Field
	>
	{#if error}<p role="alert" class="text-sm text-destructive">{error}</p>{/if}
	<div class="flex gap-2">
		<Button type="submit" disabled={busy}>Save</Button><Button
			type="button"
			variant="ghost"
			onclick={onCancel}>Cancel</Button
		>
	</div>
</form>
