<script lang="ts">
	import { onDestroy, onMount, untrack } from 'svelte';
	import { defaults, superForm } from 'sveltekit-superforms';
	import { zod4, zod4Client } from 'sveltekit-superforms/adapters';
	import { ArrowLeft, Sparkles } from '@lucide/svelte';
	import {
		AUDIO_LENGTHS,
		AUDIO_STYLES,
		SESSION_LENGTHS,
		generationInput,
		DEFAULT_MODEL,
		type StudyOutput,
		type Material,
		type MuseModel,
		type SpeechModel,
		type Voice
	} from '#lib/domain.js';
	import Button from '#lib/components/ui/button/button.svelte';
	import * as Form from '#lib/components/ui/form/index.js';
	import Input from '#lib/components/ui/input/input.svelte';
	import * as NativeSelect from '#lib/components/ui/native-select/index.js';
	import { waitForJob } from '#lib/polling.js';
	import { api, dateLabel, errorText, plural } from '#lib/ui.js';
	import ErrorAlert from './ErrorAlert.svelte';
	import ModelSelect, { availableModel } from './ModelSelect.svelte';
	import OutputViewer from './OutputViewer.svelte';

	let {
		projectId,
		kind,
		materialIds,
		materials,
		models,
		outputs,
		onChanged
	}: {
		projectId: string;
		kind: 'summary' | 'quiz' | 'audio' | 'session';
		materialIds: string[];
		materials: Material[];
		models: MuseModel[];
		outputs: StudyOutput[];
		onChanged: () => void | Promise<void>;
	} = $props();
	const schema = generationInput.pick({
		modelId: true,
		questionCount: true,
		questionMix: true,
		voiceId: true,
		learnerVoiceId: true,
		speechModelId: true,
		audioLength: true,
		audioStyle: true,
		sessionLength: true
	});
	const editor = superForm(
		defaults(
			{
				modelId: DEFAULT_MODEL,
				questionCount: 10,
				questionMix: 'mixed',
				voiceId: '',
				learnerVoiceId: '',
				speechModelId: '',
				audioLength: 'short',
				audioStyle: 'narration',
				sessionLength: 'standard'
			},
			zod4(schema)
		),
		{
			validators: zod4Client(schema),
			SPA: true,
			id: untrack(() => `${kind}-generator-${projectId}`)
		}
	);
	const { form } = editor;
	const lifetime = new AbortController();
	const COPY = {
		summary: {
			one: 'summary',
			many: 'summaries',
			title: 'Build an overview',
			intro:
				'Turn your selected materials into an overview with references to the original sources.'
		},
		audio: {
			one: 'audio summary',
			many: 'audio summaries',
			title: 'Listen to your sources',
			intro:
				'Turn your selected materials into a narrated summary or a tutor and learner conversation, with pauses to think along.'
		},
		session: {
			one: 'study session',
			many: 'study sessions',
			title: 'Study out loud',
			intro:
				'A voice tutor explains each part, asks you a question and responds to your spoken answer. Once it starts, you only need to talk.'
		},
		quiz: {
			one: 'quiz',
			many: 'quizzes',
			title: 'Test your understanding',
			intro:
				'Create questions from your selected sources, then get feedback on multiple-choice and written answers.'
		}
	};
	let busy = $state(false);
	let error = $state('');
	let notice = $state('');
	let selectedId = $state('');
	let activeJob = $state('');
	let copy = $derived(COPY[kind]);
	let matching = $derived(outputs.filter((output) => output.kind === kind));

	type SpeechCatalog = { voices: Voice[]; models: SpeechModel[] };
	let catalog = $state.raw<SpeechCatalog | null>(null);
	let catalogError = $state('');
	/** The saved choice while ElevenLabs still offers it, otherwise the first one listed. */
	function offered(ids: string[], preferred: string) {
		return ids.includes(preferred) ? preferred : (ids[0] ?? '');
	}
	let voiceId = $derived(
		offered(catalog?.voices.map((voice) => voice.voiceId) ?? [], $form.voiceId)
	);
	let spoken = $derived(kind === 'audio' || kind === 'session');
	let dialogue = $derived(kind === 'audio' && $form.audioStyle === 'dialogue');
	/** The learner needs a voice of their own, so the tutor's voice is not offered. */
	let learnerVoices = $derived(catalog?.voices.filter((voice) => voice.voiceId !== voiceId) ?? []);
	let learnerVoiceId = $derived(
		offered(
			learnerVoices.map((voice) => voice.voiceId),
			$form.learnerVoiceId
		)
	);
	let speechModelId = $derived(
		offered(catalog?.models.map((model) => model.modelId) ?? [], $form.speechModelId)
	);
	let ready = $derived(
		!spoken || Boolean(voiceId && speechModelId && (!dialogue || learnerVoiceId))
	);
	async function loadCatalog() {
		catalogError = '';
		try {
			catalog = await api<SpeechCatalog>('/api/speech');
		} catch (cause) {
			catalogError = errorText(cause);
		}
	}
	onMount(() => {
		if (kind === 'audio' || kind === 'session') void loadCatalog();
	});

	async function generate(event: SubmitEvent) {
		event.preventDefault();
		if (busy || !ready || !(await editor.validateForm({ update: true })).valid) return;
		if (!materialIds.length) {
			error = 'Select at least one ready source.';
			return;
		}
		busy = true;
		error = '';
		notice = '';
		try {
			const { jobId } = await api<{ jobId: string }>(`/api/projects/${projectId}/generate`, {
				body: {
					...$form,
					modelId: availableModel(models, $form.modelId),
					voiceId,
					learnerVoiceId: dialogue ? learnerVoiceId : '',
					speechModelId,
					kind,
					materialIds
				}
			});
			activeJob = jobId;
			await onChanged();
			const job = await waitForJob(jobId, lifetime.signal, (running) => {
				notice = running.progress || 'Working with your sources…';
			});
			if (!job) return;
			notice = '';
			if (job.status === 'failed') error = job.error ?? 'Generation failed. Please try again.';
			else if (job.status === 'cancelled') notice = 'Generation cancelled.';
			else selectedId = job.outputId ?? '';
			await onChanged();
		} catch (cause) {
			error = errorText(cause);
		} finally {
			busy = false;
			activeJob = '';
		}
	}
	async function cancel() {
		try {
			await api(`/api/jobs/${activeJob}/cancel`, { body: {} });
		} catch (cause) {
			error = errorText(cause);
		}
	}
	onDestroy(() => lifetime.abort());
