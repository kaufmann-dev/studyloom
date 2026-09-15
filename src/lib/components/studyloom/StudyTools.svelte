<script lang="ts">
	import { onMount, untrack } from 'svelte';
	import { defaults, superForm } from 'sveltekit-superforms';
	import { zod4, zod4Client } from 'sveltekit-superforms/adapters';
	import { Sparkles, ArrowLeft } from '@lucide/svelte';
	import {
		generationInput,
		DEFAULT_MODEL,
		type StudyOutput,
		type Material,
		type MuseModel,
		type Job
	} from '$lib/domain';
	import * as Form from '$lib/components/ui/form';
	import Input from '$lib/components/ui/input/input.svelte';
	import Button from '$lib/components/ui/button/button.svelte';
	import OutputViewer from './OutputViewer.svelte';
	import { api, dateLabel, errorText } from '$lib/ui';
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
		kind: 'summary' | 'quiz';
		materialIds: string[];
		materials: Material[];
		models: MuseModel[];
		outputs: StudyOutput[];
		onChanged: () => void | Promise<void>;
	} = $props();
	const schema = generationInput.pick({ modelId: true, questionCount: true, questionMix: true });
	const editor = superForm(
		defaults({ modelId: DEFAULT_MODEL, questionCount: 10, questionMix: 'mixed' }, zod4(schema)),
		{
			validators: zod4Client(schema),
			SPA: true,
			id: untrack(() => `${kind}-generator-${projectId}`)
		}
	);
	const { form } = editor;
	let busy = $state(false);
	let error = $state('');
	let notice = $state('');
	let selectedId = $state('');
	let activeJob = $state('');
	let timer: ReturnType<typeof setTimeout> | undefined;
	let mounted = false;
	let selectedModel = $derived(
		models.find((model) => model.modelId === $form.modelId)?.modelId ??
			models[0]?.modelId ??
			DEFAULT_MODEL
	);
	let matching = $derived(outputs.filter((output) => output.kind === kind));
	async function poll(jobId: string) {
		try {
			const { job } = await api<{ job: Job }>(`/api/jobs/${jobId}`);
			if (!mounted) return;
			if (job.status === 'queued' || job.status === 'running') {
				notice = job.progress || 'Working with your sources…';
				timer = setTimeout(() => poll(jobId), 1500);
				return;
			}
			busy = false;
			activeJob = '';
			notice = '';
			if (job.status === 'failed') error = job.error ?? 'Generation failed. Please try again.';
			else if (job.status === 'cancelled') notice = 'Generation cancelled.';
			else selectedId = job.outputId ?? '';
			await onChanged();
		} catch (e) {
			error = errorText(e);
			busy = false;
			activeJob = '';
		}
	}
	async function generate(event: SubmitEvent) {
		event.preventDefault();
		if (busy || !(await editor.validateForm()).valid) return;
		if (!materialIds.length) {
			error = 'Select at least one ready source.';
			return;
		}
		busy = true;
		error = '';
		notice = '';
		try {
			const result = await api<{ jobId: string }>(`/api/projects/${projectId}/generate`, {
				...$form,
				modelId: selectedModel,
				kind,
				materialIds
			});
			activeJob = result.jobId;
			await onChanged();
			void poll(result.jobId);
		} catch (e) {
			error = errorText(e);
			busy = false;
		}
	}
	async function cancel() {
		try {
			await api(`/api/jobs/${activeJob}/cancel`, {});
		} catch (e) {
			error = errorText(e);
		}
	}
	onMount(() => {
		mounted = true;
		return () => {
			mounted = false;
			clearTimeout(timer);
		};
	});
</script>

