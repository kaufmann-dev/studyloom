import { error } from '@sveltejs/kit';
import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import type { z } from 'zod';
import { db } from './db';
import * as t from './db/schema';
import { findProject, lockProject } from './endpoints/queries';
import { textSections } from './extract';
import { replaceSourceChunks } from './jobs';
import { validateModel } from './claude';
import { materialDir, originalPath, removeMaterialFiles } from './storage';
import { fetchWebPage } from './web-page';
import type { pastedTextInput, webSourceInput } from '../domain';

const publicMaterial = (material: typeof t.materials.$inferSelect) => ({
	id: material.id,
	projectId: material.projectId,
	name: material.name,
	kind: material.kind,
	mimeType: material.mimeType,
	status: material.status,
	durationMs: material.durationMs,
	sourceUrl: material.sourceUrl,
	notes: material.notes,
	createdAt: material.createdAt
});

/** Saves text that needs no extraction as a ready, immediately searchable source. */
async function storeReadySource(
	projectId: string,
	source: {
		name: string;
		filename: string;
		mimeType: string;
		original: string;
		sections: { locator: string; text: string }[];
		notes: string;
	}
) {
	const project = await findProject(projectId);
	const id = randomUUID();
	const size = Buffer.byteLength(source.original);
	try {
		await mkdir(materialDir(id), { recursive: true, mode: 0o700 });
		await writeFile(originalPath(id), source.original, { mode: 0o600 });
		const material = await db().transaction(async (tx) => {
			if (!(await lockProject(tx, project.id))) error(404, 'Project not found.');
			const [material] = await tx
				.insert(t.materials)
				.values({
					id,
					projectId: project.id,
					name: source.name,
					filename: source.filename,
					mimeType: source.mimeType,
					kind: 'file',
					status: 'ready',
					size,
					receivedBytes: size,
					notes: source.notes
				})
				.returning();
			await replaceSourceChunks(tx, id, source.sections);
			return material;
		});
		return { material: publicMaterial(material) };
	} catch (cause) {
		await removeMaterialFiles(id).catch(() => {});
		throw cause;
	}
}

/** Stores text pasted in the browser as-is, named after its first line unless named. */
export function addPastedText(projectId: string, input: z.infer<typeof pastedTextInput>) {
	const firstLine = input.text.trim().split('\n')[0].trim();
	const name =
		input.name.trim() ||
		(firstLine.length > 60 ? `${firstLine.slice(0, 57).trimEnd()}…` : firstLine);
	return storeReadySource(projectId, {
		name,
		filename: `${name.replace(/[\\/:*?"<>|]/g, '-')}.txt`,
		mimeType: 'text/plain',
		original: input.text,
		sections: textSections(input.text),
		notes: 'Pasted text.'
	});
}

/**
 * Downloads a web page, keeps the copy as the source's original and queues extraction, so it is
 * read exactly like an upload. The download happens first: a bad address fails before any
 * source exists.
 */
export async function addWebSource(
	projectId: string,
	input: z.infer<typeof webSourceInput> & { modelId: string }
) {
	const project = await findProject(projectId);
	await validateModel(input.modelId);
	const page = await fetchWebPage(input.url);
	const id = randomUUID();
	try {
		await mkdir(materialDir(id), { recursive: true, mode: 0o700 });
		await writeFile(originalPath(id), page.body, { mode: 0o600 });
		return await db().transaction(async (tx) => {
			if (!(await lockProject(tx, project.id))) error(404, 'Project not found.');
			const [material] = await tx
				.insert(t.materials)
				.values({
					id,
					projectId: project.id,
					name: page.name,
					filename: page.filename,
					mimeType: page.mimeType,
					kind: 'file',
					status: 'processing',
					size: page.body.length,
					receivedBytes: page.body.length,
					sourceUrl: page.url
				})
				.returning();
			const [job] = await tx
				.insert(t.jobs)
				.values({
					projectId: project.id,
					materialId: id,
					kind: 'ingest',
					queue: 'background',
					payload: { modelId: input.modelId }
				})
				.returning();
			return { material, job };
		});
	} catch (cause) {
		await removeMaterialFiles(id).catch(() => {});
		throw cause;
	}
}
