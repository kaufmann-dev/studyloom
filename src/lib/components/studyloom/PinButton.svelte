<script lang="ts">
	import { Pin, PinOff } from '@lucide/svelte';
	import { toast } from 'svelte-sonner';
	import Button, { type ButtonProps } from '$lib/components/ui/button/button.svelte';
	import type { Pin as SavedPin } from '$lib/domain';
	import type { Pins } from '$lib/pins.svelte';
	import { errorText } from '$lib/ui';

	let {
		pins,
		targetType,
		targetId,
		name,
		labelled = false,
		variant = 'ghost'
	}: {
		pins: Pins;
		targetType: SavedPin['targetType'];
		targetId: string;
		name: string;
		/** Shows "Pin"/"Unpin" next to the icon instead of an icon-only button. */
		labelled?: boolean;
		variant?: ButtonProps['variant'];
	} = $props();
	let pinned = $derived(Boolean(pins.find(targetType, targetId)));

	async function toggle() {
		try {
			await pins.toggle(targetType, targetId);
		} catch (cause) {
			toast.error(errorText(cause));
		}
	}
</script>

<Button
	{variant}
	size={labelled ? 'default' : 'icon'}
	aria-label={`${pinned ? 'Unpin' : 'Pin'} ${name}`}
	aria-pressed={pinned}
	disabled={pins.busy === targetId}
	onclick={toggle}
>
	{#if pinned}<PinOff />{:else}<Pin />{/if}
	{#if labelled}{pinned ? 'Unpin' : 'Pin'}{/if}
</Button>
