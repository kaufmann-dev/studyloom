<script lang="ts">
	import { onMount, untrack } from 'svelte';
	import { SvelteSet } from 'svelte/reactivity';
	import { Check, ChevronRight, Folder, Library, Search } from '@lucide/svelte';
	import Button from '#lib/components/ui/button/button.svelte';
	import * as Dialog from '#lib/components/ui/dialog/index.js';
	import Input from '#lib/components/ui/input/input.svelte';
	import type { LibraryEntry, LibraryFolder } from '#lib/domain.js';
	import { api, errorText } from '#lib/ui.js';

	let {
		entry,
		onClose,
		onMoved
	}: {
		entry: LibraryEntry;
		onClose: () => void;
		/** Receives the name of the folder the entry now lives in. */
		onMoved: (destination: string) => void | Promise<void>;
	} = $props();

	const ROOT = 'Library';
	const FILTER_THRESHOLD = 8;
	interface Row {
		id: string | null;
		name: string;
		depth: number;
		expandable: boolean;
		/** Where the folder lives; shown when filtering flattens the tree. */
		location: string;
	}

	let folders = $state.raw<LibraryFolder[]>([]);
	let loading = $state(true);
	let busy = $state(false);
	let error = $state('');
	let query = $state('');
	let target = $state(untrack(() => entry.parentId));
	const expanded = new SvelteSet<string>();

	let byId = $derived(new Map(folders.map((folder) => [folder.id, folder])));
	/** Folders that can receive the entry: a folder cannot move into itself or its own subtree. */
	let destinations = $derived.by(() => {
		if (entry.kind !== 'folder') return folders;
		const isInside = (folder: LibraryFolder | undefined): boolean =>
			Boolean(folder) && (folder!.id === entry.id || isInside(byId.get(folder!.parentId ?? '')));
		return folders.filter((folder) => !isInside(folder));
	});
	let childrenOf = $derived(Map.groupBy(destinations, (folder) => folder.parentId));
	let rows = $derived.by((): Row[] => {
		const needle = query.trim().toLowerCase();
		if (needle)
			return destinations
				.filter((folder) => folder.name.toLowerCase().includes(needle))
				.map((folder) => ({
					id: folder.id,
					name: folder.name,
					depth: 0,
					expandable: false,
					location: pathTo(folder.parentId)
				}));
		const visible: Row[] = [{ id: null, name: ROOT, depth: 0, expandable: false, location: '' }];
		const walk = (parentId: string | null, depth: number) => {
			for (const folder of childrenOf.get(parentId) ?? []) {
				visible.push({
					id: folder.id,
					name: folder.name,
					depth,
					expandable: childrenOf.has(folder.id),
					location: ''
				});
				if (expanded.has(folder.id)) walk(folder.id, depth + 1);
			}
		};
		walk(null, 1);
		return visible;
	});
	let unchanged = $derived(target === entry.parentId);

	const nameOf = (id: string | null) => byId.get(id ?? '')?.name ?? ROOT;
	function pathTo(id: string | null): string {
		const names: string[] = [];
		for (let folder = byId.get(id ?? ''); folder; folder = byId.get(folder.parentId ?? ''))
			names.unshift(folder.name);
		return [ROOT, ...names].join(' / ');
	}
	function toggle(id: string) {
		if (expanded.has(id)) expanded.delete(id);
		else expanded.add(id);
	}
	async function move(destination = target) {
		if (busy || destination === entry.parentId) return;
		busy = true;
		error = '';
		try {
			await api(`/api/library/${entry.id}`, { method: 'PATCH', body: { parentId: destination } });
			await onMoved(nameOf(destination));
		} catch (cause) {
			error = errorText(cause);
		} finally {
			busy = false;
		}
	}

	onMount(async () => {
		try {
			folders = (
				await api<{ folders: LibraryFolder[] }>('/api/library/folders', { interaction: true })
			).folders;
			// Reveal where the entry lives now, so the tree opens in a familiar place.
			for (let id = entry.parentId; id; id = byId.get(id)?.parentId ?? null) expanded.add(id);
		} catch (cause) {
			error = errorText(cause);
		} finally {
			loading = false;
		}
	});
</script>

<Dialog.Root
	bind:open={
		() => true,
		(open) => {
			if (!open && !busy) onClose();
		}
	}
>
	<Dialog.Content class="sm:max-w-lg">
		<Dialog.Header>
			<Dialog.Title class="break-words">Move “{entry.name}”</Dialog.Title>
			<Dialog.Description>Currently in {loading ? '…' : pathTo(entry.parentId)}.</Dialog.Description
			>
		</Dialog.Header>
		<div class="space-y-3">
			{#if folders.length >= FILTER_THRESHOLD}
				<div class="relative">
					<Search
						class="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground"
					/>
					<Input
						type="search"
						bind:value={query}
						placeholder="Find a folder"
						aria-label="Find a folder"
						class="pl-8"
					/>
				</div>
			{/if}
			<div
				role="radiogroup"
				aria-label="Destination folder"
				class="max-h-72 min-h-32 overflow-y-auto border p-1"
			>
				{#if loading}
					<p role="status" class="p-3 text-sm text-muted-foreground">Loading folders…</p>
				{:else}
					{#each rows as row (row.id)}
						{@const selected = target === row.id}
						<div
							class={['flex items-center', selected ? 'bg-accent' : 'hover:bg-muted/60']}
							style:padding-left="{row.depth * 1.25}rem"
						>
							{#if row.expandable}
								<button
									type="button"
									class="flex size-7 shrink-0 items-center justify-center text-muted-foreground hover:text-foreground"
									aria-label={`${expanded.has(row.id!) ? 'Collapse' : 'Expand'} ${row.name}`}
									aria-expanded={expanded.has(row.id!)}
									onclick={() => toggle(row.id!)}
								>
									<ChevronRight
										class={['size-4 transition-transform', expanded.has(row.id!) && 'rotate-90']}
									/>
								</button>
							{:else}
								<span class="size-7 shrink-0"></span>
							{/if}
							<button
								type="button"
								role="radio"
								aria-checked={selected}
								class="flex min-h-9 min-w-0 flex-1 items-center gap-2 py-1.5 pr-2 text-left text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"
								onclick={() => (target = row.id)}
								ondblclick={() => move(row.id)}
							>
								{#if row.id}
									<Folder class="size-4 shrink-0 text-muted-foreground" />
								{:else}
									<Library class="size-4 shrink-0 text-muted-foreground" />
								{/if}
								<span class="min-w-0 flex-1">
									<span class="block truncate">{row.name}</span>
									{#if row.location}
										<span class="block truncate text-xs text-muted-foreground">{row.location}</span>
									{/if}
								</span>
								{#if row.id === entry.parentId}
									<span class="shrink-0 text-xs text-muted-foreground">Current</span>
								{:else if selected}
									<Check class="size-4 shrink-0" />
								{/if}
							</button>
						</div>
					{:else}
						<p class="p-3 text-sm text-muted-foreground">No folders match “{query.trim()}”.</p>
					{/each}
				{/if}
			</div>
			{#if error}<p role="alert" class="text-sm text-destructive">{error}</p>{/if}
		</div>
		<Dialog.Footer>
			<Button variant="ghost" disabled={busy} onclick={onClose}>Cancel</Button>
			<Button disabled={loading || busy || unchanged} onclick={() => move()}>
				{busy ? 'Moving…' : unchanged ? 'Move here' : `Move to ${nameOf(target)}`}
			</Button>
		</Dialog.Footer>
	</Dialog.Content>
</Dialog.Root>
