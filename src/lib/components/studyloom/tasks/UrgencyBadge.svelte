<script lang="ts">
	import { Badge } from '#lib/components/ui/badge/index.js';
	import { dayLabel } from '#lib/calendar.js';
	import type { Task } from '#lib/domain.js';
	import { dueLabel, urgency } from '#lib/tasks.js';
	import { dateLabel } from '#lib/ui.js';
	import { TONES } from './urgency.js';

	let { task, now }: { task: Task; now: Date } = $props();
	let tone = $derived(TONES[urgency(task, now)]);
	let exact = $derived(
		`Due ${dayLabel(task.dueDate, now)}${task.dueTime ? `, ${task.dueTime}` : ''}`
	);
</script>

<Badge variant="outline" class={tone.badge} title={exact}>
	<tone.icon />
	{task.completedAt ? `Done ${dateLabel(task.completedAt)}` : dueLabel(task, now)}
</Badge>
