import { createContext } from 'svelte';
import { createSubscriber } from 'svelte/reactivity';
import type { z } from 'zod';
import type { Task, taskInput, taskPatchInput } from './domain';
import { compareDue, isUrgent } from './tasks';
import { api, errorText } from './ui';

const MINUTE = 60_000;

/** The current time, re-read every minute wherever it is used reactively. */
export class Clock {
	#subscribe = createSubscriber((update) => {
		const timer = setInterval(update, MINUTE);
		return () => clearInterval(timer);
	});
	get now() {
		this.#subscribe();
		// A fresh value per read; nothing mutates it.
		// eslint-disable-next-line svelte/prefer-svelte-reactivity
		return new Date();
	}
}

/** The task lists shared by the navigation badge and every page that shows tasks. */
export class Tasks {
	readonly clock = new Clock();
	open = $state.raw<Task[]>([]);
	done = $state.raw<Task[]>([]);
	/** Id of the task whose change is in flight. */
	busy = $state<string | null>(null);
	/** False until the open tasks have been loaded once. */
	loaded = $state(false);
	/** Why the last load failed, for the pages that list tasks. */
	error = $state('');

	get urgentCount() {
		const now = this.clock.now;
		return this.open.filter((task) => isUrgent(task, now)).length;
	}
	/** Loads the open tasks; a failure is kept in `error` instead of being thrown. */
	async load() {
		try {
			this.open = (await api<{ tasks: Task[] }>('/api/tasks')).tasks;
			this.error = '';
		} catch (cause) {
			this.error = errorText(cause);
		} finally {
			this.loaded = true;
		}
	}
	async loadDone() {
		this.done = (await api<{ tasks: Task[] }>('/api/tasks?status=done')).tasks;
	}
	async create(input: z.input<typeof taskInput>) {
		const { task } = await api<{ task: Task }>('/api/tasks', { body: input });
		this.#place(task);
		return task;
	}
	async update(id: string, patch: z.input<typeof taskPatchInput>) {
		this.busy = id;
		try {
			const { task } = await api<{ task: Task }>(`/api/tasks/${id}`, {
				method: 'PATCH',
				body: patch
			});
			this.#place(task);
			return task;
		} finally {
			this.busy = null;
		}
	}
	setDone(task: Task, done: boolean) {
		return this.update(task.id, { done });
	}
	async remove(task: Task) {
		this.busy = task.id;
		try {
			await api(`/api/tasks/${task.id}`, { method: 'DELETE' });
			this.#drop(task.id);
		} finally {
			this.busy = null;
		}
	}
	#drop(id: string) {
		this.open = this.open.filter((item) => item.id !== id);
		this.done = this.done.filter((item) => item.id !== id);
	}
	#place(task: Task) {
		this.#drop(task.id);
		if (task.completedAt) this.done = [task, ...this.done];
		else this.open = [...this.open, task].sort(compareDue);
	}
}

export const [getTasks, setTasks] = createContext<Tasks>();
