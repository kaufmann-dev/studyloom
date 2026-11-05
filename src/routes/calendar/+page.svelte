<script lang="ts">
	import { afterNavigate, goto } from '$app/navigation';
	import { resolve } from '$app/paths';
	import { page } from '$app/state';
	import {
		CalendarPlus,
		ChevronLeft,
		ChevronRight,
		Download,
		Ellipsis,
		GraduationCap,
		ListPlus,
		Plus,
		Upload
	} from '@lucide/svelte';
	import type { MoodleCalendar, Occurrence, Task } from '#lib/domain.js';
	import Button from '#lib/components/ui/button/button.svelte';
	import * as DropdownMenu from '#lib/components/ui/dropdown-menu/index.js';
	import { Toggle } from '#lib/components/ui/toggle/index.js';
	import * as ToggleGroup from '#lib/components/ui/toggle-group/index.js';
	import ErrorAlert from '#lib/components/studyloom/ErrorAlert.svelte';
	import AgendaView from '#lib/components/studyloom/calendar/AgendaView.svelte';
	import DayDialog from '#lib/components/studyloom/calendar/DayDialog.svelte';
	import EventDialog from '#lib/components/studyloom/calendar/EventDialog.svelte';
	import ImportDialog from '#lib/components/studyloom/calendar/ImportDialog.svelte';
	import MonthView from '#lib/components/studyloom/calendar/MonthView.svelte';
	import WeekView from '#lib/components/studyloom/calendar/WeekView.svelte';
	import TaskDialog from '#lib/components/studyloom/tasks/TaskDialog.svelte';
	import {
		addDays,
		addMinutes,
		addMonths,
		dateOf,
		dayLabel,
		localDate,
		monthGrid,
		occurrences,
		onDay,
		weekDays
	} from '#lib/calendar.js';
	import { Events } from '#lib/calendar.svelte.js';
	import { IsMobile } from '#lib/hooks/is-mobile.svelte.js';
	import { getTasks } from '#lib/tasks.svelte.js';
	import { api, errorText, timeAgo } from '#lib/ui.js';

	const VIEWS = { month: 'Month', week: 'Week', agenda: 'Agenda' } as const;
	type View = keyof typeof VIEWS;
	const AGENDA_STEP = 30;
	type Open =
		| { kind: 'day'; date: string }
		| { kind: 'event'; occurrence?: Occurrence; date?: string; time?: string }
		| { kind: 'task'; task?: Task; date?: string }
		| { kind: 'import' };

	const tasks = getTasks();
	const events = new Events();
	const mobile = new IsMobile();
	// The first weekday follows the browser's region, which is unknown until the page runs there.
	let locale = $state('en-US');
	let ready = $state(false);
	let error = $state('');
	let showTasks = $state(true);
	let agendaDays = $state(AGENDA_STEP);
	let open = $state.raw<Open | null>(null);
	let moodle = $state.raw<MoodleCalendar | null>(null);

	let now = $derived(tasks.clock.now);
	let today = $derived(localDate(now));
	let anchor = $derived.by(() => {
		const date = page.url.searchParams.get('date') ?? '';
		return /^\d{4}-\d{2}-\d{2}$/.test(date) && !Number.isNaN(dateOf(date).getTime()) ? date : today;
	});
	let view = $derived.by((): View => {
		const chosen = page.url.searchParams.get('view');
		if (chosen && chosen in VIEWS) return chosen as View;
		return mobile.current ? 'agenda' : 'month';
	});
	let weeks = $derived(monthGrid(anchor, locale));
	let week = $derived(weekDays(anchor, locale));
	// One range covers every view of the current date, so switching views needs no request.
	let range = $derived({
		from: [weeks[0][0], week[0], anchor].sort()[0],
		to: [weeks.at(-1)!.at(-1)!, week[6], addDays(anchor, agendaDays - 1)].sort().at(-1)!
	});
	let shown = $derived(occurrences(events.items, range.from, range.to));
	let visibleTasks = $derived(showTasks ? tasks.open : []);
	let heading = $derived.by(() => {
		if (view === 'month')
			return dateOf(anchor).toLocaleDateString(undefined, { month: 'long', year: 'numeric' });
		if (view === 'week') return `${dayLabel(week[0], now)} – ${dayLabel(week[6], now)}`;
		return `From ${dayLabel(anchor, now)}`;
	});
	let editing = $derived(
		open?.kind === 'event' && open.occurrence ? events.find(open.occurrence.eventId) : undefined
	);

	async function load() {
		error = '';
		// The sync status is a footnote; a failure to read it must not hide the calendar.
		api<MoodleCalendar>('/api/calendar/moodle').then(
			(status) => (moodle = status),
			() => (moodle = null)
		);
		try {
			await events.load(range.from, range.to);
		} catch (cause) {
			error = errorText(cause);
		} finally {
			ready = true;
		}
	}
	function show(nextView: View, date: string) {
		const query = new URLSearchParams({ view: nextView, date });
		// The rule cannot follow the query string appended to the resolve()-built path.
		// eslint-disable-next-line svelte/no-navigation-without-resolve
		return goto(`${resolve('/calendar')}?${query}`, { reset: false });
	}
	function step(direction: 1 | -1) {
		if (view === 'month') return show(view, addMonths(anchor, direction));
		return show(view, addDays(anchor, direction * (view === 'week' ? 7 : AGENDA_STEP)));
	}
	function more() {
		agendaDays += AGENDA_STEP;
		void load();
	}
	async function refresh() {
		await Promise.all([tasks.load(), events.reload()]);
	}

	afterNavigate(() => {
		locale = navigator.language;
		agendaDays = AGENDA_STEP;
		void load();
	});