{#if selectedId}<div class="space-y-6">
		<Button variant="ghost" onclick={() => (selectedId = '')}
			><ArrowLeft />All {kind === 'summary' ? 'summaries' : 'quizzes'}</Button
		>{#key selectedId}<OutputViewer outputId={selectedId} {materials} />{/key}
	</div>
{:else}<div class="space-y-8">
		<div>
			<h2 class="text-xl font-medium">
				{kind === 'summary' ? 'Build an overview' : 'Test your understanding'}
			</h2>
			<p class="mt-2 text-sm leading-relaxed text-muted-foreground">
				{kind === 'summary'
					? 'Turn your selected materials into an overview with references to the original sources.'
					: 'Create questions from your selected sources, then get feedback on multiple-choice and written answers.'}
			</p>
		</div>
		<form onsubmit={generate} class="space-y-4 border p-5">
			<Form.Field form={editor} name="modelId"
				><Form.Control
					>{#snippet children({ props })}<Form.Label>Model</Form.Label><select
							{...props}
							class="h-9 w-full border bg-background px-2 text-sm"
							disabled={busy}
							bind:value={() => selectedModel, (value) => ($form.modelId = value)}
							>{#if models.length}{#each models as model (model.modelId)}<option
										value={model.modelId}>{model.displayLabel}</option
									>{/each}{:else}<option value={DEFAULT_MODEL}>{DEFAULT_MODEL}</option>{/if}</select
						>{/snippet}</Form.Control
				><Form.FieldErrors /></Form.Field
			>
			{#if kind === 'quiz'}<div class="grid gap-4 sm:grid-cols-2">
					<Form.Field form={editor} name="questionCount"
						><Form.Control
							>{#snippet children({ props })}<Form.Label>Questions</Form.Label><Input
									{...props}
									type="number"
									min="1"
									max="50"
									bind:value={$form.questionCount}
									disabled={busy}
								/>{/snippet}</Form.Control
						><Form.FieldErrors /></Form.Field
					><Form.Field form={editor} name="questionMix"
						><Form.Control
							>{#snippet children({ props })}<Form.Label>Question types</Form.Label><select
									{...props}
									bind:value={$form.questionMix}
									class="h-9 w-full border bg-background px-2 text-sm"
									disabled={busy}
									><option value="mixed">Multiple choice and written</option><option
										value="multiple_choice">Multiple choice</option
									><option value="written">Written answers</option></select
								>{/snippet}</Form.Control
						><Form.FieldErrors /></Form.Field
					>
				</div>{/if}
			<p class="text-xs text-muted-foreground">
				{materialIds.length} source{materialIds.length === 1 ? '' : 's'} selected{!models.length
					? ' · Connect Muse in Settings to continue.'
					: ''}
			</p>
			<div class="flex flex-wrap gap-2">
				<Button type="submit" disabled={busy || !materialIds.length || !models.length}
					><Sparkles />{busy
						? 'Generating…'
						: `Create ${kind === 'summary' ? 'summary' : 'quiz'}`}</Button
				>{#if activeJob}<Button variant="ghost" onclick={cancel}>Cancel</Button>{/if}
			</div>
			{#if notice}<p role="status" class="text-sm text-muted-foreground">
					{notice}
				</p>{/if}{#if error}<p role="alert" class="text-sm text-destructive">{error}</p>{/if}
		</form>
		<section>
			<h3 class="mb-4 text-sm font-semibold">
				Saved {kind === 'summary' ? 'summaries' : 'quizzes'}
			</h3>
			{#if matching.length}<div class="divide-y border">
					{#each matching as output (output.id)}<button
							class="block w-full min-w-0 p-4 text-left hover:bg-muted/50"
							onclick={() => (selectedId = output.id)}
							><span class="block truncate font-medium">{output.title}</span><span
								class="mt-1 block text-xs text-muted-foreground"
								>{dateLabel(output.createdAt)} · {output.materialIds.length} sources</span
							></button
						>{/each}
				</div>{:else}<p class="border border-dashed p-5 text-sm text-muted-foreground">
					Your {kind === 'summary' ? 'summaries' : 'quizzes'} will appear here.
				</p>{/if}
		</section>
	</div>{/if}
