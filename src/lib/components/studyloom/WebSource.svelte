<script lang="ts">
	import { Globe } from '@lucide/svelte';
	import { defaults, superForm } from 'sveltekit-superforms';
	import { zod4, zod4Client } from 'sveltekit-superforms/adapters';
	import { webSourceInput } from '#lib/domain.js';
	import Button from '#lib/components/ui/button/button.svelte';
	import * as Form from '#lib/components/ui/form/index.js';
	import Input from '#lib/components/ui/input/input.svelte';
	import { api, errorText } from '#lib/ui.js';

	let {
		projectId,
		modelId,
		process = true,
		onSaved
	}: {
		projectId: string;
		modelId: string;
		/** Whether extraction starts right after the download or waits until it is asked for. */
		process?: boolean;
		onSaved: () => void | Promise<void>;
	} = $props();
	const editor = superForm(defaults({ url: '' }, zod4(webSourceInput)), {
		validators: zod4Client(webSourceInput),
		SPA: true,
		id: 'web-source'
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
			// The server downloads the page first, so a bad address is reported here.
			await api(`/api/projects/${projectId}/web-sources`, {
				body: { url: $form.url, modelId, process }
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
	<Form.Field form={editor} name="url">
		<Form.Control>
			{#snippet children({ props })}
				<Form.Label>Web page</Form.Label>
				<Input
					{...props}
					type="url"
					bind:value={$form.url}
					placeholder="https://example.com/article"
					autocomplete="off"
					disabled={busy}
				/>
			{/snippet}
		</Form.Control>
		<Form.FieldErrors />
	</Form.Field>
	<Button type="submit" variant="outline" class="w-full" disabled={busy}>
		<Globe />{busy ? 'Downloading page…' : 'Add web page'}
	</Button>
	<p class="text-xs leading-relaxed text-muted-foreground">
		Studyloom downloads the page and reads its text. Pages that need a sign-in cannot be added.
	</p>
	{#if error}<p role="alert" class="text-sm text-destructive">{error}</p>{/if}
</form>
