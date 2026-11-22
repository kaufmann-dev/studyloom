<script lang="ts">
	import { Badge } from '#lib/components/ui/badge/index.js';
	import type { Task } from '#lib/domain.js';
	import { dueLabel, taskSchedule, urgency } from '#lib/tasks.js';
	import { dateLabel } from '#lib/ui.js';
	import { TONES } from './urgency.js';

	let { task, now }: { task: Task; now: Date } = $props();
	let tone = $derived(TONES[urgency(task, now)]);
</script>

<Badge variant="outline" class={tone.badge} title={taskSchedule(task, now)}>
	<tone.icon />
	{task.completedAt ? `Done ${dateLabel(task.completedAt)}` : dueLabel(task, now)}
</Badge>