</script>

{#if selectedId}
	<div class="space-y-6">
		<Button variant="ghost" onclick={() => (selectedId = '')}><ArrowLeft />All {copy.many}</Button>
		{#key selectedId}<OutputViewer outputId={selectedId} {materials} />{/key}
	</div>
{:else}
	<div class="space-y-8">
		<div>
			<h2 class="text-xl font-medium">{copy.title}</h2>
			<p class="mt-2 text-sm leading-relaxed text-muted-foreground">{copy.intro}</p>
		</div>
		<form onsubmit={generate} class="space-y-4 border p-5" novalidate>
			<Form.Field form={editor} name="modelId">
				<Form.Control>
					{#snippet children({ props })}
						<Form.Label>{kind === 'audio' ? 'Script model' : 'Model'}</Form.Label>
						<ModelSelect {...props} {models} bind:value={$form.modelId} disabled={busy} />
					{/snippet}
				</Form.Control>
				{#if kind === 'session'}
					<Form.Description>Plans the session and gives the live feedback.</Form.Description>
				{/if}
				<Form.FieldErrors />
			</Form.Field>
			{#if kind === 'quiz'}
				<div class="grid gap-4 sm:grid-cols-2">
					<Form.Field form={editor} name="questionCount">
						<Form.Control>
							{#snippet children({ props })}
								<Form.Label>Questions</Form.Label>
								<Input
									{...props}
									type="number"
									min="1"
									max="50"
									bind:value={$form.questionCount}
									disabled={busy}
								/>
							{/snippet}
						</Form.Control>
						<Form.FieldErrors />
					</Form.Field>
					<Form.Field form={editor} name="questionMix">
						<Form.Control>
							{#snippet children({ props })}
								<Form.Label>Question types</Form.Label>
								<NativeSelect.Root
									{...props}
									class="w-full"
									bind:value={$form.questionMix}
									disabled={busy}
								>
									<NativeSelect.Option value="mixed"
										>Multiple choice and written</NativeSelect.Option
									>
									<NativeSelect.Option value="multiple_choice">Multiple choice</NativeSelect.Option>
									<NativeSelect.Option value="written">Written answers</NativeSelect.Option>
								</NativeSelect.Root>
							{/snippet}
						</Form.Control>
						<Form.FieldErrors />
					</Form.Field>
				</div>
			{/if}
			{#if spoken}
				<ErrorAlert message={catalogError} onRetry={loadCatalog} />
				<div class="grid gap-4 sm:grid-cols-2">
					{#if kind === 'audio'}
						<Form.Field form={editor} name="audioStyle" class="sm:col-span-2">
							<Form.Control>
								{#snippet children({ props })}
									<Form.Label>Style</Form.Label>
									<NativeSelect.Root
										{...props}
										class="w-full"
										bind:value={$form.audioStyle}
										disabled={busy}
									>
										{#each Object.entries(AUDIO_STYLES) as [value, style] (value)}
											<NativeSelect.Option {value}>{style.label}</NativeSelect.Option>
										{/each}
									</NativeSelect.Root>
								{/snippet}
							</Form.Control>
							<Form.FieldErrors />
						</Form.Field>
					{/if}
					{#snippet voiceOptions(voices: Voice[])}
						{#each voices as voice (voice.voiceId)}
							<NativeSelect.Option value={voice.voiceId}>
								{voice.description ? `${voice.name} · ${voice.description}` : voice.name}
							</NativeSelect.Option>
						{:else}
							<NativeSelect.Option value="">
								{catalog ? 'No voices available' : 'Loading voices…'}
							</NativeSelect.Option>
						{/each}
					{/snippet}
					<Form.Field form={editor} name="voiceId" class={[!dialogue && 'sm:col-span-2']}>
						<Form.Control>
							{#snippet children({ props })}
								<Form.Label
									>{kind === 'session'
										? 'Voice'
										: dialogue
											? 'Tutor voice'
											: 'Narrator voice'}</Form.Label
								>
								<NativeSelect.Root
									{...props}
									class="w-full"
									bind:value={() => voiceId, (next) => ($form.voiceId = next)}
									disabled={busy || !catalog}
								>
									{@render voiceOptions(catalog?.voices ?? [])}
								</NativeSelect.Root>
							{/snippet}
						</Form.Control>
						<Form.FieldErrors />
					</Form.Field>
					{#if dialogue}
						<Form.Field form={editor} name="learnerVoiceId">
							<Form.Control>
								{#snippet children({ props })}
									<Form.Label>Learner voice</Form.Label>
									<NativeSelect.Root
										{...props}
										class="w-full"
										bind:value={() => learnerVoiceId, (next) => ($form.learnerVoiceId = next)}
										disabled={busy || !catalog}
									>
										{@render voiceOptions(learnerVoices)}
									</NativeSelect.Root>
								{/snippet}
							</Form.Control>
							<Form.FieldErrors />
						</Form.Field>
					{/if}
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
						{#if kind === 'session'}
							<Form.Description>Flash models answer fastest.</Form.Description>
						{/if}
						<Form.FieldErrors />
					</Form.Field>
					{#if kind === 'audio'}
						<Form.Field form={editor} name="audioLength">
							<Form.Control>
								{#snippet children({ props })}
									<Form.Label>Length</Form.Label>
									<NativeSelect.Root
										{...props}
										class="w-full"
										bind:value={$form.audioLength}
										disabled={busy}
									>
										{#each Object.entries(AUDIO_LENGTHS) as [value, length] (value)}
											<NativeSelect.Option {value}>{length.label}</NativeSelect.Option>
										{/each}
									</NativeSelect.Root>
								{/snippet}
							</Form.Control>
							<Form.FieldErrors />
						</Form.Field>
					{:else}
						<Form.Field form={editor} name="sessionLength">
							<Form.Control>
								{#snippet children({ props })}
									<Form.Label>Length</Form.Label>
									<NativeSelect.Root
										{...props}
										class="w-full"
										bind:value={$form.sessionLength}
										disabled={busy}
									>
										{#each Object.entries(SESSION_LENGTHS) as [value, length] (value)}
											<NativeSelect.Option {value}>{length.label}</NativeSelect.Option>
										{/each}
									</NativeSelect.Root>
								{/snippet}
							</Form.Control>
							<Form.FieldErrors />
						</Form.Field>
					{/if}
				</div>
			{/if}
			<p class="text-xs text-muted-foreground">
				{plural(materialIds.length, 'source')} selected{models.length
					? ''
					: ' · Connect Muse in Settings to continue.'}
			</p>
			<div class="flex flex-wrap gap-2">
				<Button type="submit" disabled={busy || !ready || !materialIds.length || !models.length}>
					<Sparkles />{busy ? 'Generating…' : `Create ${copy.one}`}
				</Button>
				{#if activeJob}<Button variant="ghost" onclick={cancel}>Cancel</Button>{/if}
			</div>
			{#if notice}
				<p role="status" class="line-clamp-3 text-sm break-words text-muted-foreground">{notice}</p>
			{/if}
			{#if error}<p role="alert" class="text-sm text-destructive">{error}</p>{/if}
		</form>
		<section>
			<h3 class="mb-4 text-sm font-semibold">Saved {copy.many}</h3>
			{#if matching.length}
				<div class="divide-y border">
					{#each matching as output (output.id)}
						<button
							type="button"
							class="block w-full min-w-0 p-4 text-left hover:bg-muted/50"
							onclick={() => (selectedId = output.id)}
						>
							<span class="block truncate font-medium">{output.title}</span>
							<span class="mt-1 block text-xs text-muted-foreground">
								{dateLabel(output.createdAt)} · {plural(output.materialIds.length, 'source')}
							</span>
						</button>
					{/each}
				</div>
			{:else}
				<p class="border border-dashed p-5 text-sm text-muted-foreground">
					Your {copy.many} will appear here.
				</p>
			{/if}
		</section>
	</div>
{/if}
