<script lang="ts">
	import * as AlertDialog from '#lib/components/ui/alert-dialog/index.js';
	import { errorText } from '#lib/ui.js';

	let {
		open = $bindable(false),
		title,
		description,
		confirmLabel = 'Delete',
		cancelLabel = 'Cancel',
		onConfirm
	}: {
		open?: boolean;
		title: string;
		description: string;
		confirmLabel?: string;
		cancelLabel?: string;
		/** The dialog closes once this resolves and shows the error if it rejects. */
		onConfirm: () => void | Promise<void>;
	} = $props();
	let busy = $state(false);
	let error = $state('');

	async function confirm() {
		busy = true;
		error = '';
		try {
			await onConfirm();
			open = false;
		} catch (cause) {
			error = errorText(cause);
		} finally {
			busy = false;
		}
	}
</script>

<AlertDialog.Root bind:open onOpenChange={() => (error = '')}>
	<AlertDialog.Content>
		<AlertDialog.Header>
			<AlertDialog.Title>{title}</AlertDialog.Title>
			<AlertDialog.Description>{description}</AlertDialog.Description>
		</AlertDialog.Header>
		{#if error}<p role="alert" class="text-sm text-destructive">{error}</p>{/if}
		<AlertDialog.Footer>
			<AlertDialog.Cancel disabled={busy}>{cancelLabel}</AlertDialog.Cancel>
			<AlertDialog.Action variant="destructive" disabled={busy} onclick={confirm}>
				{busy ? 'Working…' : confirmLabel}
			</AlertDialog.Action>
		</AlertDialog.Footer>
	</AlertDialog.Content>
</AlertDialog.Root>
