<script lang="ts">
	import { goto } from '$app/navigation';
	import { resolve } from '$app/paths';
	import { onMount } from 'svelte';
	import { toast } from 'svelte-sonner';
	import { ChevronDown, FolderOpen, Plus, Upload } from '@lucide/svelte';
	import {
		LIBRARY_KIND_LABELS,
		type EditableLibraryKind,
		type LibraryEntry,
		type LibraryListing
	} from '#lib/domain.js';
	import * as Breadcrumb from '#lib/components/ui/breadcrumb/index.js';
	import Button from '#lib/components/ui/button/button.svelte';
	import * as Dialog from '#lib/components/ui/dialog/index.js';
	import * as DropdownMenu from '#lib/components/ui/dropdown-menu/index.js';
	import * as Empty from '#lib/components/ui/empty/index.js';
	import { Pins } from '#lib/pins.svelte.js';
	import { api, errorText, plural } from '#lib/ui.js';
	import ConfirmDialog from '../ConfirmDialog.svelte';
	import ErrorAlert from '../ErrorAlert.svelte';
	import PinButton from '../PinButton.svelte';
	import EntryDetails from './EntryDetails.svelte';
	import EntryMenu from './EntryMenu.svelte';
	import LibraryEntryForm from './LibraryEntryForm.svelte';
	import LibraryRenameForm from './LibraryRenameForm.svelte';
	import MoveDialog from './MoveDialog.svelte';
	import UploadDialog from './UploadDialog.svelte';
	import { entryDetail, KIND_ICONS, sortEntries } from './kinds';

	/** The entry shown by this page: a folder to browse, an item to view, or null for the root. */
	let { entryId }: { entryId: string | null } = $props();

	const CREATABLE: EditableLibraryKind[] = ['folder', 'link', 'contact', 'note'];
	type Editor = { kind: EditableLibraryKind; entry?: undefined } | { entry: LibraryEntry };

	const pins = new Pins();
	let listing = $state.raw<LibraryListing | null>(null);
	let error = $state('');
	let editor = $state.raw<Editor | null>(null);
	let moving = $state.raw<LibraryEntry | null>(null);
	let deleting = $state.raw<LibraryEntry | null>(null);
	let uploading = $state(false);
	// Drag a row onto a folder row or a breadcrumb to move it there.
	let dragging = $state.raw<LibraryEntry | null>(null);
	let dropTarget = $state<string | null | undefined>(undefined);

	let entry = $derived(listing?.entry ?? null);
	let isFolder = $derived(!entry || entry.kind === 'folder');
	let children = $derived(sortEntries(listing?.children ?? []));
	let subtitle = $derived(
		!entry
			? 'Keep important files and information together.'
			: entry.kind === 'folder'
				? plural(children.length, 'item')
				: LIBRARY_KIND_LABELS[entry.kind]
	);
	let editorTitle = $derived(
		!editor
			? ''
			: editor.entry
				? `${editor.entry.kind === 'file' ? 'Rename' : 'Edit'} “${editor.entry.name}”`
				: `New ${LIBRARY_KIND_LABELS[editor.kind].toLowerCase()}`
	);

	async function load() {
		error = '';
		try {
			const path = entryId ? `/api/library/${entryId}` : '/api/library';
			[listing] = await Promise.all([
				api<LibraryListing>(path, { interaction: true }),
				pins.load()
			]);
		} catch (cause) {
			error = errorText(cause);
		}
	}
	async function saved() {
		editor = null;
		await load();
	}
	async function moved(destination: string) {
		const name = moving?.name;
		moving = null;
		toast.success(`Moved “${name}” to ${destination}.`);
		await load();
	}
	/** Drop-zone handlers for one destination; a zone accepts anything except a no-op move. */
	function dropZone(id: string | null, name: string) {
		const accepts = () => dragging !== null && dragging.id !== id && dragging.parentId !== id;
		return {
			ondragover: (event: DragEvent) => {
				if (!accepts()) return;
				event.preventDefault();
				dropTarget = id;
			},
			ondragleave: () => {
				if (dropTarget === id) dropTarget = undefined;
			},
			ondrop: async (event: DragEvent) => {
				const moved = dragging;
				if (!moved || !accepts()) return;
				event.preventDefault();
				dragging = null;
				dropTarget = undefined;
				try {
					await api(`/api/library/${moved.id}`, { method: 'PATCH', body: { parentId: id } });
					toast.success(`Moved “${moved.name}” to ${name}.`);
					await load();
				} catch (cause) {
					toast.error(errorText(cause));
				}
			}
		};
	}
	function endDrag() {
		dragging = null;
		dropTarget = undefined;
	}
	async function uploaded(count: number) {
		uploading = false;
		if (count) toast.success(`${plural(count, 'file')} uploaded.`);
		await load();
	}
	async function remove() {
		const target = deleting;
		if (!target) return;
		await api(`/api/library/${target.id}`, { method: 'DELETE' });
		toast.success(`Deleted “${target.name}”.`);
		if (target.id !== entry?.id) return load();
		if (target.parentId) await goto(resolve('/library/[id]', { id: target.parentId }));
		else await goto(resolve('library'));
	}

	onMount(() => {
		void load();
	});
