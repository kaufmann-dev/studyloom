<script lang="ts">
	import { untrack } from 'svelte';
	import { defaults, superForm } from 'sveltekit-superforms';
	import { zod4, zod4Client } from 'sveltekit-superforms/adapters';
	import { libraryInput, type EditableLibraryKind, type LibraryEntry } from '#lib/domain.js';
	import * as Dialog from '#lib/components/ui/dialog/index.js';
	import * as Form from '#lib/components/ui/form/index.js';
	import Input from '#lib/components/ui/input/input.svelte';
	import Textarea from '#lib/components/ui/textarea/textarea.svelte';
	import Button from '#lib/components/ui/button/button.svelte';
	import { api, errorText } from '#lib/ui.js';

	let {
		kind,
		entry = null,
		parentId,
		onSaved,
		onCancel
	}: {
		kind: EditableLibraryKind;
		/** The entry being edited; omitted when creating. */
		entry?: LibraryEntry | null;
		parentId: string | null;
		onSaved: () => void | Promise<void>;
		onCancel: () => void;
	} = $props();
	const editor = superForm(
		defaults(
			untrack(() => ({
				kind,
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
			id: untrack(() => `library-${entry?.id ?? `new-${kind}`}`)
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
			if (entry) await api(`/api/library/${entry.id}`, { method: 'PATCH', body: $form });
			else await api('/api/library', { body: $form });
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
				<Form.Label>{kind === 'contact' ? 'Name' : 'Title'}</Form.Label>
				<Input {...props} bind:value={$form.name} autocomplete="off" />
			{/snippet}
		</Form.Control>
		<Form.FieldErrors />
	</Form.Field>
	{#if kind === 'link'}
		<Form.Field form={editor} name="url">
			<Form.Control>
				{#snippet children({ props })}
					<Form.Label>Web address</Form.Label>
					<Input {...props} type="url" bind:value={$form.url} placeholder="https://example.com" />
				{/snippet}
			</Form.Control>
			<Form.FieldErrors />
		</Form.Field>
	{:else if kind === 'contact'}
		<div class="grid gap-4 sm:grid-cols-2">
			<Form.Field form={editor} name="phone">
				<Form.Control>
					{#snippet children({ props })}
						<Form.Label>Phone</Form.Label>
						<Input {...props} type="tel" bind:value={$form.phone} />
					{/snippet}
				</Form.Control>
				<Form.FieldErrors />
			</Form.Field>
			<Form.Field form={editor} name="email">
				<Form.Control>
					{#snippet children({ props })}
						<Form.Label>Email</Form.Label>
						<Input {...props} type="email" bind:value={$form.email} />
					{/snippet}
				</Form.Control>
				<Form.FieldErrors />
			</Form.Field>
		</div>
		<Form.Field form={editor} name="website">
			<Form.Control>
				{#snippet children({ props })}
					<Form.Label>Website</Form.Label>
					<Input
						{...props}
						type="url"
						bind:value={$form.website}
						placeholder="https://example.com"
					/>
				{/snippet}
			</Form.Control>
			<Form.FieldErrors />
		</Form.Field>
	{:else if kind === 'note'}
		<Form.Field form={editor} name="text">
			<Form.Control>
				{#snippet children({ props })}
					<Form.Label>Text</Form.Label>
					<Textarea {...props} bind:value={$form.text} rows={8} />
				{/snippet}
			</Form.Control>
			<Form.FieldErrors />
		</Form.Field>
	{/if}
	{#if kind === 'link' || kind === 'contact'}
		<Form.Field form={editor} name="notes">
			<Form.Control>
				{#snippet children({ props })}
					<Form.Label>
						Notes <span class="font-normal text-muted-foreground">(optional)</span>
					</Form.Label>
					<Textarea {...props} bind:value={$form.notes} rows={3} />
				{/snippet}
			</Form.Control>
			<Form.FieldErrors />
		</Form.Field>
	{/if}
	{#if error}<p role="alert" class="text-sm text-destructive">{error}</p>{/if}
	<Dialog.Footer>
		<Button type="button" variant="ghost" onclick={onCancel}>Cancel</Button>
		<Button type="submit" disabled={busy}>{busy ? 'Saving…' : 'Save'}</Button>
	</Dialog.Footer>
</form>
