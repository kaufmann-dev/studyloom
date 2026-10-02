<script lang="ts">
	import { ListTodo, Plus } from '@lucide/svelte';
	import type { Task } from '#lib/domain.js';
	import Button from '#lib/components/ui/button/button.svelte';
	import * as Tabs from '#lib/components/ui/tabs/index.js';
	import ErrorAlert from '#lib/components/studyloom/ErrorAlert.svelte';
	import TaskDialog from '#lib/components/studyloom/tasks/TaskDialog.svelte';
	import TaskList from '#lib/components/studyloom/tasks/TaskList.svelte';
	import { urgency } from '#lib/tasks.js';
	import { getTasks } from '#lib/tasks.svelte.js';
	import { errorText, plural } from '#lib/ui.js';

	const tasks = getTasks();
	let loadingDone = $state(false);
	let doneError = $state('');
	let tab = $state('open');
	let creating = $state(false);
	let now = $derived(tasks.clock.now);
	let groups = $derived.by(() => {
		const by = (...states: string[]) =>
			tasks.open.filter((task: Task) => states.includes(urgency(task, now)));
		return [
			{ title: 'Do now', tasks: by('overdue', 'today') },
			{ title: 'Next 3 days', tasks: by('soon') },
			{ title: 'Later', tasks: by('later') }
		].filter((group) => group.tasks.length);
	});

	async function loadDone() {
		loadingDone = true;
		doneError = '';
		try {
			await tasks.loadDone();
		} catch (cause) {
			doneError = errorText(cause);
		} finally {
			loadingDone = false;
		}
	}
	function select(next: string) {
		tab = next;
		if (next === 'done') void loadDone();
	}
</script>

<svelte:head><title>Tasks · Studyloom</title></svelte:head>
<div class="mb-9 flex flex-wrap items-start justify-between gap-4">
	<div>
		<h1 class="text-3xl font-semibold tracking-tight">Tasks</h1>
		<p class="mt-2 text-muted-foreground">
			Everything with a deadline. Red is due now, amber within three days.
		</p>
	</div>
	<Button onclick={() => (creating = true)}><Plus />New task</Button>
</div>
<ErrorAlert message={tasks.error} onRetry={() => tasks.load()} class="mb-5" />
<ErrorAlert message={doneError} onRetry={loadDone} class="mb-5" />
<Tabs.Root bind:value={() => tab, select}>
	<Tabs.List class="mb-7">
		<Tabs.Trigger value="open">Open ({tasks.open.length})</Tabs.Trigger>
		<Tabs.Trigger value="done">Done</Tabs.Trigger>
	</Tabs.List>
	<Tabs.Content value="open">
		{#if !tasks.loaded}
			<p role="status" class="py-12 text-muted-foreground">Loading tasks…</p>
		{:else if tasks.open.length === 0}
			{#if !tasks.error}
				<div class="flex flex-col items-center border border-dashed px-6 py-16 text-center">
					<ListTodo class="mb-4 size-8 text-muted-foreground" />
					<h2 class="text-xl font-medium">Nothing due</h2>
					<p class="mt-2 max-w-md text-sm text-muted-foreground">
						Add a task with a deadline and it shows up here, on the home page and in the calendar.
					</p>
					<Button class="mt-6" onclick={() => (creating = true)}><Plus />Add a task</Button>
				</div>
			{/if}
		{:else}
			<div class="space-y-8">
				{#each groups as group (group.title)}
					<section aria-label={group.title}>
						<h2 class="mb-3 text-sm font-semibold">
							{group.title}
							<span class="font-normal text-muted-foreground">
								· {plural(group.tasks.length, 'task')}
							</span>
						</h2>
						<TaskList tasks={group.tasks} />
					</section>
				{/each}
			</div>
		{/if}
	</Tabs.Content>
	<Tabs.Content value="done">
		{#if loadingDone && tasks.done.length === 0}
			<p role="status" class="py-12 text-muted-foreground">Loading tasks…</p>
		{:else if tasks.done.length === 0}
			{#if !doneError}
				<p class="border border-dashed px-6 py-12 text-muted-foreground">
					Finished tasks are kept here.
				</p>
			{/if}
		{:else}
			<TaskList tasks={tasks.done} />
		{/if}
	</Tabs.Content>
</Tabs.Root>
{#if creating}<TaskDialog onClose={() => (creating = false)} />{/if}
