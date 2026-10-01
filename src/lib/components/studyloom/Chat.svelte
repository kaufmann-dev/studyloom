<script lang="ts">
	import { onMount, untrack } from 'svelte';
	import { defaults, superForm } from 'sveltekit-superforms';
	import { zod4, zod4Client } from 'sveltekit-superforms/adapters';
	import { Copy, Download, Plus, Send } from '@lucide/svelte';
	import {
		chatInput,
		DEFAULT_MODEL,
		type Conversation,
		type Job,
		type Material,
		type Message,
		type MuseModel
	} from '#lib/domain.js';
	import Button from '#lib/components/ui/button/button.svelte';
	import * as Form from '#lib/components/ui/form/index.js';
	import * as NativeSelect from '#lib/components/ui/native-select/index.js';
	import { Spinner } from '#lib/components/ui/spinner/index.js';
	import Textarea from '#lib/components/ui/textarea/textarea.svelte';
	import { waitForJob } from '#lib/polling.js';
	import { api, copyText, downloadText, errorText, plural } from '#lib/ui.js';
	import Citations from './Citations.svelte';
	import Markdown from './Markdown.svelte';
	import ModelSelect, { availableModel } from './ModelSelect.svelte';

	let {
		projectId,
		materialIds,
		materials,
		models,
		conversations,
		jobs,
		onChanged
	}: {
		projectId: string;
		materialIds: string[];
		materials: Material[];
		models: MuseModel[];
		conversations: Conversation[];
		jobs: Job[];
		onChanged: () => void | Promise<void>;
	} = $props();
	const schema = chatInput.pick({ message: true, modelId: true });
	const editor = superForm(defaults({ message: '', modelId: DEFAULT_MODEL }, zod4(schema)), {
		validators: zod4Client(schema),
		SPA: true,
		id: untrack(() => `chat-${projectId}`)
	});
	const { form } = editor;
	const SYNC_MS = 2500;
	const lifetime = new AbortController();
	let messages = $state.raw<Message[]>([]);
	let conversationId = $state('');
	let sending = $state(false);
	let loading = $state(false);
	let error = $state('');
	let notice = $state('');
	let activeJob = $state('');
	// What is safely on screen, restored when opening another conversation fails.
	let loaded: { id: string; messages: Message[] } = { id: '', messages: [] };
	// Guards against a slow response overwriting a conversation opened later.
	let openVersion = 0;
	// The job state already reflected in `messages`, so unchanged jobs are not refetched.
	let syncedJob = '';

	let exported = $derived(
		messages
			.map((message) => `## ${message.role === 'user' ? 'You' : 'Studyloom'}\n\n${message.content}`)
			.join('\n\n')
	);
	let canSend = $derived(!sending && !loading && materialIds.length > 0 && models.length > 0);

	/** Picks up answers that finished while this conversation was not being watched. */
	async function syncConversation() {
		if (sending || loading || !conversationId) return;
		const job = jobs.find((item) => item.conversationId === conversationId);
		if (!job) return;
		const state = `${job.id}:${job.status}:${job.updatedAt}`;
		if (syncedJob === state) return;
		const id = conversationId;
		const version = openVersion;
		const current = () =>
			!lifetime.signal.aborted && openVersion === version && conversationId === id;
		try {
			const result = await api<{ messages: Message[] }>(`/api/conversations/${id}`);
			if (!current() || loading) return;
			messages = result.messages;
			loaded = { id, messages: result.messages };
			syncedJob = state;
		} catch (cause) {
			if (current()) error = errorText(cause);
		}
	}
	async function open(id: string, interaction = true) {
		const version = ++openVersion;
		conversationId = id;
		messages = [];
		syncedJob = '';
		error = '';
		if (!id) {
			loaded = { id: '', messages: [] };
			loading = false;
			return;
		}
		loading = true;
		try {
			const data = await api<{ conversation: Conversation; messages: Message[] }>(
				`/api/conversations/${id}`,
				{ interaction }
			);
			if (version !== openVersion) return;
			messages = data.messages;
			loaded = { id, messages: data.messages };
			$form.modelId = data.conversation.modelId;
		} catch (cause) {
			if (version !== openVersion) return;
			conversationId = loaded.id;
			messages = loaded.messages;
			error = errorText(cause);
		} finally {
			if (version === openVersion) loading = false;
		}
	}
	async function awaitAnswer(jobId: string, jobConversationId: string) {
		try {
			const job = await waitForJob(jobId, lifetime.signal);
			if (!job) return;
			sending = false;
			activeJob = '';
			if (job.status === 'cancelled') notice = 'Response cancelled.';
			if (conversationId === jobConversationId) await open(jobConversationId, false);
			if (job.status === 'failed')
				error = job.error ?? 'The response could not be generated. Retry it in Interrupted jobs.';
			await onChanged();
		} catch (cause) {
			error = errorText(cause);
			sending = false;
			activeJob = '';
		}
	}
	async function send(event: SubmitEvent) {
		event.preventDefault();
		if (sending || loading || !(await editor.validateForm({ update: true })).valid) return;
		if (!materialIds.length) {
			error = 'Select at least one ready source.';
			return;
		}
		sending = true;
		error = '';
		notice = '';
		let accepted = false;
		try {
			const result = await api<{ jobId: string; conversationId: string }>(
				`/api/projects/${projectId}/chat`,
				{
					body: {
						...$form,
						modelId: availableModel(models, $form.modelId),
						materialIds,
						...(conversationId ? { conversationId } : {})
					}
				}
			);
			accepted = true;
			conversationId = result.conversationId;
			loaded = { id: result.conversationId, messages: [] };
			activeJob = result.jobId;
			$form.message = '';
			await open(result.conversationId, false);
			void awaitAnswer(result.jobId, result.conversationId);
			await onChanged();
		} catch (cause) {
			error = errorText(cause);
			// Once the job is accepted, the poll owns the sending state.
			if (!accepted) sending = false;
		}
	}
	async function cancel() {
		try {
			await api(`/api/jobs/${activeJob}/cancel`, { body: {} });
		} catch (cause) {
			error = errorText(cause);
		}
	}
	function submitOnEnter(event: KeyboardEvent & { currentTarget: HTMLTextAreaElement }) {
		if (event.key !== 'Enter' || event.shiftKey || event.isComposing) return;
		event.preventDefault();
		event.currentTarget.form?.requestSubmit();
	}

	onMount(() => {
		const timer = setInterval(() => void syncConversation(), SYNC_MS);
		return () => {
			lifetime.abort();
			clearInterval(timer);
		};
	});
