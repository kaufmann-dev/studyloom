<script lang="ts">
	import { resolve } from '$app/paths';
	import { ArrowUpRight, Download, Mail, Phone } from '@lucide/svelte';
	import Button from '#lib/components/ui/button/button.svelte';
	import type { LibraryEntry } from '#lib/domain.js';
	import { fileSize } from '#lib/ui.js';

	let { entry }: { entry: LibraryEntry } = $props();
	let fileHref = $derived(resolve('/api/[...path]', { path: `library/${entry.id}/file` }));
</script>

<!-- User-supplied addresses are external by nature. -->
<!-- eslint-disable svelte/no-navigation-without-resolve -->
<div class="space-y-5 border p-6">
	{#if entry.kind === 'file'}
		<p class="text-sm text-muted-foreground">{entry.filename} · {fileSize(entry.size)}</p>
		{#if entry.status === 'ready'}
			{#if entry.mimeType?.startsWith('image/')}
				<img src={fileHref} alt={entry.name} class="max-h-96 max-w-full object-contain" />
			{/if}
			<div class="flex flex-wrap gap-2">
				<Button href={fileHref} target="_blank"><ArrowUpRight />Open file</Button>
				<Button
					href={`${fileHref}?download`}
					download={entry.filename || entry.name}
					variant="outline"
				>
					<Download />Download
				</Button>
			</div>
		{:else}
			<p role="status" class="text-sm">
				This upload never finished. Delete it and upload the file again.
			</p>
		{/if}
	{:else if entry.kind === 'link'}
		<a
			href={entry.url}
			target="_blank"
			rel="noopener noreferrer"
			class="inline-flex max-w-full items-center gap-2 underline underline-offset-4"
		>
			<span class="truncate">{entry.url}</span><ArrowUpRight class="size-4 shrink-0" />
		</a>
	{:else if entry.kind === 'contact'}
		<dl class="space-y-3 text-sm">
			{#if entry.phone}
				<div class="flex items-center gap-2">
					<dt><Phone class="size-4 text-muted-foreground" /><span class="sr-only">Phone</span></dt>
					<dd>
						<a href={`tel:${entry.phone}`} class="underline underline-offset-4">{entry.phone}</a>
					</dd>
				</div>
			{/if}
			{#if entry.email}
				<div class="flex items-center gap-2">
					<dt><Mail class="size-4 text-muted-foreground" /><span class="sr-only">Email</span></dt>
					<dd>
						<a href={`mailto:${entry.email}`} class="underline underline-offset-4">{entry.email}</a>
					</dd>
				</div>
			{/if}
			{#if entry.website}
				<div class="flex items-center gap-2">
					<dt>
						<ArrowUpRight class="size-4 text-muted-foreground" /><span class="sr-only">Website</span
						>
					</dt>
					<dd class="min-w-0">
						<a
							href={entry.website}
							target="_blank"
							rel="noopener noreferrer"
							class="block truncate underline underline-offset-4">{entry.website}</a
						>
					</dd>
				</div>
			{/if}
		</dl>
	{:else if entry.kind === 'note'}
		<p class="leading-relaxed whitespace-pre-wrap">{entry.text || 'This note is empty.'}</p>
	{/if}
	{#if (entry.kind === 'link' || entry.kind === 'contact') && entry.notes}
		<p class="border-t pt-4 text-sm leading-relaxed whitespace-pre-wrap">{entry.notes}</p>
	{/if}
</div>
