<script lang="ts">
	import type { Snippet } from 'svelte';
	import { untrack } from 'svelte';
	import { defaults, superForm } from 'sveltekit-superforms';
	import { zod4, zod4Client } from 'sveltekit-superforms/adapters';
	import type { z } from 'zod';
	import { eventInput, REPEAT_LABELS, type Repeat } from '#lib/domain.js';
	import Button from '#lib/components/ui/button/button.svelte';
	import * as Dialog from '#lib/components/ui/dialog/index.js';
	import * as Form from '#lib/components/ui/form/index.js';
	import Input from '#lib/components/ui/input/input.svelte';
	import { Label } from '#lib/components/ui/label/index.js';
	import * as NativeSelect from '#lib/components/ui/native-select/index.js';
	import { Switch } from '#lib/components/ui/switch/index.js';
	import Textarea from '#lib/components/ui/textarea/textarea.svelte';
	import ProjectSelect from '#lib/components/studyloom/ProjectSelect.svelte';
	import { errorText } from '#lib/ui.js';

	type Values = z.infer<typeof eventInput>;
	let {
		initial,
		series,
		projectName = null,
		submitLabel,
		onSubmit,
		onCancel,
		actions
	}: {
		initial: Values;
		/** Whether repeat and project can be set; a single occurrence has neither. */
		series: boolean;
		projectName?: string | null;
		submitLabel: string;
		onSubmit: (values: Values) => Promise<void>;
		onCancel: () => void;
		/** Extra buttons shown opposite Save. */
		actions?: Snippet<[boolean]>;
	} = $props();
	const uid = $props.id();
	const editor = superForm(
		defaults(
			untrack(() => initial),
			zod4(eventInput)
		),
		{ validators: zod4Client(eventInput), SPA: true, id: `event-${uid}` }
	);
	const { form } = editor;
	const repeats = Object.entries(REPEAT_LABELS) as [Repeat, string][];
	let allDay = $state(untrack(() => !initial.startTime));
	// Times are kept while the event is switched to all-day, so switching back restores them.
	let times = untrack(() => ({
		start: initial.startTime || '09:00',
		end: initial.endTime || '10:00'
	}));
	let busy = $state(false);
	let error = $state('');

	function setAllDay(next: boolean) {
		allDay = next;
		if (next) {
			times = { start: $form.startTime || times.start, end: $form.endTime || times.end };
			$form.startTime = '';
			$form.endTime = '';
		} else {
			$form.startTime = times.start;
			$form.endTime = times.end;
		}
	}
	function startChanged() {
		if ($form.startDate && $form.endDate < $form.startDate) $form.endDate = $form.startDate;
	}
	export async function run(work: () => Promise<void>) {
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
	async function save(event: SubmitEvent) {
		event.preventDefault();
		const result = await editor.validateForm({ update: true });
		if (!result.valid) return;
		// Cleared time fields would otherwise save the event as lasting all day.
		if (!allDay && !result.data.startTime) {
			error = 'Enter a start and end time, or switch on "All day".';
			return;
		}
		await run(() => onSubmit(result.data));
	}
</script>

<form onsubmit={save} class="space-y-4" novalidate>
	<Form.Field form={editor} name="title">
		<Form.Control>
			{#snippet children({ props })}
				<Form.Label>Title</Form.Label>
				<Input {...props} bind:value={$form.title} placeholder="e.g. Lecture" autocomplete="off" />
			{/snippet}
		</Form.Control>
		<Form.FieldErrors />
	</Form.Field>
	<div class="flex items-center gap-2">
		<Switch id="{uid}-all-day" checked={allDay} onCheckedChange={setAllDay} />
		<Label for="{uid}-all-day">All day</Label>
	</div>
	<div class="grid gap-4 sm:grid-cols-2">
		<Form.Field form={editor} name="startDate">
			<Form.Control>
				{#snippet children({ props })}
					<Form.Label>Starts</Form.Label>
					<Input {...props} type="date" bind:value={$form.startDate} onchange={startChanged} />
				{/snippet}
			</Form.Control>
			<Form.FieldErrors />
		</Form.Field>
		{#if !allDay}
			<Form.Field form={editor} name="startTime">
				<Form.Control>
					{#snippet children({ props })}
						<Form.Label>Start time</Form.Label>
						<Input {...props} type="time" bind:value={$form.startTime} />
					{/snippet}
				</Form.Control>
				<Form.FieldErrors />
			</Form.Field>
		{/if}
		<Form.Field form={editor} name="endDate">
			<Form.Control>
				{#snippet children({ props })}
					<Form.Label>Ends</Form.Label>
					<Input {...props} type="date" bind:value={$form.endDate} min={$form.startDate} />
				{/snippet}
			</Form.Control>
			<Form.FieldErrors />
		</Form.Field>
		{#if !allDay}
			<Form.Field form={editor} name="endTime">
				<Form.Control>
					{#snippet children({ props })}
						<Form.Label>End time</Form.Label>
						<Input {...props} type="time" bind:value={$form.endTime} />
					{/snippet}
				</Form.Control>
				<Form.FieldErrors />
			</Form.Field>
		{/if}
	</div>
	{#if series}
		<div class="grid gap-4 sm:grid-cols-2">
			<Form.Field form={editor} name="repeat">
				<Form.Control>
					{#snippet children({ props })}
						<Form.Label>Repeat</Form.Label>
						<NativeSelect.Root {...props} class="w-full" bind:value={$form.repeat}>
							{#each repeats as [value, label] (value)}
								<NativeSelect.Option {value}>{label}</NativeSelect.Option>
							{/each}
						</NativeSelect.Root>
					{/snippet}
				</Form.Control>
				<Form.FieldErrors />
			</Form.Field>
			{#if $form.repeat !== 'none'}
				<Form.Field form={editor} name="repeatUntil">
					<Form.Control>
						{#snippet children({ props })}
							<Form.Label>
								Until <span class="font-normal text-muted-foreground">(optional)</span>
							</Form.Label>
							<Input {...props} type="date" bind:value={$form.repeatUntil} min={$form.startDate} />
						{/snippet}
					</Form.Control>
					<Form.FieldErrors />
				</Form.Field>
			{/if}
		</div>
	{/if}
	<Form.Field form={editor} name="location">
		<Form.Control>
			{#snippet children({ props })}
				<Form.Label>
					Location <span class="font-normal text-muted-foreground">(optional)</span>
				</Form.Label>
				<Input {...props} bind:value={$form.location} autocomplete="off" />
			{/snippet}
		</Form.Control>
		<Form.FieldErrors />
	</Form.Field>
	{#if series}
		<Form.Field form={editor} name="projectId">
			<Form.Control>
				{#snippet children({ props })}
					<Form.Label>
						Project <span class="font-normal text-muted-foreground">(optional)</span>
					</Form.Label>
					<ProjectSelect {...props} bind:value={$form.projectId} currentName={projectName} />
				{/snippet}
			</Form.Control>
			<Form.FieldErrors />
		</Form.Field>
	{/if}
	<Form.Field form={editor} name="notes">
		<Form.Control>
			{#snippet children({ props })}
				<Form.Label>
					Notes <span class="font-normal text-muted-foreground">(optional)</span>
				</Form.Label>
				<Textarea {...props} bind:value={$form.notes} rows={2} />
			{/snippet}
		</Form.Control>
		<Form.FieldErrors />
	</Form.Field>
	{#if error}<p role="alert" class="text-sm text-destructive">{error}</p>{/if}
	<Dialog.Footer class="sm:justify-between">
		<div class="flex flex-wrap gap-2">{@render actions?.(busy)}</div>
		<div class="flex gap-2">
			<Button variant="ghost" onclick={onCancel}>Cancel</Button>
			<Button type="submit" disabled={busy}>{busy ? 'Saving…' : submitLabel}</Button>
		</div>
	</Dialog.Footer>
</form>
