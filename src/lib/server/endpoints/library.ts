import { error } from '@sveltejs/kit';
import { and, asc, eq, ilike, isNull, or, sql } from 'drizzle-orm';
import type { z } from 'zod';
import { db, type Transaction } from '../db';
import * as t from '../db/schema';
import {
	libraryInput,
	libraryPatchInput,
	librarySearchInput,
	libraryUploadInput,
	UPLOAD_CHUNK_SIZE,
	type LibraryKind
} from '../../domain';
import { maxUploadBytes, safeError } from '../config';
import {
	completeLibraryUpload,
	libraryFilePath,
	putLibraryChunk,
	removeLibraryFiles
} from '../library-storage';
import { boundedBody, created, download, ok, readJson, type Handler } from './http';
import { findLibraryEntry } from './queries';

const MAX_DEPTH = 100;

/** The folder chain from the Library root down to `id`, inclusive. */
async function folderPath(id: string | null) {
	if (!id) return [];
	const rows = await db().execute<{ id: string; name: string; kind: LibraryKind }>(sql`
		with recursive chain as (
			select id, parent_id, name, kind, 0 as depth from ${t.libraryEntries} where id = ${id}
			union all
			select parent.id, parent.parent_id, parent.name, parent.kind, chain.depth + 1
			from ${t.libraryEntries} parent
			join chain on parent.id = chain.parent_id
			where chain.depth < ${MAX_DEPTH}
		)
		select id, name, kind from chain order by depth desc`);
	return [...rows];
}
async function checkParent(parentId: string | null, movingFolderId?: string) {
	if (!parentId) return;
	const path = await folderPath(parentId);
	if (!path.length) error(404, 'Library item not found.');
	if (path.some((folder) => folder.id === movingFolderId))
		error(409, 'A folder cannot contain itself.');
	if (path.some((folder) => folder.kind !== 'folder'))
		error(400, 'Choose a folder as the destination.');
}
async function fileIdsWithin(tx: Transaction, id: string) {
	const rows = await tx.execute<{ id: string }>(sql`
		with recursive tree as (
			select id, kind, 0 as depth from ${t.libraryEntries} where id = ${id}
			union all
			select child.id, child.kind, tree.depth + 1
			from ${t.libraryEntries} child
			join tree on child.parent_id = tree.id
			where tree.depth < ${MAX_DEPTH}
		)
		select id from tree where kind = 'file'`);
	return rows.map((row) => row.id);
}
const childrenOf = (parentId: string | null) =>
	db()
		.select()
		.from(t.libraryEntries)
		.where(parentId ? eq(t.libraryEntries.parentId, parentId) : isNull(t.libraryEntries.parentId))
		.orderBy(asc(t.libraryEntries.name));

/** Keeps only the fields that belong to the entry's kind. */
function contentOf(input: z.infer<typeof libraryInput>) {
	const { kind } = input;
	return {
		name: input.name.trim(),
		url: kind === 'link' ? input.url : '',
		phone: kind === 'contact' ? input.phone : '',
		email: kind === 'contact' ? input.email : '',
		website: kind === 'contact' ? input.website : '',
		notes: kind === 'link' || kind === 'contact' ? input.notes : '',
		text: kind === 'note' ? input.text : ''
	};
}

