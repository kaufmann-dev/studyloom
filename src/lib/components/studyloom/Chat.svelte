<script lang="ts">
	import { onMount, onDestroy } from 'svelte';
	import { defaults, superForm } from 'sveltekit-superforms';
	import { zod4, zod4Client } from 'sveltekit-superforms/adapters';
	import { Send, Plus, Copy, Download } from '@lucide/svelte';
	import {
		chatInput,
		DEFAULT_MODEL,
		type Conversation,
		type Message,
		type Material,
		type MuseModel,
		type Job
	} from '$lib/domain';
	import * as Form from '$lib/components/ui/form';
	import Textarea from '$lib/components/ui/textarea/textarea.svelte';
	import Button from '$lib/components/ui/button/button.svelte';
	import Citations from './Citations.svelte';
	import { api, errorText, downloadText } from '$lib/ui';
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
		SPA: true
	});
	const { form } = editor;
	let messages = $state.raw<Message[]>([]);
	let conversationId = $state('');
	let sending = $state(false);
	let loading = $state(false);
	let error = $state('');
	let notice = $state('');
	let activeJob = $state('');
	let timer: ReturnType<typeof setTimeout> | undefined;
	let mounted = false;
	let syncTimer: ReturnType<typeof setInterval> | undefined;
	let observedJob = '';
	async function syncConversation() {
		if (sending || !conversationId) return;
		const job = jobs.find((item) => item.conversationId === conversationId);
		if (!job) return;
		const version = `${job.id}:${job.status}:${job.updatedAt}`;
		if (observedJob === version) return;
		observedJob = version;
		const id = conversationId;
		try {
			const result = await api<{ messages: Message[] }>(`/api/conversations/${id}`);
			if (mounted && conversationId === id) messages = result.messages;
		} catch (e) {
			if (mounted) error = errorText(e);
		}
	}
	let exported = $derived(
		messages
			.map((message) => `## ${message.role === 'user' ? 'You' : 'Studyloom'}\n\n${message.content}`)
			.join('\n\n')
	);
	async function open(id: string, interaction = true) {
		conversationId = id;
		if (!id) {
			messages = [];
			return;
		}
		loading = true;
		error = '';
		try {
			const data = await api<{ conversation: Conversation; messages: Message[] }>(
				`/api/conversations/${id}`,
				undefined,
				'GET',
				interaction
			);
			if (conversationId === id) {
				messages = data.messages;
				$form.modelId = data.conversation.modelId;
			}
		} catch (e) {
			error = errorText(e);
		} finally {
			loading = false;
		}
	}
	async function poll(jobId: string) {
		try {
			const { job } = await api<{ job: Job }>(`/api/jobs/${jobId}`);
			if (!mounted) return;
			if (job.status === 'queued' || job.status === 'running') {
				timer = setTimeout(() => poll(jobId), 1500);
				return;
			}
			sending = false;
			activeJob = '';

			if (job.status === 'cancelled') notice = 'Response cancelled.';
			await open(conversationId, false);
			if (job.status === 'failed')
				error = job.error ?? 'The response could not be generated. Retry it in Interrupted jobs.';
			await onChanged();
		} catch (e) {
			error = errorText(e);
			sending = false;
			activeJob = '';
		}
	}
	async function send(event: SubmitEvent) {
		event.preventDefault();
		if (sending || !(await editor.validateForm()).valid) return;
		if (!materialIds.length) {
			error = 'Select at least one ready source.';
			return;
		}
		sending = true;
		error = '';
		notice = '';
		try {
			const result = await api<{ jobId: string; conversationId: string }>(
				`/api/projects/${projectId}/chat`,
				{ ...$form, materialIds, ...(conversationId ? { conversationId } : {}) }
			);
			conversationId = result.conversationId;
			activeJob = result.jobId;
			$form.message = '';
			await open(conversationId, false);
			await onChanged();
			void poll(result.jobId);
		} catch (e) {
			error = errorText(e);
			sending = false;
		}
	}
	async function cancel() {
		try {
			await api(`/api/jobs/${activeJob}/cancel`, {});
		} catch (e) {
			error = errorText(e);
		}
	}
	async function copy() {
		try {
			await navigator.clipboard.writeText(exported);
			notice = 'Conversation copied.';
		} catch (e) {
			error = errorText(e);
		}
	}
	onMount(() => {
		mounted = true;
		syncTimer = setInterval(() => {
			void syncConversation();
		}, 2500);
	});
	onDestroy(() => {
		mounted = false;
		clearTimeout(timer);
		clearInterval(syncTimer);
	});
