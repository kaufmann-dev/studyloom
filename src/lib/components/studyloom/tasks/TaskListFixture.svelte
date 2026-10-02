<script lang="ts">
	import { untrack } from 'svelte';
	import type { Task } from '#lib/domain.js';
	import { setTasks, Tasks } from '#lib/tasks.svelte.js';
	import TaskList from './TaskList.svelte';

	// Supplies the task context the root layout provides, so the list can be tested alone.
	let { tasks: items }: { tasks: Task[] } = $props();
	const tasks = setTasks(new Tasks());
	tasks.open = untrack(() => items);
</script>

<TaskList tasks={tasks.open} />
