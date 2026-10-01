import { Contact, File, Folder, Link, NotebookText } from '@lucide/svelte';
import type { LibraryEntry, LibraryKind } from '#lib/domain.js';
import { fileSize } from '#lib/ui.js';

export const KIND_ICONS = {
	folder: Folder,
	file: File,
	link: Link,
	contact: Contact,
	note: NotebookText
} satisfies Record<LibraryKind, typeof Folder>;

/** Folders first, then by name. */
export function sortEntries(entries: LibraryEntry[]): LibraryEntry[] {
	return entries.toSorted(
		(a, b) =>
			Number(b.kind === 'folder') - Number(a.kind === 'folder') || a.name.localeCompare(b.name)
	);
}

/** The one detail worth showing next to an entry's kind in a list. */
export function entryDetail(entry: LibraryEntry): string {
	if (entry.kind === 'file')
		return entry.status === 'ready' ? fileSize(entry.size) : 'Incomplete upload';
	if (entry.kind === 'link') return URL.parse(entry.url)?.hostname ?? '';
	if (entry.kind === 'contact') return entry.email || entry.phone;
	return '';
}
