<script lang="ts">
	import { ClipboardPaste } from '@lucide/svelte';
	import { defaults, superForm } from 'sveltekit-superforms';
	import { zod4, zod4Client } from 'sveltekit-superforms/adapters';
	import { pastedTextInput } from '#lib/domain.js';
	import Button from '#lib/components/ui/button/button.svelte';
	import * as Form from '#lib/components/ui/form/index.js';
	import Input from '#lib/components/ui/input/input.svelte';
	import Textarea from '#lib/components/ui/textarea/textarea.svelte';
	import { api, errorText } from '#lib/ui.js';

	let { projectId, onSaved }: { projectId: string; onSaved: () => void | Promise<void> } = $props();
	const editor = superForm(defaults({ name: '', text: '' }, zod4(pastedTextInput)), {
		validators: zod4Client(pastedTextInput),
		SPA: true,
		id: 'pasted-text'
	});
	const { form } = editor;
	let busy = $state(false);
	let error = $state('');

	async function add(event: SubmitEvent) {
		event.preventDefault();
		if (busy || !(await editor.validateForm({ update: true })).valid) return;
		busy = true;
		error = '';
		try {
			await api(`/api/projects/${projectId}/text-sources`, {
				body: { name: $form.name, text: $form.text }
			});
			editor.reset();
			await onSaved();
		} catch (cause) {
			error = errorText(cause);
		} finally {
			busy = false;
		}
	}
</script>

<form onsubmit={add} class="space-y-2" novalidate>
	<Form.Field form={editor} name="text">
		<Form.Control>
			{#snippet children({ props })}
				<Form.Label>Paste text</Form.Label>
				<Textarea
					{...props}
					bind:value={$form.text}
					rows={5}
					placeholder="Paste notes, an article or a transcript"
					disabled={busy}
				/>
			{/snippet}
		</Form.Control>
		<Form.FieldErrors />
	</Form.Field>
	<Form.Field form={editor} name="name">
		<Form.Control>
			{#snippet children({ props })}
				<Form.Label>Name</Form.Label>
				<Input
					{...props}
					bind:value={$form.name}
					placeholder="Optional, the first line by default"
					autocomplete="off"
					disabled={busy}
				/>
			{/snippet}
		</Form.Control>
		<Form.FieldErrors />
	</Form.Field>
	<Button type="submit" variant="outline" class="w-full" disabled={busy}>
		<ClipboardPaste />{busy ? 'Adding text…' : 'Add text'}
	</Button>
	<p class="text-xs leading-relaxed text-muted-foreground">
		Pasted text is ready to use right away.
	</p>
	{#if error}<p role="alert" class="text-sm text-destructive">{error}</p>{/if}
</form>
