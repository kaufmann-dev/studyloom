<script lang="ts">
	import { toast } from 'svelte-sonner';
	import { defaults, superForm } from 'sveltekit-superforms';
	import { zod4, zod4Client } from 'sveltekit-superforms/adapters';
	import { AudioLines } from '@lucide/svelte';
	import { lessonVoiceInput, type LessonVoice, type SpeechModel, type Voice } from '#lib/domain.js';
	import Button from '#lib/components/ui/button/button.svelte';
	import * as Dialog from '#lib/components/ui/dialog/index.js';
	import * as Form from '#lib/components/ui/form/index.js';
	import * as NativeSelect from '#lib/components/ui/native-select/index.js';
	import { api, errorText } from '#lib/ui.js';
	import ErrorAlert from './ErrorAlert.svelte';

	/** Chooses, changes or removes the voice a lesson is read in. */
	let {
		outputId,
		voice,
		onVoice,
		onQueued
	}: {
		outputId: string;
		voice: LessonVoice | null;
		onVoice: (voice: LessonVoice | null) => void;
		/** Called when voicing everything was queued, so the job list can show it. */
		onQueued?: () => void | Promise<void>;
	} = $props();
	type SpeechCatalog = { voices: Voice[]; models: SpeechModel[] };
	const editor = superForm(defaults({ voiceId: '', speechModelId: '' }, zod4(lessonVoiceInput)), {
		validators: zod4Client(lessonVoiceInput),
		SPA: true,
		id: 'lesson-voice'
	});
	const { form } = editor;
	let open = $state(false);
	let busy = $state(false);
	let error = $state('');
	let catalog = $state.raw<SpeechCatalog | null>(null);
	let catalogError = $state('');
	/** The chosen entry while ElevenLabs still offers it, otherwise the first one listed. */
	const offered = (ids: string[], preferred: string) =>
		ids.includes(preferred) ? preferred : (ids[0] ?? '');
	let voiceId = $derived(offered(catalog?.voices.map((item) => item.voiceId) ?? [], $form.voiceId));
	let speechModelId = $derived(
		offered(catalog?.models.map((item) => item.modelId) ?? [], $form.speechModelId)
	);

	async function show() {
		open = true;
		error = '';
		$form.voiceId = voice?.voiceId ?? '';
		$form.speechModelId = voice?.speechModelId ?? '';
		if (catalog) return;
		catalogError = '';
		try {
			catalog = await api<SpeechCatalog>('/api/speech');
		} catch (cause) {
			catalogError = errorText(cause);
		}
	}
	async function act(work: () => Promise<void>) {
		if (busy) return;
		busy = true;
		error = '';
		try {
			await work();
		} catch (cause) {
			error = errorText(cause);
		} finally {
			busy = false;
		}
	}
	function save(event: SubmitEvent) {
		event.preventDefault();
		return act(async () => {
			const result = await api<{ voice: LessonVoice }>(`/api/outputs/${outputId}/voice`, {
				method: 'PUT',
				body: { voiceId, speechModelId }
			});
			onVoice(result.voice);
			open = false;
		});
	}
	const turnOff = () =>
		act(async () => {
			await api(`/api/outputs/${outputId}/voice`, { method: 'DELETE' });
			onVoice(null);
			open = false;
		});
	const voiceAll = () =>
		act(async () => {
			await api(`/api/outputs/${outputId}/voice-all`, { body: {} });
			toast.success('Voicing every explanation. You can keep studying meanwhile.');
			await onQueued?.();
			open = false;
		});
</script>

<Button variant="ghost" size="sm" class="max-w-full" onclick={show}>
	<AudioLines />
	<span class="truncate">{voice ? `Voice: ${voice.voiceName}` : 'Add a voice'}</span>
</Button>
<Dialog.Root bind:open>
	<Dialog.Content class="sm:max-w-md">
		<Dialog.Header>
			<Dialog.Title>Lesson voice</Dialog.Title>
			<Dialog.Description>
				Each explanation is voiced when you first play it and kept afterwards. Changing the voice
				discards what was voiced so far.
			</Dialog.Description>
		</Dialog.Header>
		<ErrorAlert message={catalogError} />
		<form onsubmit={save} class="space-y-4" novalidate>
			<Form.Field form={editor} name="voiceId">
				<Form.Control>
					{#snippet children({ props })}
						<Form.Label>Voice</Form.Label>
						<NativeSelect.Root
							{...props}
							class="w-full"
							bind:value={() => voiceId, (next) => ($form.voiceId = next)}
							disabled={busy || !catalog}
						>
							{#each catalog?.voices ?? [] as item (item.voiceId)}
								<NativeSelect.Option value={item.voiceId}>
									{item.description ? `${item.name} · ${item.description}` : item.name}
								</NativeSelect.Option>
							{:else}
								<NativeSelect.Option value="">
									{catalog ? 'No voices available' : 'Loading voices…'}
								</NativeSelect.Option>
							{/each}
						</NativeSelect.Root>
					{/snippet}
				</Form.Control>
				<Form.FieldErrors />
			</Form.Field>
			<Form.Field form={editor} name="speechModelId">
				<Form.Control>
					{#snippet children({ props })}
						<Form.Label>Speech model</Form.Label>
						<NativeSelect.Root
							{...props}
							class="w-full"
							bind:value={() => speechModelId, (next) => ($form.speechModelId = next)}
							disabled={busy || !catalog}
						>
							{#each catalog?.models ?? [] as model (model.modelId)}
								<NativeSelect.Option value={model.modelId}>
									{model.name} · {model.costMultiplier}× credits
								</NativeSelect.Option>
							{:else}
								<NativeSelect.Option value="">
									{catalog ? 'No speech models available' : 'Loading models…'}
								</NativeSelect.Option>
							{/each}
						</NativeSelect.Root>
					{/snippet}
				</Form.Control>
				<Form.FieldErrors />
			</Form.Field>
			{#if error}<p role="alert" class="text-sm text-destructive">{error}</p>{/if}
			<div class="flex flex-wrap gap-2">
				<Button type="submit" disabled={busy || !voiceId || !speechModelId}>
					{voice ? 'Change voice' : 'Use this voice'}
				</Button>
				{#if voice}
					<Button variant="outline" disabled={busy} onclick={voiceAll}>Voice everything now</Button>
					<Button variant="ghost" disabled={busy} onclick={turnOff}>Turn voice off</Button>
				{/if}
			</div>
		</form>
	</Dialog.Content>
</Dialog.Root>