</script>

<div class="space-y-5">
	<div class="flex flex-wrap items-center gap-2">
		<label for="conversation" class="sr-only">Conversation</label><select
			id="conversation"
			class="h-9 min-w-0 flex-1 border bg-background px-2 text-sm"
			value={conversationId}
			disabled={sending}
			onchange={(event) => open(event.currentTarget.value)}
			><option value="">New conversation</option
			>{#each conversations as conversation (conversation.id)}<option value={conversation.id}
					>{conversation.title}</option
				>{/each}</select
		><Button variant="outline" disabled={sending} onclick={() => open('')}
			><Plus /><span class="hidden sm:inline">New</span></Button
		>{#if messages.length}<Button
				variant="ghost"
				size="icon"
				aria-label="Copy conversation"
				onclick={copy}><Copy /></Button
			><Button
				variant="ghost"
				size="icon"
				aria-label="Download conversation"
				onclick={() => downloadText('conversation.md', exported)}><Download /></Button
			>{/if}
	</div>
	{#if loading}<p role="status" class="text-sm text-muted-foreground">Loading conversation…</p>{/if}
	<div class="min-h-48 space-y-6" aria-label="Conversation messages">
		{#each messages as message (message.id)}<article
				class={message.role === 'user' ? 'ml-8 bg-muted p-4' : 'pr-4'}
			>
				<h3 class="mb-2 text-xs font-semibold text-muted-foreground">
					{message.role === 'user' ? 'You' : 'Studyloom'}
				</h3>
				<p class="text-sm leading-relaxed break-words whitespace-pre-wrap">{message.content}</p>
				<Citations {projectId} citations={message.citations} {materials} />{#if message.modelId}<p
						class="mt-3 text-xs break-all text-muted-foreground"
					>
						{message.modelId}
					</p>{/if}
			</article>{:else}<div class="py-10">
				<h2 class="text-xl font-medium">Ask your sources</h2>
				<p class="mt-2 max-w-lg text-sm leading-relaxed text-muted-foreground">
					Explore an idea, compare concepts, or ask for an explanation. Responses draw on the
					sources you select and link back to the evidence.
				</p>
			</div>{/each}
	</div>
	{#if sending}<div role="status" class="flex items-center gap-3 text-sm text-muted-foreground">
			Working with your sources…<Button variant="ghost" size="sm" onclick={cancel}>Cancel</Button>
		</div>{/if}
	{#if error}<p role="alert" class="text-sm text-destructive">{error}</p>{/if}{#if notice}<p
			role="status"
			class="text-xs text-muted-foreground"
		>
			{notice}
		</p>{/if}
	<form onsubmit={send} class="space-y-4 border-t pt-5">
		<Form.Field form={editor} name="message"
			><Form.Control
				>{#snippet children({ props })}<Form.Label>Your question</Form.Label><Textarea
						{...props}
						bind:value={$form.message}
						rows={3}
						placeholder="Explain the main concepts and how they connect…"
						disabled={sending}
					/>{/snippet}</Form.Control
			><Form.FieldErrors /></Form.Field
		>
		<div class="flex flex-wrap items-end gap-3">
			<Form.Field form={editor} name="modelId" class="min-w-0 flex-1"
				><Form.Control
					>{#snippet children({ props })}<Form.Label>Model</Form.Label><select
							{...props}
							bind:value={$form.modelId}
							class="h-9 w-full border bg-background px-2 text-sm"
							disabled={sending}
							><option value={DEFAULT_MODEL}
								>{models.find((model) => model.modelId === DEFAULT_MODEL)?.displayLabel ??
									DEFAULT_MODEL}</option
							>{#each models.filter((model) => model.modelId !== DEFAULT_MODEL) as model (model.modelId)}<option
									value={model.modelId}>{model.displayLabel}</option
								>{/each}</select
						>{/snippet}</Form.Control
				><Form.FieldErrors /></Form.Field
			><Button type="submit" disabled={sending || !materialIds.length || !models.length}
				><Send />Send</Button
			>
		</div>
		<p class="text-xs text-muted-foreground">
			{materialIds.length} source{materialIds.length === 1 ? '' : 's'} selected{!models.length
				? ' · Connect Muse in Settings to continue.'
				: ''}
		</p>
	</form>
</div>