</script>

<div class="space-y-5">
	<div class="flex flex-wrap items-center gap-2">
		<label for="conversation" class="sr-only">Conversation</label>
		<NativeSelect.Root
			id="conversation"
			class="min-w-0 flex-1"
			value={conversationId}
			disabled={sending}
			onchange={(event) => open(event.currentTarget.value)}
		>
			<NativeSelect.Option value="">New conversation</NativeSelect.Option>
			{#each conversations as conversation (conversation.id)}
				<NativeSelect.Option value={conversation.id}>{conversation.title}</NativeSelect.Option>
			{/each}
		</NativeSelect.Root>
		<Button variant="outline" disabled={sending} onclick={() => open('')}>
			<Plus /><span class="hidden sm:inline">New</span><span class="sr-only sm:hidden"
				>New conversation</span
			>
		</Button>
		{#if messages.length}
			<Button
				variant="ghost"
				size="icon"
				aria-label="Copy conversation"
				onclick={() => copyText(exported, 'Conversation copied.')}><Copy /></Button
			>
			<Button
				variant="ghost"
				size="icon"
				aria-label="Download conversation"
				onclick={() => downloadText('conversation.md', exported)}><Download /></Button
			>
		{/if}
	</div>
	{#if loading}<p role="status" class="text-sm text-muted-foreground">Loading conversation…</p>{/if}
	<div class="min-h-48 space-y-6" aria-label="Conversation messages">
		{#each messages as message (message.id)}
			<article class={message.role === 'user' ? 'ml-8 bg-muted p-4' : 'pr-4'}>
				<h3 class="mb-2 text-xs font-semibold text-muted-foreground">
					{message.role === 'user' ? 'You' : 'Studyloom'}
				</h3>
				{#if message.role === 'user'}
					<p class="text-sm leading-relaxed break-words whitespace-pre-wrap">{message.content}</p>
				{:else}
					<Markdown text={message.content} />
				{/if}
				<Citations {projectId} citations={message.citations} {materials} />
				{#if message.modelId}
					<p class="mt-3 text-xs break-all text-muted-foreground">{message.modelId}</p>
				{/if}
			</article>
		{:else}
			{#if !loading}
				<div class="py-10">
					<h2 class="text-xl font-medium">Ask your sources</h2>
					<p class="mt-2 max-w-lg text-sm leading-relaxed text-muted-foreground">
						Explore an idea, compare concepts, or ask for an explanation. Responses draw on the
						sources you select and link back to the evidence.
					</p>
				</div>
			{/if}
		{/each}
	</div>
	{#if sending}
		<div role="status" class="flex items-center gap-3 text-sm text-muted-foreground">
			<Spinner class="size-4" role="presentation" />Working with your sources…
			{#if activeJob}<Button variant="ghost" size="sm" onclick={cancel}>Cancel</Button>{/if}
		</div>
	{/if}
	{#if error}<p role="alert" class="text-sm text-destructive">{error}</p>{/if}
	{#if notice}<p role="status" class="text-xs text-muted-foreground">{notice}</p>{/if}
	<form onsubmit={send} class="space-y-4 border-t pt-5" novalidate>
		<Form.Field form={editor} name="message">
			<Form.Control>
				{#snippet children({ props })}
					<Form.Label>Your question</Form.Label>
					<Textarea
						{...props}
						bind:value={$form.message}
						rows={3}
						placeholder="Explain the main concepts and how they connect…"
						disabled={sending || loading}
						onkeydown={submitOnEnter}
					/>
				{/snippet}
			</Form.Control>
			<Form.FieldErrors />
		</Form.Field>
		<div class="flex flex-wrap items-end gap-3">
			<Form.Field form={editor} name="modelId" class="min-w-0 flex-1">
				<Form.Control>
					{#snippet children({ props })}
						<Form.Label>Model</Form.Label>
						<ModelSelect
							{...props}
							{models}
							bind:value={$form.modelId}
							disabled={sending || loading}
						/>
					{/snippet}
				</Form.Control>
				<Form.FieldErrors />
			</Form.Field>
			<Button type="submit" disabled={!canSend}><Send />Send</Button>
		</div>
		<p class="text-xs text-muted-foreground">
			{plural(materialIds.length, 'source')} selected · Enter sends, Shift+Enter adds a line{models.length
				? ''
				: ' · Connect Muse in Settings to continue.'}
		</p>
	</form>
</div>
