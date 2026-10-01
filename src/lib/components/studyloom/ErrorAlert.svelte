<script lang="ts">
	import { CircleAlert } from '@lucide/svelte';
	import * as Alert from '$lib/components/ui/alert';
	import Button from '$lib/components/ui/button/button.svelte';

	let {
		message,
		onRetry,
		class: className = ''
	}: { message: string; onRetry?: () => void; class?: string } = $props();
</script>

{#if message}
	<Alert.Root variant="destructive" class={className}>
		<CircleAlert />
		<Alert.Description>{message}</Alert.Description>
		{#if onRetry}
			<Alert.Action class="top-1.5">
				<Button variant="ghost" size="sm" onclick={onRetry}>Retry</Button>
			</Alert.Action>
		{/if}
	</Alert.Root>
{/if}
