import { Calendar, Check, CircleAlert, Clock } from '@lucide/svelte';
import type { Urgency } from '#lib/tasks.js';

const urgent = {
	icon: CircleAlert,
	row: 'border-l-destructive bg-destructive/5',
	badge: 'border-destructive/40 bg-destructive/10 text-destructive',
	chip: 'border-destructive/50 bg-destructive/10 text-destructive',
	line: 'border-destructive',
	dot: 'bg-destructive'
};
const neutral = {
	icon: Calendar,
	row: 'border-l-border',
	badge: 'border-border text-muted-foreground',
	chip: 'border-border bg-background text-foreground',
	line: 'border-muted-foreground',
	dot: 'bg-muted-foreground'
};

/** How each urgency looks. Red is reserved for tasks that need attention now. */
export const TONES: Record<Urgency, typeof urgent> = {
	overdue: urgent,
	today: urgent,
	soon: {
		icon: Clock,
		row: 'border-l-warning',
		badge: 'border-warning/40 bg-warning/10 text-warning',
		chip: 'border-warning/50 bg-warning/10 text-warning',
		line: 'border-warning',
		dot: 'bg-warning'
	},
	later: neutral,
	opening: neutral,
	done: {
		icon: Check,
		row: 'border-l-border',
		badge: 'border-border text-muted-foreground',
		chip: 'border-border bg-background text-muted-foreground line-through',
		line: 'border-muted-foreground',
		dot: 'bg-muted-foreground'
	}
};
