import { mkdir, open, realpath, stat, rm, readFile } from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';
import { createHash } from 'node:crypto';
import { eq, and, asc, sql } from 'drizzle-orm';
import { db } from './db';
import { materials, uploadChunks } from './db/schema';
import { ClientError, dataDir, maxUploadBytes } from './config';
import { idSchema, UPLOAD_CHUNK_SIZE } from '../domain';
export const materialDir = (id: string) => join(dataDir(), 'materials', idSchema.parse(id));
export const originalPath = (id: string) => join(materialDir(id), 'original');
export const chunkPath = (id: string, sequence: number) =>
	join(materialDir(id), 'chunks', String(sequence));
export async function scopedFile(base: string, path: string) {
	const root = await realpath(base);
	const full = await realpath(resolve(base, path));
	if (!full.startsWith(root + sep)) throw new Error('File must be inside the job directory.');
	const info = await stat(full);
	if (!info.isFile()) throw new Error('Expected a regular file.');
	return full;
}
export function wavHeader(bytes: number) {
	if (bytes < 0 || bytes > 0xffffffff - 36 || bytes % 2) throw new Error('Invalid PCM size.');
	const h = Buffer.alloc(44);
	h.write('RIFF');
	h.writeUInt32LE(bytes + 36, 4);
	h.write('WAVEfmt ', 8);
	h.writeUInt32LE(16, 16);
	h.writeUInt16LE(1, 20);
	h.writeUInt16LE(1, 22);
	h.writeUInt32LE(24000, 24);
	h.writeUInt32LE(48000, 28);
	h.writeUInt16LE(2, 32);
	h.writeUInt16LE(16, 34);
	h.write('data', 36);
	h.writeUInt32LE(bytes, 40);
	return h;
}
export async function putChunk(id: string, sequence: number, body: Buffer, startSample?: number) {
	if (
		!Number.isSafeInteger(sequence) ||
		sequence < 0 ||
		!body.length ||
		body.length > UPLOAD_CHUNK_SIZE
	)
		throw new ClientError(400, 'Invalid chunk.');
	return db().transaction(async (tx) => {
		const [material] = await tx.select().from(materials).where(eq(materials.id, id)).for('update');
		if (!material) throw new ClientError(404, 'Source not found.');
		const hash = createHash('sha256').update(body).digest('hex');
		const [previous] = await tx
			.select()
			.from(uploadChunks)
			.where(and(eq(uploadChunks.materialId, id), eq(uploadChunks.sequence, sequence)));
		if (previous) {
			if (previous.hash !== hash || previous.startSample !== (startSample ?? null))
				throw new ClientError(409, 'Chunk conflicts with saved audio.');
			return { duplicate: true };
		}
		if (material.kind === 'file') {
			if (material.status !== 'uploading')
				throw new ClientError(409, 'Upload is already complete.');
			if (
				sequence * UPLOAD_CHUNK_SIZE >= material.size ||
				body.length !== Math.min(UPLOAD_CHUNK_SIZE, material.size - sequence * UPLOAD_CHUNK_SIZE)
			)
				throw new ClientError(400, 'Unexpected upload chunk size.');
		} else {
			if (!['recording', 'paused'].includes(material.status))
				throw new ClientError(409, 'Recording is already complete.');
			if (
				!Number.isSafeInteger(startSample) ||
				startSample! < 0 ||
				body.length % 2 ||
				body.length > 96000
			)
				throw new ClientError(400, 'Invalid PCM audio.');
			const [last] = await tx
				.select()
				.from(uploadChunks)
				.where(eq(uploadChunks.materialId, id))
				.orderBy(sql`${uploadChunks.sequence} desc`)
				.limit(1);
			if (
				sequence !== (last ? last.sequence + 1 : 0) ||
				startSample !== (last ? (last.startSample ?? 0) + last.size / 2 : 0)
			)
				throw new ClientError(409, 'Audio chunks must be contiguous.');
		}
		if (material.receivedBytes + body.length > maxUploadBytes())
			throw new ClientError(413, 'Source exceeds the configured upload limit.');
		await mkdir(join(materialDir(id), 'chunks'), { recursive: true, mode: 0o700 });
		const path = chunkPath(id, sequence);
		const file = await open(path, 'w', 0o600);
		try {
			try {
				await file.writeFile(body);
				await file.sync();
			} catch (error) {
				await rm(path, { force: true }).catch(() => {});
				throw error;
			}
		} finally {
			await file.close();
		}
		try {
			await tx.insert(uploadChunks).values({
				materialId: id,
				sequence,
				size: body.length,
				hash,
				startSample: startSample ?? null
			});
			await tx
				.update(materials)
				.set({
					receivedBytes: material.receivedBytes + body.length,
					updatedAt: new Date(),
					...(material.kind === 'recording'
						? {
								size: material.receivedBytes + body.length,
								durationMs: Math.round(((startSample ?? 0) + body.length / 2) / 24)
							}
						: {})
				})
				.where(eq(materials.id, id));
		} catch (error) {
			await rm(path, { force: true }).catch(() => {});
			throw error;
		}
		return { duplicate: false };
	});
}
export async function assemble(id: string, recording = false) {
	const chunks = await db()
		.select()
		.from(uploadChunks)
		.where(eq(uploadChunks.materialId, id))
		.orderBy(asc(uploadChunks.sequence));
	if (chunks.some((c, i) => c.sequence !== i))
		throw new ClientError(409, 'Some source chunks are missing.');
	await mkdir(materialDir(id), { recursive: true, mode: 0o700 });
	const file = await open(originalPath(id), 'w', 0o600);
	try {
		if (recording) await file.write(wavHeader(chunks.reduce((n, c) => n + c.size, 0)));
		for (const chunk of chunks) await file.write(await readFile(chunkPath(id, chunk.sequence)));
		await file.sync();
	} finally {
		await file.close();
	}
}
export async function removeMaterialFiles(id: string) {
	await rm(materialDir(id), { recursive: true, force: true });
}
