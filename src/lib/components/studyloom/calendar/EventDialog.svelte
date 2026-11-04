<script lang="ts">
	import { toast } from 'svelte-sonner';
	import type { z } from 'zod';
	import { GraduationCap, MapPin, RotateCcw, Trash2 } from '@lucide/svelte';
	import type { CalendarEvent, eventInput, Occurrence } from '#lib/domain.js';
	import Button from '#lib/components/ui/button/button.svelte';
	import * as Dialog from '#lib/components/ui/dialog/index.js';
	import * as ToggleGroup from '#lib/components/ui/toggle-group/index.js';
	import { dayLabel, timeRange } from '#lib/calendar.js';
	import type { Events } from '#lib/calendar.svelte.js';
	import EventForm from './EventForm.svelte';

	type Values = z.infer<typeof eventInput>;
	let {
		events,
		event,
		occurrence,
		initial = {},
		onClose
	}: {
		events: Events;
		/** The event to edit; a new event is created without it. */
		event?: CalendarEvent;
		/** The occurrence that was opened, when the event repeats. */
		occurrence?: Occurrence;
		/** Starting values for a new event. */
		initial?: Partial<Values>;
		onClose: () => void;
	} = $props();
	let repeating = $derived(Boolean(event && event.repeat !== 'none' && occurrence));
	let scope = $state<'one' | 'all'>('one');
	let single = $derived(repeating && scope === 'one');
	let form = $state<EventForm>();
	let values = $derived.by((): Values => {
		const source = single ? occurrence : event;
		return {
			title: source?.title ?? '',
			location: source?.location ?? '',
			notes: source?.notes ?? '',
			startDate: source?.startDate ?? initial.startDate ?? '',
			startTime: source ? (source.startTime ?? '') : (initial.startTime ?? '09:00'),
			endDate: source?.endDate ?? initial.endDate ?? initial.startDate ?? '',
			endTime: source ? (source.endTime ?? '') : (initial.endTime ?? '10:00'),
			repeat: single ? 'none' : (event?.repeat ?? 'none'),
			repeatUntil: single ? '' : (event?.repeatUntil ?? ''),
			projectId: event ? event.projectId : (initial.projectId ?? null)
		};
	});

	async function submit(next: Values) {
		if (!event) await events.create(next);
		else if (single && occurrence)
			await events.setException(event.id, occurrence.occurrenceDate, {
				title: next.title,
				location: next.location,
				notes: next.notes,
				startDate: next.startDate,
				startTime: next.startTime,
				endDate: next.endDate,
				endTime: next.endTime
			});
		else await events.update(event.id, next);
		onClose();
	}
	async function remove() {
		if (!event) return;
		if (single && occurrence)
			await events.setException(event.id, occurrence.occurrenceDate, { cancelled: true });
		else await events.remove(event.id);
		toast.success(single ? 'Event skipped.' : 'Event deleted.');
		onClose();
	}
	async function restore() {
		if (!event || !occurrence) return;
		await events.clearException(event.id, occurrence.occurrenceDate);
		onClose();
	}
</script>

{#snippet moodleEvent(synced: Occurrence)}
	<Dialog.Header>
		<Dialog.Title>{synced.title}</Dialog.Title>
		<Dialog.Description class="flex items-center gap-1.5">
			<GraduationCap class="size-4" />Synced from Moodle. Change it in Moodle.
		</Dialog.Description>
	</Dialog.Header>
	<dl class="space-y-2 text-sm">
		<div>
			<dt class="sr-only">When</dt>
			<dd>
				{dayLabel(synced.startDate)}{synced.endDate === synced.startDate
					? ''
					: ` – ${dayLabel(synced.endDate)}`} · {timeRange(synced)}
			</dd>
		</div>
		{#if synced.location}
			<div class="flex items-center gap-1.5">
				<dt><MapPin class="size-4" aria-label="Location" /></dt>
				<dd>{synced.location}</dd>
			</div>
		{/if}
		{#if synced.notes}
			<div>
				<dt class="sr-only">Notes</dt>
				<dd class="whitespace-pre-wrap text-muted-foreground">{synced.notes}</dd>
			</div>
		{/if}
	</dl>
	<Dialog.Footer>
		<Button variant="outline" onclick={onClose}>Close</Button>
	</Dialog.Footer>
{/snippet}

<Dialog.Root open onOpenChange={(open) => !open && onClose()}>
	<Dialog.Content class="max-h-[calc(100dvh-2rem)] overflow-y-auto sm:max-w-lg">
		{#if occurrence?.source === 'moodle'}
			{@render moodleEvent(occurrence)}
		{:else}
			<Dialog.Header>
				<Dialog.Title>{event ? 'Edit event' : 'New event'}</Dialog.Title>
				<Dialog.Description>Something that happens at a set time.</Dialog.Description>
			</Dialog.Header>
			{#if repeating}
				<div class="space-y-2">
					<ToggleGroup.Root
						type="single"
						variant="outline"
						class="w-full"
						aria-label="What to change"
						bind:value={() => scope, (next) => (scope = next === 'all' ? 'all' : 'one')}
					>
						<ToggleGroup.Item value="one" class="flex-1">Only this event</ToggleGroup.Item>
						<ToggleGroup.Item value="all" class="flex-1">All events</ToggleGroup.Item>
					</ToggleGroup.Root>
					{#if scope === 'all' && event?.exceptions.length}
						<p class="text-xs text-muted-foreground">
							Changing the first date or the repeat removes the changes made to single events.
						</p>
					{/if}
				</div>
			{/if}
			{#key scope}
				<EventForm
					bind:this={form}
					initial={values}
					series={!single}
					projectName={event?.projectName}
					submitLabel={event ? 'Save' : 'Add event'}
					onSubmit={submit}
					onCancel={onClose}
				>
					{#snippet actions(busy)}
						{#if event}
							<Button variant="outline" disabled={busy} onclick={() => form?.run(remove)}>
								<Trash2 />{single ? 'Skip this event' : repeating ? 'Delete all' : 'Delete'}
							</Button>
							{#if single && occurrence?.modified}
								<Button variant="ghost" disabled={busy} onclick={() => form?.run(restore)}>
									<RotateCcw />Restore original
								</Button>
							{/if}
						{/if}
					{/snippet}
				</EventForm>
			{/key}
		{/if}
	</Dialog.Content>
</Dialog.Root>
