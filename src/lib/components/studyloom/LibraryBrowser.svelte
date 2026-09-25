<script lang="ts">
	import { resolve } from '$app/paths';
	import { onMount } from 'svelte';
	import {
		ArrowUpRight,
		ChevronRight,
		Contact,
		File as FileIcon,
		Folder,
		Link,
		NotebookText,
		Pin,
		PinOff,
		Plus,
		Upload
	} from '@lucide/svelte';
	import type { LibraryEntry, Pin as SavedPin } from '$lib/domain';
	import { UPLOAD_CHUNK_SIZE } from '$lib/domain';
	import Button from '$lib/components/ui/button/button.svelte';
	import Input from '$lib/components/ui/input/input.svelte';
	import LibraryEditor from './LibraryEditor.svelte';
	import LibraryFileRename from './LibraryFileRename.svelte';
	import { api, errorText } from '$lib/ui';

	let { folderId }: { folderId: string | null } = $props();
	let entry = $state.raw<LibraryEntry | null>(null);
	let ancestors = $state.raw<{ id: string; name: string }[]>([]);
	let children = $state.raw<LibraryEntry[]>([]);
	let folders = $state.raw<LibraryEntry[]>([]);
	let pins = $state.raw<SavedPin[]>([]);
	let loading = $state(true);
	let error = $state('');
	let busy = $state(false);
	let progress = $state('');
	let showCreate = $state(false);
	let showUpload = $state(false);
	let editing = $state.raw<LibraryEntry | null>(null);
	let moving = $state.raw<LibraryEntry | null>(null);
	let moveTarget = $state<string | null>(null);
	let deleting = $state.raw<LibraryEntry | null>(null);
	let selectedFile = $state<File | null>(null);
	let pendingUpload = $state.raw<{
		entryId: string;
		file: File;
		chunkSize: number;
		nextSequence: number;
	} | null>(null);
	let inputKey = $state(0);
	let displayed = $derived(entry?.kind === 'folder' || !entry);

	function itemHref(item: LibraryEntry) {
		return resolve('/library/[id]', { id: item.id });
	}
	function iconFor(kind: LibraryEntry['kind']) {
		return kind === 'folder'
			? Folder
			: kind === 'file'
				? FileIcon
				: kind === 'link'
					? Link
					: kind === 'contact'
						? Contact
						: NotebookText;
	}
	function pinFor(item: LibraryEntry) {
		return pins.find((pin) => pin.targetType === 'library' && pin.targetId === item.id);
	}

	async function load() {
		loading = true;
		error = '';
		try {
			const path = folderId ? `/api/library/${folderId}` : '/api/library';
			const [listing, pinList] = await Promise.all([
				api<{
					entry: LibraryEntry | null;
					children: LibraryEntry[];
					ancestors: { id: string; name: string }[];
				}>(path, undefined, 'GET', true),
				api<{ pins: SavedPin[] }>('/api/pins', undefined, 'GET', true)
			]);
			entry = listing.entry;
			ancestors = listing.ancestors ?? [];
			children = listing.children;
			pins = pinList.pins;
		} catch (cause) {
			error = errorText(cause);
		} finally {
			loading = false;
		}
	}
	async function saved() {
		showCreate = false;
		editing = null;
		await load();
	}
	async function togglePin(item: LibraryEntry) {
		busy = true;
		error = '';
		try {
			const existing = pinFor(item);
			if (existing) {
				await api(`/api/pins/${existing.id}`, undefined, 'DELETE');
				pins = pins.filter((pin) => pin.id !== existing.id);
			} else {
				const result = await api<{ pin: SavedPin }>('/api/pins', {
					targetType: 'library',
					targetId: item.id
				});
				pins = [result.pin, ...pins];
			}
		} catch (cause) {
			error = errorText(cause);
		} finally {
			busy = false;
		}
	}
	async function prepareMove(item: LibraryEntry) {
		moving = item;
		moveTarget = item.parentId;
		error = '';
		try {
			folders = (
				await api<{ folders: LibraryEntry[] }>('/api/library/folders', undefined, 'GET', true)
			).folders;
		} catch (cause) {
			error = errorText(cause);
			moving = null;
		}
	}
	async function move() {
		if (!moving) return;
		busy = true;
		error = '';
		try {
			await api(`/api/library/${moving.id}`, { parentId: moveTarget }, 'PATCH');
			moving = null;
			await load();
		} catch (cause) {
			error = errorText(cause);
		} finally {
			busy = false;
		}
	}
	async function remove() {
		if (!deleting) return;
		busy = true;
		error = '';
		try {
			await api(`/api/library/${deleting.id}`, undefined, 'DELETE');
			const wasCurrent = deleting.id === entry?.id;
			deleting = null;
			if (wasCurrent)
				window.location.assign(
					entry?.parentId ? itemHref({ id: entry.parentId } as LibraryEntry) : resolve('/library')
				);
			else await load();
		} catch (cause) {
			error = errorText(cause);
		} finally {
			busy = false;
		}
	}
	async function uploadFile() {
		if (!selectedFile && !pendingUpload) return;
		busy = true;
		error = '';
		progress = 'Preparing upload…';
		try {
			if (!pendingUpload) {
				const file = selectedFile!;
				const created = await api<{ entry: LibraryEntry; chunkSize: number }>(
					'/api/library/uploads',
					{
						parentId: folderId,
						filename: file.name,
						mimeType: file.type || 'application/octet-stream',
						size: file.size
					}
				);
				pendingUpload = {
					entryId: created.entry.id,
					file,
					chunkSize: created.chunkSize || UPLOAD_CHUNK_SIZE,
					nextSequence: 0
				};
			}
			const upload = pendingUpload;
			for (
				let sequence = upload.nextSequence;
				sequence * upload.chunkSize < upload.file.size;
				sequence += 1
			) {
				const offset = sequence * upload.chunkSize;
				const response = await fetch(`/api/library/${upload.entryId}/chunks/${sequence}`, {
					method: 'PUT',
					headers: { 'content-type': 'application/octet-stream', 'x-studyloom-interaction': '1' },
					body: upload.file.slice(offset, offset + upload.chunkSize)
				});
				if (!response.ok) {
					const detail = await response.json().catch(() => null);
					throw new Error(detail?.message ?? `Upload failed (${response.status}).`);
				}
				pendingUpload = { ...upload, nextSequence: sequence + 1 };
				progress = `Uploading ${upload.file.name} · ${Math.min(100, Math.round(((offset + upload.chunkSize) / upload.file.size) * 100))}%`;
			}
			await api(`/api/library/${upload.entryId}/complete`, {});
			progress = '';
			selectedFile = null;
			pendingUpload = null;
			inputKey += 1;
			showUpload = false;
			await load();
		} catch (cause) {
			error = errorText(cause);
			progress = '';
		} finally {
			busy = false;
		}
	}
	async function discardUpload() {
		if (!pendingUpload) return;
		busy = true;
		error = '';
		try {
			await api(`/api/library/${pendingUpload.entryId}`, undefined, 'DELETE');
			pendingUpload = null;
			selectedFile = null;
			inputKey += 1;
			showUpload = false;
			await load();
		} catch (cause) {
			error = errorText(cause);
		} finally {
			busy = false;
		}
	}
	onMount(() => {
		void load();
	});