</script>

<svelte:head><title>Calendar · Studyloom</title></svelte:head>
<div class="mb-6 flex flex-wrap items-center justify-between gap-3">
	<h1 class="text-3xl font-semibold tracking-tight">Calendar</h1>
	<div class="flex items-center gap-2">
		<DropdownMenu.Root>
			<DropdownMenu.Trigger>
				{#snippet child({ props })}
					<Button {...props}><Plus />New</Button>
				{/snippet}
			</DropdownMenu.Trigger>
			<DropdownMenu.Content align="end" class="w-44">
				<DropdownMenu.Item onSelect={() => (open = { kind: 'event', date: anchor })}>
					<CalendarPlus />Event
				</DropdownMenu.Item>
				<DropdownMenu.Item onSelect={() => (open = { kind: 'task', date: anchor })}>
					<ListPlus />Task
				</DropdownMenu.Item>
			</DropdownMenu.Content>
		</DropdownMenu.Root>
		<DropdownMenu.Root>
			<DropdownMenu.Trigger>
				{#snippet child({ props })}
					<Button {...props} variant="outline" size="icon" aria-label="More calendar actions">
						<Ellipsis />
					</Button>
				{/snippet}
			</DropdownMenu.Trigger>
			<DropdownMenu.Content align="end" class="w-48">
				<DropdownMenu.Item onSelect={() => (open = { kind: 'import' })}>
					<Upload />Import .ics…
				</DropdownMenu.Item>
				<DropdownMenu.Item>
					{#snippet child({ props })}
						<a
							{...props}
							href={resolve('/api/[...path]', { path: 'calendar/export' })}
							download="studyloom.ics"
						>
							<Download />Export .ics
						</a>
					{/snippet}
				</DropdownMenu.Item>
			</DropdownMenu.Content>
		</DropdownMenu.Root>
	</div>
</div>
<div class="mb-5 flex flex-wrap items-center justify-between gap-3">
	<div class="flex items-center gap-1">
		<Button variant="outline" onclick={() => show(view, today)}>Today</Button>
		<Button variant="ghost" size="icon" aria-label="Earlier" onclick={() => step(-1)}
			><ChevronLeft /></Button
		>
		<Button variant="ghost" size="icon" aria-label="Later" onclick={() => step(1)}
			><ChevronRight /></Button
		>
		<h2 class="ml-2 text-lg font-semibold" aria-live="polite">{heading}</h2>
	</div>
	<div class="flex items-center gap-2">
		<Toggle variant="outline" bind:pressed={showTasks} aria-label="Show tasks">Tasks</Toggle>
		<ToggleGroup.Root
			type="single"
			variant="outline"
			aria-label="Calendar view"
			bind:value={() => view, (next) => next && next in VIEWS && void show(next as View, anchor)}
		>
			{#each Object.entries(VIEWS) as [value, label] (value)}
				<ToggleGroup.Item {value}>{label}</ToggleGroup.Item>
			{/each}
		</ToggleGroup.Root>
	</div>
</div>
<ErrorAlert message={error} onRetry={load} class="mb-5" />
{#if moodle?.connected}
	{#if moodle.lastError}
		<ErrorAlert message={`Moodle sync failed: ${moodle.lastError}`} class="mb-5" />
	{:else if moodle.lastSyncedAt}
		<p class="mb-5 flex items-center gap-1.5 text-sm text-muted-foreground">
			<GraduationCap class="size-4" />Moodle synced {timeAgo(moodle.lastSyncedAt, now)}
		</p>
	{/if}
{/if}
{#if !ready}
	<p role="status" class="py-12 text-muted-foreground">Loading calendar…</p>
{:else if view === 'month'}
	<MonthView
		{weeks}
		{anchor}
		occurrences={shown}
		tasks={visibleTasks}
		{now}
		onOpenDay={(date) => (open = { kind: 'day', date })}
		onEvent={(occurrence) => (open = { kind: 'event', occurrence })}
		onTask={(task) => (open = { kind: 'task', task })}
	/>
{:else if view === 'week'}
	{#if mobile.current}
		<div class="mb-3 grid grid-cols-7 gap-1" role="group" aria-label="Day of the week">
			{#each week as date (date)}
				<Button
					variant={date === anchor ? 'default' : 'outline'}
					class="h-auto flex-col gap-0 px-0 py-1.5 text-xs"
					aria-pressed={date === anchor}
					aria-label={dayLabel(date, now)}
					onclick={() => show('week', date)}
				>
					<span>{dateOf(date).toLocaleDateString(undefined, { weekday: 'narrow' })}</span>
					<span class="font-semibold">{Number(date.slice(8))}</span>
				</Button>
			{/each}
		</div>
	{/if}
	<WeekView
		days={mobile.current ? [anchor] : week}
		occurrences={shown}
		tasks={visibleTasks}
		{now}
		onOpenDay={(date) => (open = { kind: 'day', date })}
		onEvent={(occurrence) => (open = { kind: 'event', occurrence })}
		onTask={(task) => (open = { kind: 'task', task })}
		onSlot={(date, time) => (open = { kind: 'event', date, time })}
	/>
{:else}
	<AgendaView
		from={anchor}
		days={agendaDays}
		occurrences={shown}
		tasks={visibleTasks}
		{now}
		onEvent={(occurrence) => (open = { kind: 'event', occurrence })}
		onMore={more}
	/>
{/if}

{#if open?.kind === 'day'}
	{@const date = open.date}
	<DayDialog
		{date}
		occurrences={shown.filter((occurrence) => onDay(occurrence, date))}
		tasks={visibleTasks.filter((task) => task.dueDate === date)}
		{now}
		onEvent={(occurrence) => (open = { kind: 'event', occurrence })}
		onAddEvent={() => (open = { kind: 'event', date })}
		onAddTask={() => (open = { kind: 'task', date })}
		onClose={() => (open = null)}
	/>
{:else if open?.kind === 'event'}
	{@const start = open.time ?? '09:00'}
	{@const end = addMinutes(open.date ?? anchor, start, 60)}
	<EventDialog
		{events}
		event={editing}
		occurrence={open.occurrence}
		initial={{
			startDate: open.date ?? anchor,
			startTime: start,
			endDate: end.date,
			endTime: end.time
		}}
		onClose={() => (open = null)}
	/>
{:else if open?.kind === 'task'}
	<TaskDialog
		task={open.task}
		initial={{ dueDate: open.date ?? anchor }}
		onClose={() => (open = null)}
	/>
{:else if open?.kind === 'import'}
	<ImportDialog onImported={refresh} onClose={() => (open = null)} />
{/if}
