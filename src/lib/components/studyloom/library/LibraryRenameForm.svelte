<script lang="ts">
	import { untrack } from 'svelte';
	import { defaults, superForm } from 'sveltekit-superforms';
	import { zod4, zod4Client } from 'sveltekit-superforms/adapters';
	import { libraryPatchInput, type LibraryEntry } from '#lib/domain.js';
	import * as Dialog from '#lib/components/ui/dialog/index.js';
	import * as Form from '#lib/components/ui/form/index.js';
	import Input from '#lib/components/ui/input/input.svelte';
	import Button from '#lib/components/ui/button/button.svelte';
	import { api, errorText } from '#lib/ui.js';

	let {
		entry,
		onSaved,
		onCancel
	}: { entry: LibraryEntry; onSaved: () => void | Promise<void>; onCancel: () => void } = $props();
	const schema = libraryPatchInput.pick({ name: true }).required();
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
		if (!(await editor.validateForm({ update: true })).valid) return;
		busy = true;
		error = '';
		try {
			await api(`/api/library/${entry.id}`, { method: 'PATCH', body: $form });
			await onSaved();
		} catch (cause) {
			error = errorText(cause);
		} finally {
			busy = false;
		}
	}
</script>

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
	{#if error}<p role="alert" class="text-sm text-destructive">{error}</p>{/if}
	<Dialog.Footer>
		<Button type="button" variant="ghost" onclick={onCancel}>Cancel</Button>
		<Button type="submit" disabled={busy}>{busy ? 'Saving…' : 'Save'}</Button>
	</Dialog.Footer>
</form>