</script>

<svelte:head><title>{entry?.name ?? 'Library'} · Studyloom</title></svelte:head>
<div class="mx-auto max-w-5xl">
	<nav aria-label="Breadcrumb" class="mb-6 flex items-center gap-1 text-sm text-muted-foreground">
		<a href={resolve('/library')} class="hover:underline">Library</a
		>{#each ancestors as ancestor (ancestor.id)}<ChevronRight class="size-4 shrink-0" /><a
				href={resolve('/library/[id]', { id: ancestor.id })}
				class="min-w-0 truncate hover:underline">{ancestor.name}</a
			>{/each}{#if entry}<ChevronRight class="size-4" /><span class="truncate text-foreground"
				>{entry.name}</span
			>{/if}
	</nav>
	{#if error}<div
			role="alert"
			class="mb-5 border border-destructive/30 p-4 text-sm text-destructive"
		>
			{error}
			<Button variant="ghost" onclick={load}>Retry</Button>
		</div>{/if}
	{#if loading}<p role="status" class="py-12 text-muted-foreground">Loading Library…</p>
	{:else}
		<div class="mb-8 flex flex-wrap items-start justify-between gap-4">
			<div>
				<h1 class="text-3xl font-semibold tracking-tight">{entry?.name ?? 'Library'}</h1>
				<p class="mt-2 text-muted-foreground">
					{entry?.kind === 'folder' || !entry
						? 'Keep important files and information together.'
						: entry.kind === 'file'
							? entry.filename
							: entry.kind === 'link'
								? entry.url
								: entry.kind === 'contact'
									? 'Contact'
									: 'Note'}
				</p>
			</div>
			{#if displayed}<div class="flex flex-wrap gap-2">
					<Button
						variant="outline"
						disabled={busy || !!pendingUpload}
						onclick={() => {
							showUpload = !showUpload;
							showCreate = false;
						}}><Upload />Upload file</Button
					><Button
						disabled={busy || !!pendingUpload}
						onclick={() => {
							showCreate = !showCreate;
							showUpload = false;
						}}><Plus />Add item</Button
					>
				</div>{/if}
		</div>
		{#if showCreate}<div class="mb-6">
				<LibraryEditor parentId={folderId} onSaved={saved} onCancel={() => (showCreate = false)} />
			</div>{/if}
		{#if showUpload}<div class="mb-6 space-y-4 border p-5">
				<h2 class="text-lg font-semibold">Upload file</h2>
				{#if pendingUpload}<p class="text-sm">
						{pendingUpload.file.name} · {Math.min(
							100,
							Math.round(
								((pendingUpload.nextSequence * pendingUpload.chunkSize) / pendingUpload.file.size) *
									100
							)
						)}% uploaded
					</p>{:else}{#key inputKey}<Input
							type="file"
							aria-label="Choose a file"
							onchange={(event) => (selectedFile = event.currentTarget.files?.[0] ?? null)}
						/>{/key}{/if}
				<div class="flex gap-2">
					<Button disabled={(!selectedFile && !pendingUpload) || busy} onclick={uploadFile}
						>{pendingUpload ? 'Retry upload' : 'Upload'}</Button
					>{#if pendingUpload}<Button variant="destructive" disabled={busy} onclick={discardUpload}
							>Discard upload</Button
						>{:else}<Button variant="ghost" onclick={() => (showUpload = false)}>Cancel</Button
						>{/if}
				</div>
				{#if progress}<p role="status" class="text-sm text-muted-foreground">{progress}</p>{/if}
			</div>{/if}
		{#if entry && !displayed}
			<div class="space-y-4 border p-6">
				{#if entry.kind === 'file'}<p class="text-sm text-muted-foreground">
						{entry.filename} · {Math.ceil(entry.size / 1024)} KB
					</p>
					{#if entry.status === 'ready'}<div class="flex gap-2">
							<Button
								href={resolve('/api/[...path]', { path: `library/${entry.id}/file` })}
								target="_blank">Open file</Button
							><Button
								href={resolve('/api/[...path]?download', { path: `library/${entry.id}/file` })}
								download={entry.filename || entry.name}
								variant="outline">Download file</Button
							>
						</div>{:else}<p role="status">This file is still uploading.</p>{/if}
				{:else if entry.kind === 'link' && entry.url}<!-- eslint-disable svelte/no-navigation-without-resolve --><a
						href={entry.url}
						target="_blank"
						rel="noopener noreferrer"
						class="inline-flex items-center gap-2 underline underline-offset-4"
						>Open link <ArrowUpRight class="size-4" /></a
					><!-- eslint-enable svelte/no-navigation-without-resolve -->
				{:else if entry.kind === 'contact'}<div class="space-y-2 text-sm">
						{#if entry.phone}<p>
								<a href={`tel:${entry.phone}`} class="underline">{entry.phone}</a>
							</p>{/if}{#if entry.email}<p>
								<a href={`mailto:${entry.email}`} class="underline">{entry.email}</a>
							</p>{/if}{#if entry.website}<p>
								<!-- eslint-disable svelte/no-navigation-without-resolve -->
								<a href={entry.website} target="_blank" rel="noopener noreferrer" class="underline"
									>{entry.website}</a
								>
								<!-- eslint-enable svelte/no-navigation-without-resolve -->
							</p>{/if}{#if entry.notes}<p class="whitespace-pre-wrap">{entry.notes}</p>{/if}
					</div>
				{:else if entry.kind === 'note'}<p class="whitespace-pre-wrap">{entry.text}</p>{/if}
			</div>
		{/if}
		{#if displayed}
			{#if children.length === 0}<div
					class="border border-dashed px-6 py-12 text-center text-muted-foreground"
				>
					This folder is empty. Add a file or another item to get started.
				</div>
			{:else}<div class="divide-y border">
					{#each children as child (child.id)}
						{@const Icon = iconFor(child.kind)}
						<div class="flex min-w-0 items-center gap-3 p-3 sm:p-4">
							<Icon class="size-5 shrink-0 text-muted-foreground" />
							<a
								href={itemHref(child)}
								class="min-w-0 flex-1 focus-visible:outline-2 focus-visible:outline-primary"
								><span class="block truncate font-medium">{child.name}</span><span
									class="text-xs text-muted-foreground capitalize">{child.kind}</span
								></a
							>
							<Button
								variant="ghost"
								size="icon"
								aria-label={`${pinFor(child) ? 'Unpin' : 'Pin'} ${child.name}`}
								disabled={busy}
								onclick={() => togglePin(child)}
								>{#if pinFor(child)}<PinOff />{:else}<Pin />{/if}</Button
							>
							<Button variant="ghost" size="sm" onclick={() => (editing = child)}>Edit</Button
							><Button variant="ghost" size="sm" onclick={() => prepareMove(child)}>Move</Button
							><Button
								variant="ghost"
								size="sm"
								class="text-destructive"
								onclick={() => (deleting = child)}>Delete</Button
							>
						</div>{/each}
				</div>{/if}
		{:else if entry}<div class="mt-5 flex flex-wrap gap-2">
				<Button
					variant="outline"
					disabled={busy}
					onclick={() => {
						if (entry) void togglePin(entry);
					}}
					>{#if pinFor(entry)}<PinOff />Unpin{:else}<Pin />Pin{/if}</Button
				><Button variant="outline" onclick={() => (editing = entry)}
					>{entry.kind === 'file' ? 'Rename' : 'Edit'}</Button
				><Button
					variant="outline"
					onclick={() => {
						if (entry) void prepareMove(entry);
					}}>Move</Button
				><Button variant="destructive" onclick={() => (deleting = entry)}>Delete</Button>
			</div>{/if}
		{#if entry && entry.kind === 'folder'}<div class="mt-5 flex flex-wrap gap-2">
				<Button
					variant="outline"
					disabled={busy}
					onclick={() => {
						if (entry) void togglePin(entry);
					}}
					>{#if pinFor(entry)}<PinOff />Unpin{:else}<Pin />Pin{/if}</Button
				><Button variant="outline" onclick={() => (editing = entry)}>Edit folder</Button><Button
					variant="outline"
					onclick={() => {
						if (entry) void prepareMove(entry);
					}}>Move folder</Button
				><Button variant="destructive" onclick={() => (deleting = entry)}>Delete folder</Button>
			</div>{/if}
		{#if editing}<div class="mt-6">
				{#key editing.id}{#if editing.kind === 'file'}<LibraryFileRename
							entry={editing}
							onSaved={saved}
							onCancel={() => (editing = null)}
						/>{:else}<LibraryEditor
							entry={editing}
							parentId={editing.parentId}
							onSaved={saved}
							onCancel={() => (editing = null)}
						/>{/if}{/key}
			</div>{/if}
		{#if moving}<div class="mt-6 space-y-4 border p-5">
				<h2 class="text-lg font-semibold">Move {moving.name}</h2>
				<label for="move-target" class="block text-sm font-medium">Destination</label><select
					id="move-target"
					class="h-10 w-full border border-input bg-background px-3 text-sm"
					bind:value={moveTarget}
					><option value={null}>Library root</option
					>{#each folders.filter((folder) => folder.id !== moving?.id) as folder (folder.id)}<option
							value={folder.id}>{folder.name}</option
						>{/each}</select
				>
				<div class="flex gap-2">
					<Button disabled={busy} onclick={move}>Move</Button><Button
						variant="ghost"
						onclick={() => (moving = null)}>Cancel</Button
					>
				</div>
			</div>{/if}
		{#if deleting}<div class="mt-6 space-y-4 border border-destructive/30 p-5">
				<h2 class="font-semibold">Delete {deleting.name}?</h2>
				<p class="text-sm text-muted-foreground">
					{deleting.kind === 'folder'
						? 'This will also delete everything inside this folder.'
						: 'This item will be removed.'} This cannot be undone.
				</p>
				<div class="flex gap-2">
					<Button variant="destructive" disabled={busy} onclick={remove}>Delete</Button><Button
						variant="ghost"
						onclick={() => (deleting = null)}>Cancel</Button
					>
				</div>
			</div>{/if}
	{/if}
</div>