/** A folder (or the Library root) with its children, or a single item. */
export async function libraryListing(id?: string | null) {
	if (!id) return { entry: null, children: await childrenOf(null), ancestors: [] };
	const entry = await findLibraryEntry(id);
	const [ancestors, children] = await Promise.all([
		folderPath(entry.parentId),
		entry.kind === 'folder' ? childrenOf(entry.id) : []
	]);
	return { entry, children, ancestors: ancestors.map(({ id, name }) => ({ id, name })) };
}
const SEARCH_LIMIT = 50;
/** Items whose name or text fields contain the query, with a short excerpt. */
export async function searchLibrary({ query, kind }: z.infer<typeof librarySearchInput>) {
	const pattern = `%${query.trim().replace(/[\\%_]/g, (c) => '\\' + c)}%`;
	const e = t.libraryEntries;
	const rows = await db()
		.select()
		.from(e)
		.where(
			and(
				or(
					...[e.name, e.notes, e.text, e.url, e.email, e.phone, e.website, e.filename].map(
						(column) => ilike(column, pattern)
					)
				),
				kind ? eq(e.kind, kind) : undefined
			)
		)
		.orderBy(asc(e.name))
		.limit(SEARCH_LIMIT);
	return rows.map((row) => ({
		id: row.id,
		parentId: row.parentId,
		kind: row.kind,
		name: row.name,
		excerpt: (row.text || row.notes || row.url || row.email || row.website).slice(0, 300),
		updatedAt: row.updatedAt
	}));
}
export async function createLibraryEntry(input: z.infer<typeof libraryInput>) {
	await checkParent(input.parentId);
	const [entry] = await db()
		.insert(t.libraryEntries)
		.values({ kind: input.kind, parentId: input.parentId, ...contentOf(input) })
		.returning();
	return entry;
}
/** Edits or moves an item; files can only be renamed or moved. */
export async function updateLibraryEntry(
	id: string | undefined,
	patch: z.infer<typeof libraryPatchInput>
) {
	const entry = await findLibraryEntry(id);
	const parentId = patch.parentId === undefined ? entry.parentId : patch.parentId;
	await checkParent(parentId, entry.kind === 'folder' ? entry.id : undefined);
	const content =
		entry.kind === 'file'
			? { name: patch.name?.trim() ?? entry.name }
			: contentOf(libraryInput.parse({ ...entry, ...patch }));
	const [updated] = await db()
		.update(t.libraryEntries)
		.set({ ...content, parentId, updatedAt: new Date() })
		.where(eq(t.libraryEntries.id, entry.id))
		.returning();
	return updated;
}

export const library: Handler = async ({ event, method, id, action, seq }) => {
	if (id === 'folders' && method === 'GET')
		return Response.json({
			folders: await db()
				.select({
					id: t.libraryEntries.id,
					parentId: t.libraryEntries.parentId,
					name: t.libraryEntries.name
				})
				.from(t.libraryEntries)
				.where(eq(t.libraryEntries.kind, 'folder'))
				.orderBy(asc(t.libraryEntries.name))
		});
	if (id === 'uploads' && method === 'POST') {
		const input = libraryUploadInput
			.extend({ size: libraryUploadInput.shape.size.max(maxUploadBytes()) })
			.parse(await readJson(event));
		await checkParent(input.parentId);
		const [entry] = await db()
			.insert(t.libraryEntries)
			.values({
				kind: 'file',
				name: input.filename,
				parentId: input.parentId,
				filename: input.filename,
				mimeType: input.mimeType || 'application/octet-stream',
				size: input.size,
				status: 'uploading'
			})
			.returning();
		return created({ entry, chunkSize: UPLOAD_CHUNK_SIZE });
	}
	if (!id && method === 'GET') return Response.json(await libraryListing(null));
	if (!id && method === 'POST')
		return created({ entry: await createLibraryEntry(libraryInput.parse(await readJson(event))) });

	if (!action && method === 'GET') return Response.json(await libraryListing(id));
	if (!action && method === 'PATCH')
		return Response.json({
			entry: await updateLibraryEntry(id, libraryPatchInput.parse(await readJson(event)))
		});
	const entry = await findLibraryEntry(id);
	if (!action && method === 'DELETE') {
		const fileIds = await db().transaction(async (tx) => {
			await tx
				.select({ id: t.libraryEntries.id })
				.from(t.libraryEntries)
				.where(eq(t.libraryEntries.id, entry.id))
				.for('update');
			const fileIds = await fileIdsWithin(tx, entry.id);
			await tx.delete(t.libraryEntries).where(eq(t.libraryEntries.id, entry.id));
			return fileIds;
		});
		await removeLibraryFiles(fileIds).catch((cause) =>
			console.error('Library file cleanup failed:', safeError(cause))
		);
		return ok();
	}

	if (entry.kind !== 'file') return;
	if (action === 'file' && method === 'GET') {
		if (entry.status !== 'ready') error(404, 'File is not ready yet.');
		return download(
			event,
			libraryFilePath(entry.id),
			entry.mimeType ?? 'application/octet-stream',
			entry.filename ?? entry.name
		);
	}
	if (action === 'chunks' && method === 'PUT') {
		await putLibraryChunk(
			entry.id,
			Number(seq),
			await boundedBody(event.request, UPLOAD_CHUNK_SIZE)
		);
		return ok();
	}
	if (action === 'complete' && method === 'POST')
		return Response.json({ entry: await completeLibraryUpload(entry.id) });
};
