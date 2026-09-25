<script lang="ts">
	import { untrack } from 'svelte';
	import { defaults, superForm } from 'sveltekit-superforms';
	import { zod4, zod4Client } from 'sveltekit-superforms/adapters';
	import { libraryInput, type LibraryEntry } from '$lib/domain';
	import * as Form from '$lib/components/ui/form';
	import Input from '$lib/components/ui/input/input.svelte';
	import Textarea from '$lib/components/ui/textarea/textarea.svelte';
	import Button from '$lib/components/ui/button/button.svelte';
	import { api, errorText } from '$lib/ui';

	let {
		entry = null,
		parentId,
		onSaved,
		onCancel
	}: {
		entry?: LibraryEntry | null;
		parentId: string | null;
		onSaved: () => void | Promise<void>;
		onCancel: () => void;
	} = $props();
	const editor = superForm(
		defaults(
			untrack(() => ({
				kind: entry?.kind ?? 'folder',
				name: entry?.name ?? '',
				parentId: entry?.parentId ?? parentId,
				url: entry?.url ?? '',
				phone: entry?.phone ?? '',
				email: entry?.email ?? '',
				website: entry?.website ?? '',
				notes: entry?.notes ?? '',
				text: entry?.text ?? ''
			})),
			zod4(libraryInput)
		),
		{
			validators: zod4Client(libraryInput),
			SPA: true,
			id: untrack(() => `library-${entry?.id ?? 'new'}`)
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
			if (entry) await api(`/api/library/${entry.id}`, $form, 'PATCH');
			else await api('/api/library', $form);
			await onSaved();
		} catch (cause) {
			error = errorText(cause);
		} finally {
			busy = false;
		}
	}
</script>

<form
	onsubmit={save}
	class="space-y-4 border p-5"
	aria-label={entry ? `Edit ${entry.name}` : 'Add Library item'}
>
	<h2 class="text-lg font-semibold">{entry ? `Edit ${entry.name}` : 'Add to Library'}</h2>
	{#if !entry}<Form.Field form={editor} name="kind"
			><Form.Control
				>{#snippet children({ props })}<Form.Label>Type</Form.Label><select
						{...props}
						bind:value={$form.kind}
						class="flex h-10 w-full border border-input bg-background px-3 text-sm"
						><option value="folder">Folder</option><option value="link">Link</option><option
							value="contact">Contact</option
						><option value="note">Note</option></select
					>{/snippet}</Form.Control
			><Form.FieldErrors /></Form.Field
		>{/if}
	<Form.Field form={editor} name="name"
		><Form.Control
			>{#snippet children({ props })}<Form.Label
					>{$form.kind === 'contact' ? 'Name' : 'Title'}</Form.Label
				><Input {...props} bind:value={$form.name} />{/snippet}</Form.Control
		><Form.FieldErrors /></Form.Field
	>
	{#if $form.kind === 'link'}
		<Form.Field form={editor} name="url"
			><Form.Control
				>{#snippet children({ props })}<Form.Label>Web address</Form.Label><Input
						{...props}
						type="url"
						bind:value={$form.url}
						placeholder="https://example.com"
					/>{/snippet}</Form.Control
			><Form.FieldErrors /></Form.Field
		>
	{:else if $form.kind === 'contact'}
		<Form.Field form={editor} name="phone"
			><Form.Control
				>{#snippet children({ props })}<Form.Label>Phone</Form.Label><Input
						{...props}
						type="tel"
						bind:value={$form.phone}
					/>{/snippet}</Form.Control
			><Form.FieldErrors /></Form.Field
		>
		<Form.Field form={editor} name="email"
			><Form.Control
				>{#snippet children({ props })}<Form.Label>Email</Form.Label><Input
						{...props}
						type="email"
						bind:value={$form.email}
					/>{/snippet}</Form.Control
			><Form.FieldErrors /></Form.Field
		>
		<Form.Field form={editor} name="website"
			><Form.Control
				>{#snippet children({ props })}<Form.Label>Website</Form.Label><Input
						{...props}
						type="url"
						bind:value={$form.website}
					/>{/snippet}</Form.Control
			><Form.FieldErrors /></Form.Field
		>
		<Form.Field form={editor} name="notes"
			><Form.Control
				>{#snippet children({ props })}<Form.Label>Notes</Form.Label><Textarea
						{...props}
						bind:value={$form.notes}
						rows={3}
					/>{/snippet}</Form.Control
			><Form.FieldErrors /></Form.Field
		>
	{:else if $form.kind === 'note'}
		<Form.Field form={editor} name="text"
			><Form.Control
				>{#snippet children({ props })}<Form.Label>Text</Form.Label><Textarea
						{...props}
						bind:value={$form.text}
						rows={8}
					/>{/snippet}</Form.Control
			><Form.FieldErrors /></Form.Field
		>
	{/if}
	{#if error}<p role="alert" class="text-sm text-destructive">{error}</p>{/if}
	<div class="flex gap-2">
		<Button type="submit" disabled={busy}>{busy ? 'Saving…' : 'Save'}</Button><Button
			type="button"
			variant="ghost"
			onclick={onCancel}>Cancel</Button
		>
	</div>
</form>