</script>

<svelte:head><title>{entry?.name ?? 'Library'} · Studyloom</title></svelte:head>

<Breadcrumb.Root class="mb-6">
	<Breadcrumb.List>
		<Breadcrumb.Item
			{...dropZone(null, 'Library')}
			class={[dropTarget === null && 'bg-accent outline-2 outline-primary']}
		>
			{#if entryId}
				<Breadcrumb.Link href={resolve('library')}>Library</Breadcrumb.Link>
			{:else}
				<Breadcrumb.Page>Library</Breadcrumb.Page>
			{/if}
		</Breadcrumb.Item>
		{#each listing?.ancestors ?? [] as ancestor (ancestor.id)}
			<Breadcrumb.Separator />
			<Breadcrumb.Item
				{...dropZone(ancestor.id, ancestor.name)}
				class={['min-w-0', dropTarget === ancestor.id && 'bg-accent outline-2 outline-primary']}
			>
				<Breadcrumb.Link href={resolve('/library/[id]', { id: ancestor.id })} class="truncate"
					>{ancestor.name}</Breadcrumb.Link
				>
			</Breadcrumb.Item>
		{/each}
		{#if entry}
			<Breadcrumb.Separator />
			<Breadcrumb.Item class="min-w-0">
				<Breadcrumb.Page class="truncate">{entry.name}</Breadcrumb.Page>
			</Breadcrumb.Item>
		{/if}
	</Breadcrumb.List>
</Breadcrumb.Root>

<ErrorAlert message={error} onRetry={load} class="mb-5" />

{#if !listing}
	{#if !error}<p role="status" class="py-12 text-muted-foreground">Loading Library…</p>{/if}
{:else}
	<div class="mb-8 flex flex-wrap items-start justify-between gap-4">
		<div class="min-w-0">
			<h1 class="text-3xl font-semibold tracking-tight break-words">{entry?.name ?? 'Library'}</h1>
			<p class="mt-2 text-muted-foreground">{subtitle}</p>
		</div>
		<div class="flex flex-wrap items-center gap-2">
			{#if entry}
				<PinButton {pins} targetType="library" targetId={entry.id} name={entry.name} />

				<EntryMenu
					{entry}
					onEdit={(entry) => (editor = { entry })}
					onMove={(entry) => (moving = entry)}
					onDelete={(entry) => (deleting = entry)}
				/>
			{/if}
			{#if isFolder}
				<Button variant="outline" onclick={() => (uploading = true)}><Upload />Upload</Button>
				<DropdownMenu.Root>
					<DropdownMenu.Trigger>
						{#snippet child({ props })}
							<Button {...props}><Plus />New<ChevronDown /></Button>
						{/snippet}
					</DropdownMenu.Trigger>
					<DropdownMenu.Content align="end" class="w-40">
						{#each CREATABLE as kind (kind)}
							{@const Icon = KIND_ICONS[kind]}
							<DropdownMenu.Item onSelect={() => (editor = { kind })}
								><Icon />{LIBRARY_KIND_LABELS[kind]}</DropdownMenu.Item
							>
						{/each}
					</DropdownMenu.Content>
				</DropdownMenu.Root>
			{/if}
		</div>
	</div>

	{#if entry && !isFolder}
		<EntryDetails {entry} />
	{:else if children.length === 0}
		<Empty.Root class="border border-dashed">
			<Empty.Header>
				<Empty.Media variant="icon"><FolderOpen /></Empty.Media>
				<Empty.Title>{entry ? 'This folder is empty' : 'Your Library is empty'}</Empty.Title>
				<Empty.Description>
					Upload a file, or add a folder, link, contact or note to get started.
				</Empty.Description>
			</Empty.Header>
			<Empty.Content>
				<div class="flex flex-wrap justify-center gap-2">
					<Button variant="outline" onclick={() => (uploading = true)}
						><Upload />Upload files</Button
					>
					<Button onclick={() => (editor = { kind: 'folder' })}><Plus />New folder</Button>
				</div>
			</Empty.Content>
		</Empty.Root>
	{:else}
		<ul class="divide-y border">
			{#each children as child (child.id)}
				{@const Icon = KIND_ICONS[child.kind]}
				{@const detail = entryDetail(child)}
				<li
					draggable="true"
					ondragstart={(event) => {
						dragging = child;
						if (event.dataTransfer) event.dataTransfer.effectAllowed = 'move';
					}}
					ondragend={endDrag}
					{...child.kind === 'folder' ? dropZone(child.id, child.name) : {}}
					class={[
						'relative flex min-w-0 items-center gap-3 p-3 hover:bg-muted/40 sm:px-4',
						dragging?.id === child.id && 'opacity-50',
						dropTarget === child.id && 'bg-accent outline-2 -outline-offset-2 outline-primary'
					]}
				>
					<Icon class="size-5 shrink-0 text-muted-foreground" />
					<!-- The stretched link makes the whole row a target; the buttons sit above it. -->
					<a
						href={resolve('/library/[id]', { id: child.id })}
						class="min-w-0 flex-1 outline-none after:absolute after:inset-0 focus-visible:after:ring-2 focus-visible:after:ring-ring focus-visible:after:ring-inset"
					>
						<span class="block truncate font-medium">{child.name}</span>
						<span class="block truncate text-xs text-muted-foreground">
							{LIBRARY_KIND_LABELS[child.kind]}{detail ? ` · ${detail}` : ''}
						</span>
					</a>
					<div class="relative flex shrink-0 items-center">
						<PinButton {pins} targetType="library" targetId={child.id} name={child.name} />

						<EntryMenu
							entry={child}
							onEdit={(entry) => (editor = { entry })}
							onMove={(entry) => (moving = entry)}
							onDelete={(entry) => (deleting = entry)}
						/>
					</div>
				</li>
			{/each}
		</ul>
	{/if}
{/if}

<Dialog.Root
	bind:open={
		() => editor !== null,
		(open) => {
			if (!open) editor = null;
		}
	}
>
	<Dialog.Content class="sm:max-w-lg">
		<Dialog.Header><Dialog.Title class="break-words">{editorTitle}</Dialog.Title></Dialog.Header>
		{#if editor?.entry?.kind === 'file'}
			<LibraryRenameForm entry={editor.entry} onSaved={saved} onCancel={() => (editor = null)} />
		{:else if editor}
			<LibraryEntryForm
				kind={editor.entry ? (editor.entry.kind as EditableLibraryKind) : editor.kind}
				entry={editor.entry}
				parentId={entry?.kind === 'folder' ? entry.id : null}
				onSaved={saved}
				onCancel={() => (editor = null)}
			/>
		{/if}
	</Dialog.Content>
</Dialog.Root>

{#if moving}
	<MoveDialog entry={moving} onClose={() => (moving = null)} onMoved={moved} />
{/if}
{#if uploading}
	<UploadDialog
		parentId={entry?.kind === 'folder' ? entry.id : null}
		onClose={() => (uploading = false)}
		onUploaded={uploaded}
	/>
{/if}
<ConfirmDialog
	bind:open={
		() => deleting !== null,
		(open) => {
			if (!open) deleting = null;
		}
	}
	title={`Delete “${deleting?.name}”?`}
	description={`${
		deleting?.kind === 'folder'
			? 'This also deletes everything inside this folder.'
			: 'This item will be removed.'
	} This cannot be undone.`}
	onConfirm={remove}
/>
