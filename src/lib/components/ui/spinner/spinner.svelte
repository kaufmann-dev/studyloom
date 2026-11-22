<script lang="ts">
	import Loader2Icon from '@lucide/svelte/icons/loader-2';
	import { cn } from '#lib/utils.js';
	import type { LucideProps } from '@lucide/svelte';

	// Only attributes that were passed reach the icon: an explicit `stroke={undefined}` would
	// replace Lucide's `currentColor` and leave the spinner invisible.
	let {
		class: className,
		role = 'status',
		'aria-label': ariaLabel = 'Loading',
		...restProps
	}: LucideProps = $props();
</script>

<Loader2Icon
	{role}
	aria-label={ariaLabel}
	class={cn('size-4 animate-spin', className)}
	{...restProps}
/>
