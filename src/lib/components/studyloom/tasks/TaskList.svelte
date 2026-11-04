<script lang="ts">
	import { resolve } from '$app/paths';
	import { toast } from 'svelte-sonner';
	import { GraduationCap, Pencil } from '@lucide/svelte';
	import { Badge } from '#lib/components/ui/badge/index.js';
	import Button from '#lib/components/ui/button/button.svelte';
	import { Checkbox } from '#lib/components/ui/checkbox/index.js';
	import { dayLabel } from '#lib/calendar.js';
	import type { Task } from '#lib/domain.js';
	import { urgency } from '#lib/tasks.js';
	import { getTasks } from '#lib/tasks.svelte.js';
	import { errorText } from '#lib/ui.js';
	import TaskDialog from './TaskDialog.svelte';
	import UrgencyBadge from './UrgencyBadge.svelte';
	import { TONES } from './urgency.js';

	let {
		tasks: items,
		showProject = true,
		class: className = ''
	}: { tasks: Task[]; showProject?: boolean; class?: string } = $props();
	const tasks = getTasks();
	let now = $derived(tasks.clock.now);
	let editing = $state.raw<Task | null>(null);

	async function toggle(task: Task, done: boolean) {
		try {
			await tasks.setDone(task, done);
		} catch (cause) {
			toast.error(errorText(cause));
		}
	}
</script>

<ul class={['divide-y border', className]}>
	{#each items as task (task.id)}
		<li class={['flex items-start gap-3 border-l-4 p-3', TONES[urgency(task, now)].row]}>
			<Checkbox
				class="mt-1"
				bind:checked={() => Boolean(task.completedAt), (checked) => void toggle(task, checked)}
				disabled={tasks.busy === task.id}
				aria-label={task.completedAt ? `Reopen ${task.title}` : `Mark ${task.title} as done`}
			/>
			<div class="min-w-0 flex-1">
				<p class="flex flex-wrap items-center gap-1.5">
					<span
						class={[
							'font-medium break-words',
							task.completedAt && 'text-muted-foreground line-through'
						]}>{task.title}</span
					>
					{#if task.source === 'moodle'}
						<Badge variant="outline" class="gap-1 font-normal"><GraduationCap />Moodle</Badge>
					{/if}
				</p>
				{#if task.notes}
					<p class="line-clamp-1 text-sm text-muted-foreground">{task.notes}</p>
				{/if}
				<p class="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
					<UrgencyBadge {task} {now} />
					<span>{dayLabel(task.dueDate, now)}{task.dueTime ? `, ${task.dueTime}` : ''}</span>
					{#if showProject && task.projectId && task.projectName}
						<a
							href={resolve('/projects/[id]', { id: task.projectId })}
							class="truncate underline-offset-4 hover:underline">{task.projectName}</a
						>
					{/if}
				</p>
			</div>
			{#if task.source === 'custom'}
				<Button
					variant="ghost"
					size="icon"
					class="shrink-0"
					aria-label={`Edit ${task.title}`}
					onclick={() => (editing = task)}><Pencil /></Button
				>
			{/if}
		</li>
	{/each}
</ul>
{#if editing}
	{#key editing.id}
		<TaskDialog task={editing} onClose={() => (editing = null)} />
	{/key}
{/if}
