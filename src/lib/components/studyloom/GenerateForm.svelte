<script lang="ts">
	import { onMount, untrack } from 'svelte';
	import { toast } from 'svelte-sonner';
	import { defaults, superForm } from 'sveltekit-superforms';
	import { zod4, zod4Client } from 'sveltekit-superforms/adapters';
	import { Sparkles } from '@lucide/svelte';
	import {
		AUDIO_STYLES,
		COVERAGES,
		QUESTION_STYLES,
		QUESTION_STYLE_NAMES,
		generationInput,
		DEFAULT_MODEL,
		type QuestionStyle,
		type StudyOutput,
		type ClaudeModel,
		type SpeechModel,
		type Voice
	} from '#lib/domain.js';
	import Button from '#lib/components/ui/button/button.svelte';
	import { Checkbox } from '#lib/components/ui/checkbox/index.js';
	import * as Form from '#lib/components/ui/form/index.js';
	import * as NativeSelect from '#lib/components/ui/native-select/index.js';
	import { Switch } from '#lib/components/ui/switch/index.js';
	import { STUDY_TOOLS } from '#lib/study-tools.js';
	import { api, errorText } from '#lib/ui.js';
	import ErrorAlert from './ErrorAlert.svelte';
	import ModelSelect, { availableModel } from './ModelSelect.svelte';

	/** The options for creating one kind of study tool; the result arrives through the job list. */
	let {
		projectId,
		kind,
		materialIds,
		models,
		onCreated
	}: {
		projectId: string;
		kind: StudyOutput['kind'];
		materialIds: string[];
		models: ClaudeModel[];
		/** Called once the job is queued. */
		onCreated: () => void | Promise<void>;
	} = $props();
	const schema = generationInput.pick({
		modelId: true,
		coverage: true,
		questionStyles: true,
		voiceId: true,
		learnerVoiceId: true,
		speechModelId: true,
		audioStyle: true,
		voiceMode: true,
		illustrations: true
	});
	const editor = superForm(
		defaults(
			{
				modelId: DEFAULT_MODEL,
				coverage: 'standard',
				questionStyles: [...QUESTION_STYLE_NAMES],
				voiceId: '',
				learnerVoiceId: '',
				speechModelId: '',
				audioStyle: 'narration',
				voiceMode: 'off',
				illustrations: false
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
	let busy = $state(false);
	let error = $state('');
	let copy = $derived(STUDY_TOOLS[kind]);

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
	let spoken = $derived(
		kind === 'audio' || kind === 'session' || (kind === 'lesson' && $form.voiceMode !== 'off')
	);
	/** Whether illustrations can be generated: the server has a Gemini key. */
	let canIllustrate = $state(false);
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
		if (kind === 'lesson')
			void api<{ available: boolean }>('/api/illustrations')
				.then((result) => (canIllustrate = result.available))
				.catch(() => {});
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
		try {
			await api(`/api/projects/${projectId}/generate`, {
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
			toast.success(`Creating your ${copy.one}. It appears here when it is ready.`);
			await onCreated();
		} catch (cause) {
			error = errorText(cause);
		} finally {
			busy = false;
		}
	}
</script>

<form onsubmit={generate} class="space-y-4" novalidate>
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
	{#if kind !== 'summary'}
		<Form.Field form={editor} name="coverage">
			<Form.Control>
				{#snippet children({ props })}
					<Form.Label>Coverage</Form.Label>
					<NativeSelect.Root {...props} class="w-full" bind:value={$form.coverage} disabled={busy}>
						{#each Object.entries(COVERAGES) as [value, coverage] (value)}
							<NativeSelect.Option {value}>{coverage.label} · {coverage.hint}</NativeSelect.Option>
						{/each}
					</NativeSelect.Root>
				{/snippet}
			</Form.Control>
			<Form.Description>The size follows from how much your sources contain.</Form.Description>
			<Form.FieldErrors />
		</Form.Field>
	{/if}
	{#if kind === 'quiz' || kind === 'lesson'}
		<Form.Fieldset form={editor} name="questionStyles" class="space-y-2">
			<Form.Legend>Question types</Form.Legend>
			{#each Object.entries(QUESTION_STYLES) as [value, label] (value)}
				{@const style = value as QuestionStyle}
				<Form.Control>
					{#snippet children({ props })}
						<div class="flex items-center gap-2">
							<Checkbox
								{...props}
								value={style}
								disabled={busy}
								checked={$form.questionStyles.includes(style)}
								onCheckedChange={(checked) =>
									($form.questionStyles = checked
										? [...$form.questionStyles, style]
										: $form.questionStyles.filter((item) => item !== style))}
							/>
							<Form.Label class="font-normal">{label}</Form.Label>
						</div>
					{/snippet}
				</Form.Control>
			{/each}
			<Form.Description>Exercises found in your sources keep their own format.</Form.Description>
			<Form.FieldErrors />
		</Form.Fieldset>
	{/if}
	{#if kind === 'lesson'}
		<Form.Field form={editor} name="voiceMode">
			<Form.Control>
				{#snippet children({ props })}
					<Form.Label>Voice</Form.Label>
					<NativeSelect.Root
						{...props}
						class="w-full"
						bind:value={$form.voiceMode}
						disabled={busy}
						onchange={() => {
							if ($form.voiceMode !== 'off' && !catalog) void loadCatalog();
						}}
					>
						<NativeSelect.Option value="off"
							>Off · read the explanations as text</NativeSelect.Option
						>
						<NativeSelect.Option value="onDemand"
							>On demand · voice each explanation when you first play it</NativeSelect.Option
						>
						<NativeSelect.Option value="all"
							>Everything now · voice all explanations in advance</NativeSelect.Option
						>
					</NativeSelect.Root>
				{/snippet}
			</Form.Control>
			<Form.Description
				>You can add, change or remove the voice later in the lesson.</Form.Description
			>
			<Form.FieldErrors />
		</Form.Field>
		<Form.Field form={editor} name="illustrations">
			<Form.Control>
				{#snippet children({ props })}
					<div class="flex items-center justify-between gap-3">
						<Form.Label>Generate illustrations</Form.Label>
						<Switch
							{...props}
							bind:checked={$form.illustrations}
							disabled={busy || !canIllustrate}
						/>
					</div>
				{/snippet}
			</Form.Control>
			<Form.Description>
				{canIllustrate
					? 'Figures from your sources come first; a picture is generated only where none fits.'
					: 'Slides use the figures of your sources. Set GEMINI_API_KEY to generate more.'}
			</Form.Description>
			<Form.FieldErrors />
		</Form.Field>
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
							>{kind === 'session' || kind === 'lesson'
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
		</div>
	{/if}
	{#if !models.length}
		<p class="text-xs text-muted-foreground">Set up Claude in Settings to continue.</p>
	{/if}
	<div class="flex flex-wrap gap-2">
		<Button type="submit" disabled={busy || !ready || !materialIds.length || !models.length}>
			<Sparkles />{busy ? 'Starting…' : `Create ${copy.one}`}
		</Button>
	</div>
	{#if error}<p role="alert" class="text-sm text-destructive">{error}</p>{/if}
</form>
