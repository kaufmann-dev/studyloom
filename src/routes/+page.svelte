<script lang="ts">
	import { resolve } from '$app/paths';
	import { onMount } from 'svelte';
	import { toast } from 'svelte-sonner';
	import { CalendarPlus, FolderOpen, Library, PinOff, Plus } from '@lucide/svelte';
	import Button from '#lib/components/ui/button/button.svelte';
	import ErrorAlert from '#lib/components/studyloom/ErrorAlert.svelte';
	import EventDialog from '#lib/components/studyloom/calendar/EventDialog.svelte';
	import EventList from '#lib/components/studyloom/calendar/EventList.svelte';
	import TaskDialog from '#lib/components/studyloom/tasks/TaskDialog.svelte';
	import TaskList from '#lib/components/studyloom/tasks/TaskList.svelte';
	import { addDays, localDate, occurrences } from '#lib/calendar.js';
	import { Events } from '#lib/calendar.svelte.js';
	import type { Occurrence, Pin } from '#lib/domain.js';
	import { Pins } from '#lib/pins.svelte.js';
	import { getTasks } from '#lib/tasks.svelte.js';
	import { errorText, plural } from '#lib/ui.js';

	let { data }: { data: { session: { name: string } | null } } = $props();
	const VISIBLE_TASKS = 8;
	const VISIBLE_EVENTS = 6;
	const UPCOMING_DAYS = 7;
	const pins = new Pins();
	const tasks = getTasks();
	const events = new Events();
	let loading = $state(true);
	let error = $state('');
	let scheduleError = $state('');
	let addingTask = $state(false);
	/** The event dialog: an occurrence to edit, or `true` for a new event. */
	let eventOpen = $state.raw<Occurrence | true | null>(null);
	let now = $derived(tasks.clock.now);
	let today = $derived(localDate(now));
	let upcoming = $derived(
		occurrences(events.items, today, addDays(today, UPCOMING_DAYS)).slice(0, VISIBLE_EVENTS)
	);
	let firstName = $derived.by(() => {
		const name = data.session?.name.trim();
		return name && name !== 'Your workspace' ? name.split(/\s+/)[0] : 'there';
	});

	async function load() {
		loading = true;
		error = '';
		try {
			await pins.load();
		} catch (cause) {
			error = errorText(cause);
		} finally {
			loading = false;
		}
	}
	async function loadSchedule() {
		scheduleError = '';
		try {
			const start = localDate(new Date());
			await events.load(start, addDays(start, UPCOMING_DAYS));
		} catch (cause) {
			scheduleError = errorText(cause);
		}
	}
	async function unpin(pin: Pin) {
		try {
			await pins.remove(pin);
		} catch (cause) {
			toast.error(errorText(cause));
		}
	}

	onMount(() => {
		void load();
		void loadSchedule();
	});
</script>

<svelte:head><title>Home · Studyloom</title></svelte:head>
<h1 class="text-3xl font-semibold tracking-tight">Hello, {firstName}</h1>
<ErrorAlert message={tasks.error} onRetry={() => tasks.load()} class="mt-8" />
<ErrorAlert message={scheduleError} onRetry={loadSchedule} class="mt-8" />
<div class="mt-10 grid items-start gap-10 lg:grid-cols-2">
	<section aria-labelledby="tasks-heading" class="min-w-0">
		<div class="mb-5 flex items-center justify-between gap-3">
			<h2 id="tasks-heading" class="text-xl font-semibold">Tasks</h2>
			<Button variant="outline" size="sm" onclick={() => (addingTask = true)}>
				<Plus />Add task
			</Button>
		</div>
		{#if !tasks.loaded}
			<p role="status" class="py-10 text-muted-foreground">Loading tasks…</p>
		{:else if tasks.error}
			<!-- The alert above already explains the failure. -->
		{:else if tasks.open.length === 0}
			<p class="border border-dashed px-6 py-10 text-muted-foreground">
				Nothing due. Add a task to keep track of a deadline.
			</p>
		{:else}
			<TaskList tasks={tasks.open.slice(0, VISIBLE_TASKS)} />
			{#if tasks.open.length > VISIBLE_TASKS}
				<Button href={resolve('/tasks')} variant="link" class="mt-2 px-0">
					View all {plural(tasks.open.length, 'task')}
				</Button>
			{/if}
		{/if}
	</section>
	<section aria-labelledby="upcoming-heading" class="min-w-0">
		<div class="mb-5 flex items-center justify-between gap-3">
			<h2 id="upcoming-heading" class="text-xl font-semibold">Coming up</h2>
			<Button variant="outline" size="sm" onclick={() => (eventOpen = true)}>
				<CalendarPlus />Add event
			</Button>
		</div>
		{#if upcoming.length === 0}
			<p class="border border-dashed px-6 py-10 text-muted-foreground">
				No events in the next {UPCOMING_DAYS} days.
			</p>
		{:else}
			<EventList
				occurrences={upcoming}
				{now}
				showDay
				onSelect={(occurrence) => (eventOpen = occurrence)}
			/>
		{/if}
		<Button href={resolve('/calendar')} variant="link" class="mt-2 px-0">Open calendar</Button>
	</section>
</div>
{#if addingTask}
	<TaskDialog initial={{ dueDate: today }} onClose={() => (addingTask = false)} />
{/if}
{#if eventOpen}
	{@const occurrence = eventOpen === true ? undefined : eventOpen}
	<EventDialog
		{events}
		event={occurrence && events.find(occurrence.eventId)}
		{occurrence}
		initial={{ startDate: today, endDate: today }}
		onClose={() => (eventOpen = null)}
	/>
{/if}
<section aria-labelledby="pins-heading" class="mt-12">
	<h2 id="pins-heading" class="mb-5 text-xl font-semibold">Pinned</h2>
	<ErrorAlert message={error} onRetry={load} class="mb-5" />
	{#if loading}
		<p role="status" class="py-10 text-muted-foreground">Loading pins…</p>
	{:else if error}
		<!-- The alert above already explains the failure. -->
	{:else if pins.items.length === 0}
		<div class="border border-dashed px-6 py-12">
			<p class="text-muted-foreground">Pin projects or Library items to keep them close at hand.</p>
			<div class="mt-5 flex flex-wrap gap-2">
				<Button href={resolve('projects')} variant="outline"><FolderOpen />Browse projects</Button>
				<Button href={resolve('library')} variant="outline"><Library />Browse Library</Button>
			</div>
		</div>
	{:else}
		<ul class="grid gap-4 sm:grid-cols-2">
			{#each pins.items as pin (pin.id)}
				<li
					class="relative flex min-w-0 items-start justify-between gap-3 border p-5 hover:bg-muted/40"
				>
					<a
						href={resolve(pin.targetType === 'project' ? '/projects/[id]' : '/library/[id]', {
							id: pin.targetId
						})}
						class="min-w-0 flex-1 outline-none after:absolute after:inset-0 focus-visible:after:ring-2 focus-visible:after:ring-ring focus-visible:after:ring-inset"
					>
						<p class="truncate font-semibold">{pin.label}</p>
						<p class="mt-1 truncate text-sm text-muted-foreground">{pin.subtitle}</p>
					</a>
					<Button
						variant="ghost"
						size="icon"
						class="relative shrink-0"
						aria-label={`Unpin ${pin.label}`}
						disabled={pins.busy === pin.targetId}
						onclick={() => unpin(pin)}><PinOff /></Button
					>
				</li>
			{/each}
		</ul>
	{/if}
</section>
