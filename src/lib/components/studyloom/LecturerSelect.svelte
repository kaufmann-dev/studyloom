<script lang="ts">
	import { onMount } from 'svelte';
	import type { Popover as PopoverPrimitive } from 'bits-ui';
	import { resolve } from '$app/paths';
	import { ChevronsUpDown, X } from '@lucide/svelte';
	import type { ProjectLecturer } from '#lib/domain.js';
	import Badge from '#lib/components/ui/badge/badge.svelte';
	import { buttonVariants } from '#lib/components/ui/button/index.js';
	import * as Command from '#lib/components/ui/command/index.js';
	import * as Popover from '#lib/components/ui/popover/index.js';
	import { api } from '#lib/ui.js';
	import { cn } from '#lib/utils.js';

	let {
		value = $bindable(),
		selected = [],
		...rest
	}: Omit<PopoverPrimitive.TriggerProps, 'value' | 'children' | 'child'> & {
		/** Contact ids, in the order they were picked. */
		value: string[];
		/** The lecturers already saved, so their names show before the contacts load. */
		selected?: ProjectLecturer[];
	} = $props();
	let contacts = $state.raw<ProjectLecturer[] | null>(null);
	let open = $state(false);

	const nameOf = (id: string) =>
		contacts?.find((contact) => contact.id === id)?.name ??
		selected.find((lecturer) => lecturer.id === id)?.name ??
		'Unknown contact';

	function toggle(id: string) {
		value = value.includes(id) ? value.filter((other) => other !== id) : [...value, id];
	}

	onMount(async () => {
		// Without the list only the lecturers already chosen are shown.
		contacts = await api<{ contacts: ProjectLecturer[] }>('/api/library/contacts')
			.then((result) => result.contacts)
			.catch(() => []);
	});
</script>

<div class="space-y-2">
	<Popover.Root bind:open>
		<Popover.Trigger
			{...rest}
			role="combobox"
			class={cn(
				buttonVariants({ variant: 'outline' }),
				'w-full justify-between font-normal text-muted-foreground'
			)}
		>
			{value.length ? 'Add or remove lecturers' : 'Choose lecturers'}
			<ChevronsUpDown class="opacity-50" />
		</Popover.Trigger>
		<Popover.Content class="w-(--bits-popover-anchor-width) p-0" align="start">
			<!-- Items are keyed by contact id, so search only by name. -->
			<Command.Root
				filter={(_, search, keywords) =>
					keywords?.some((name) => name.toLowerCase().includes(search.trim().toLowerCase()))
						? 1
						: 0}
			>
				<Command.Input placeholder="Search contacts…" />
				<Command.List>
					{#if contacts === null}
						<Command.Loading>Loading contacts…</Command.Loading>
					{:else if contacts.length === 0}
						<div class="px-3 py-6 text-center text-sm text-muted-foreground">
							No contacts yet.
							<a
								href={resolve('/library')}
								class="underline underline-offset-4 hover:text-foreground"
								>Add a contact in the Library</a
							>.
						</div>
					{:else}
						<Command.Empty>No matching contacts.</Command.Empty>
						<Command.Group>
							{#each contacts as contact (contact.id)}
								<Command.Item
									value={contact.id}
									keywords={[contact.name]}
									data-checked={value.includes(contact.id)}
									onSelect={() => toggle(contact.id)}
								>
									{contact.name}
								</Command.Item>
							{/each}
						</Command.Group>
					{/if}
				</Command.List>
			</Command.Root>
		</Popover.Content>
	</Popover.Root>
	{#if value.length}
		<ul class="flex flex-wrap gap-1.5" aria-label="Chosen lecturers">
			{#each value as id (id)}
				<li>
					<Badge variant="secondary" class="gap-1 pr-0.5">
						{nameOf(id)}
						<button
							type="button"
							class="rounded-sm p-0.5 hover:bg-foreground/10"
							aria-label={`Remove ${nameOf(id)}`}
							onclick={() => toggle(id)}
						>
							<X class="size-3" />
						</button>
					</Badge>
				</li>
			{/each}
		</ul>
	{/if}
</div>
