<script lang="ts">
	import { Ellipsis, FolderInput, Pencil, Trash2 } from '@lucide/svelte';
	import Button from '#lib/components/ui/button/button.svelte';
	import * as DropdownMenu from '#lib/components/ui/dropdown-menu/index.js';
	import type { LibraryEntry } from '#lib/domain.js';

	let {
		entry,
		onEdit,
		onMove,
		onDelete
	}: {
		entry: LibraryEntry;
		onEdit: (entry: LibraryEntry) => void;
		onMove: (entry: LibraryEntry) => void;
		onDelete: (entry: LibraryEntry) => void;
	} = $props();
</script>

<DropdownMenu.Root>
	<DropdownMenu.Trigger>
		{#snippet child({ props })}
			<Button {...props} variant="ghost" size="icon" aria-label={`Actions for ${entry.name}`}>
				<Ellipsis />
			</Button>
		{/snippet}
	</DropdownMenu.Trigger>
	<DropdownMenu.Content align="end" class="w-44">
		<DropdownMenu.Item onSelect={() => onEdit(entry)}>
			<Pencil />{entry.kind === 'file' ? 'Rename' : 'Edit'}
		</DropdownMenu.Item>
		<DropdownMenu.Item onSelect={() => onMove(entry)}>
			<FolderInput />Move to…
		</DropdownMenu.Item>
		<DropdownMenu.Separator />
		<DropdownMenu.Item variant="destructive" onSelect={() => onDelete(entry)}>
			<Trash2 />Delete
		</DropdownMenu.Item>
	</DropdownMenu.Content>
</DropdownMenu.Root>
