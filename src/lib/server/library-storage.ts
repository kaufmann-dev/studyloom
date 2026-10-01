import { createHash } from 'node:crypto';
import { open, readFile, rename, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { and, asc, eq } from 'drizzle-orm';
import { db } from './db';
import { libraryEntries, libraryUploadChunks } from './db/schema';
import { ClientError, dataDir } from './config';
import { isExpectedChunk, writeChunkFile } from './storage';
import { idSchema, UPLOAD_CHUNK_SIZE } from '../domain';

export const libraryDir = (id: string) => join(dataDir(), 'library', idSchema.parse(id));
export const libraryFilePath = (id: string) => join(libraryDir(id), 'original');
const chunkPath = (id: string, sequence: number) =>
	join(libraryDir(id), 'chunks', String(sequence));

export async function putLibraryChunk(id: string, sequence: number, bytes: Buffer) {
	if (
		!Number.isSafeInteger(sequence) ||
		sequence < 0 ||
		!bytes.length ||
		bytes.length > UPLOAD_CHUNK_SIZE
	)
		throw new ClientError(400, 'Invalid upload chunk.');
	return db().transaction(async (tx) => {
		const [entry] = await tx
			.select()
			.from(libraryEntries)
			.where(eq(libraryEntries.id, id))
			.for('update');
		if (!entry || entry.kind !== 'file') throw new ClientError(404, 'File not found.');
		const hash = createHash('sha256').update(bytes).digest('hex');
		const [previous] = await tx
			.select()
			.from(libraryUploadChunks)
			.where(and(eq(libraryUploadChunks.entryId, id), eq(libraryUploadChunks.sequence, sequence)));
		if (previous) {
			if (previous.hash !== hash)
				throw new ClientError(409, 'Upload chunk conflicts with saved data.');
			return;
		}
		if (entry.status !== 'uploading') throw new ClientError(409, 'Upload is already complete.');
		if (!isExpectedChunk(entry.size, sequence, bytes.length))
			throw new ClientError(400, 'Unexpected upload chunk size.');
		const path = chunkPath(id, sequence);
		await writeChunkFile(path, bytes);
		try {
			await tx
				.insert(libraryUploadChunks)
				.values({ entryId: id, sequence, size: bytes.length, hash });
			await tx
				.update(libraryEntries)
				.set({ receivedBytes: entry.receivedBytes + bytes.length, updatedAt: new Date() })
				.where(eq(libraryEntries.id, id));
		} catch (error) {
			await rm(path, { force: true }).catch(() => {});
			throw error;
		}
	});
}

export async function completeLibraryUpload(id: string) {
	const [entry] = await db().select().from(libraryEntries).where(eq(libraryEntries.id, id));
	if (!entry || entry.kind !== 'file') throw new ClientError(404, 'File not found.');
	if (entry.status === 'ready') return entry;
	if (entry.receivedBytes !== entry.size) throw new ClientError(409, 'Upload is incomplete.');
	const chunks = await db()
		.select()
		.from(libraryUploadChunks)
		.where(eq(libraryUploadChunks.entryId, id))
		.orderBy(asc(libraryUploadChunks.sequence));
	if (
		chunks.some((chunk, index) => chunk.sequence !== index) ||
		chunks.reduce((size, chunk) => size + chunk.size, 0) !== entry.size
	)
		throw new ClientError(409, 'Some upload chunks are missing.');
	const temporary = join(libraryDir(id), 'assembling');
	const file = await open(temporary, 'w', 0o600);
	try {
		for (const chunk of chunks) await file.writeFile(await readFile(chunkPath(id, chunk.sequence)));
		await file.sync();
	} catch (error) {
		await rm(temporary, { force: true }).catch(() => {});
		throw error;
	} finally {
		await file.close();
	}
	await rename(temporary, libraryFilePath(id));
	const [ready] = await db()
		.update(libraryEntries)
		.set({ status: 'ready', updatedAt: new Date() })
		.where(and(eq(libraryEntries.id, id), eq(libraryEntries.status, 'uploading')))
		.returning();
	if (!ready) throw new ClientError(409, 'File changed during upload.');
	await db().delete(libraryUploadChunks).where(eq(libraryUploadChunks.entryId, id));
	await rm(join(libraryDir(id), 'chunks'), { recursive: true, force: true });
	return ready;
}

export async function removeLibraryFiles(ids: string[]) {
	await Promise.all(ids.map((id) => rm(libraryDir(id), { recursive: true, force: true })));
}
