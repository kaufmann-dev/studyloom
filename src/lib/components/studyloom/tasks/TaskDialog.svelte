<script lang="ts">
	import { untrack } from 'svelte';
	import { toast } from 'svelte-sonner';
	import { defaults, superForm } from 'sveltekit-superforms';
	import { zod4, zod4Client } from 'sveltekit-superforms/adapters';
	import { Check, GraduationCap, RotateCcw, Trash2 } from '@lucide/svelte';
	import { taskInput, type Task } from '#lib/domain.js';
	import Button from '#lib/components/ui/button/button.svelte';
	import * as Dialog from '#lib/components/ui/dialog/index.js';
	import * as Form from '#lib/components/ui/form/index.js';
	import Input from '#lib/components/ui/input/input.svelte';
	import Textarea from '#lib/components/ui/textarea/textarea.svelte';
	import ConfirmDialog from '#lib/components/studyloom/ConfirmDialog.svelte';
	import ProjectSelect from '#lib/components/studyloom/ProjectSelect.svelte';
	import { dayLabel } from '#lib/calendar.js';
	import { dueLabel } from '#lib/tasks.js';
	import { getTasks } from '#lib/tasks.svelte.js';
	import { errorText } from '#lib/ui.js';

	let {
		task,
		initial = {},
		onClose
	}: {
		/** The task to edit; a new task is created without it. */
		task?: Task;
		/** Starting values for a new task. */
		initial?: { dueDate?: string; dueTime?: string; projectId?: string | null };
		onClose: () => void;
	} = $props();
	const tasks = getTasks();
	const editor = superForm(
		defaults(
			untrack(() => ({
				title: task?.title ?? '',
				notes: task?.notes ?? '',
				dueDate: task?.dueDate ?? initial.dueDate ?? '',
				dueTime: task?.dueTime ?? initial.dueTime ?? '',
				projectId: task ? task.projectId : (initial.projectId ?? null)
			})),
			zod4(taskInput)
		),
		{
			validators: zod4Client(taskInput),
			SPA: true,
			id: untrack(() => `task-${task?.id ?? 'new'}`)
		}
	);
	const { form } = editor;
	let busy = $state(false);
	let error = $state('');
	let confirmDelete = $state(false);

	async function attempt(work: () => Promise<unknown>) {
		busy = true;
		error = '';
		try {
			await work();
			onClose();
		} catch (cause) {
			error = errorText(cause);
		} finally {
			busy = false;
		}
	}
	async function save(event: SubmitEvent) {
		event.preventDefault();
		if (!(await editor.validateForm({ update: true })).valid) return;
		await attempt(() => (task ? tasks.update(task.id, $form) : tasks.create($form)));
	}
	async function remove() {
		if (!task) return;
		await tasks.remove(task);
		toast.success('Task deleted.');
		onClose();
	}
</script>

{#snippet doneButton(current: Task)}
	<Button
		variant="outline"
		disabled={busy}
		onclick={() => attempt(() => tasks.setDone(current, !current.completedAt))}
	>
		{#if current.completedAt}<RotateCcw />Reopen{:else}<Check />Mark as done{/if}
	</Button>
{/snippet}

{#snippet moodleTask(synced: Task)}
	<Dialog.Header>
		<Dialog.Title>{synced.title}</Dialog.Title>
		<Dialog.Description class="flex items-center gap-1.5">
			<GraduationCap class="size-4" />Synced from Moodle. Change it in Moodle.
		</Dialog.Description>
	</Dialog.Header>
	<p class="text-sm">
		Due {dayLabel(synced.dueDate)}{synced.dueTime ? `, ${synced.dueTime}` : ''}
		<span class="text-muted-foreground">· {dueLabel(synced, tasks.clock.now)}</span>
	</p>
	{#if synced.notes}
		<p class="text-sm whitespace-pre-wrap text-muted-foreground">{synced.notes}</p>
	{/if}
	{#if error}<p role="alert" class="text-sm text-destructive">{error}</p>{/if}
	<Dialog.Footer class="sm:justify-between">
		{@render doneButton(synced)}
		<Button variant="ghost" onclick={onClose}>Close</Button>
	</Dialog.Footer>
{/snippet}

<Dialog.Root open onOpenChange={(open) => !open && onClose()}>
	<Dialog.Content class="sm:max-w-lg">
		{#if task?.source === 'moodle'}
			{@render moodleTask(task)}
		{:else}
			<Dialog.Header>
				<Dialog.Title>{task ? 'Edit task' : 'New task'}</Dialog.Title>
				<Dialog.Description>Something to finish by a deadline.</Dialog.Description>
			</Dialog.Header>
			<form onsubmit={save} class="space-y-4" novalidate>
				<Form.Field form={editor} name="title">
					<Form.Control>
						{#snippet children({ props })}
							<Form.Label>Title</Form.Label>
							<Input
								{...props}
								bind:value={$form.title}
								placeholder="e.g. Hand in essay"
								autocomplete="off"
							/>
						{/snippet}
					</Form.Control>
					<Form.FieldErrors />
				</Form.Field>
				<div class="grid gap-4 sm:grid-cols-2">
					<Form.Field form={editor} name="dueDate">
						<Form.Control>
							{#snippet children({ props })}
								<Form.Label>Due date</Form.Label>
								<Input {...props} type="date" bind:value={$form.dueDate} />
							{/snippet}
						</Form.Control>
						<Form.FieldErrors />
					</Form.Field>
					<Form.Field form={editor} name="dueTime">
						<Form.Control>
							{#snippet children({ props })}
								<Form.Label>
									Time <span class="font-normal text-muted-foreground">(optional)</span>
								</Form.Label>
								<Input {...props} type="time" bind:value={$form.dueTime} />
							{/snippet}
						</Form.Control>
						<Form.FieldErrors />
					</Form.Field>
				</div>
				<Form.Field form={editor} name="projectId">
					<Form.Control>
						{#snippet children({ props })}
							<Form.Label>
								Project <span class="font-normal text-muted-foreground">(optional)</span>
							</Form.Label>
							<ProjectSelect
								{...props}
								bind:value={$form.projectId}
								currentName={task?.projectName}
							/>
						{/snippet}
					</Form.Control>
					<Form.FieldErrors />
				</Form.Field>
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
					<div class="flex flex-wrap gap-2">
						{#if task}
							{@render doneButton(task)}
							<Button
								variant="ghost"
								size="icon"
								aria-label="Delete task"
								disabled={busy}
								onclick={() => (confirmDelete = true)}><Trash2 /></Button
							>
						{/if}
					</div>
					<div class="flex gap-2">
						<Button variant="ghost" onclick={onClose}>Cancel</Button>
						<Button type="submit" disabled={busy}>
							{busy ? 'Saving…' : task ? 'Save' : 'Add task'}
						</Button>
					</div>
				</Dialog.Footer>
			</form>
		{/if}
	</Dialog.Content>
</Dialog.Root>
{#if task}
	<ConfirmDialog
		bind:open={confirmDelete}
		title="Delete this task?"
		description={`"${task.title}" will be removed for good.`}
		onConfirm={remove}
	/>
{/if}
