import { error } from '@sveltejs/kit';
import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { and, asc, count, desc, eq, gte, inArray, sql } from 'drizzle-orm';
import type { z } from 'zod';
import { db } from './db';
import * as t from './db/schema';
import { ClientError, origin } from './config';
import { findMaterial, findProject, lockProject } from './endpoints/queries';
import { publicOutput } from './endpoints/study';
import { findInvalidCitation, replaceSourceChunks, sourceSnapshot } from './jobs';
import { materialDir, originalPath, removeMaterialFiles } from './storage';
import type {
	Citation,
	Quiz,
	citedTextSchema,
	sourceReadInput,
	sourceSearchInput,
	textSourceInput
} from '../domain';

const READ_BATCH = 100;

const projectUrl = (projectId: string) => `${origin()}/projects/${projectId}`;
const publicMaterial = (material: typeof t.materials.$inferSelect) => ({
	id: material.id,
	projectId: material.projectId,
	name: material.name,
	kind: material.kind,
	mimeType: material.mimeType,
	status: material.status,
	durationMs: material.durationMs,
	notes: material.notes,
	createdAt: material.createdAt
});

/**
 * Full-text search over extracted source text. The match expression must stay identical to the
 * `source_chunk_search_idx` index expression so Postgres can use it.
 */
export async function searchSources(input: z.infer<typeof sourceSearchInput>) {
	const document = sql`to_tsvector('simple', ${t.sourceChunks.text})`;
	const query = sql`websearch_to_tsquery('simple', ${input.query})`;
	return db()
		.select({
			projectId: t.projects.id,
			projectName: t.projects.name,
			materialId: t.materials.id,
			materialName: t.materials.name,
			locator: t.sourceChunks.locator,
			snippet: sql<string>`ts_headline('simple', ${t.sourceChunks.text}, ${query}, 'StartSel=**, StopSel=**, MaxFragments=2, MaxWords=30, MinWords=10')`
		})
		.from(t.sourceChunks)
		.innerJoin(t.materials, eq(t.materials.id, t.sourceChunks.materialId))
		.innerJoin(t.projects, eq(t.projects.id, t.materials.projectId))
		.where(
			and(
				sql`${document} @@ ${query}`,
				input.projectId ? eq(t.materials.projectId, input.projectId) : undefined,
				input.materialIds ? inArray(t.sourceChunks.materialId, input.materialIds) : undefined
			)
		)
		.orderBy(desc(sql`ts_rank(${document}, ${query})`))
		.limit(input.limit);
}

/** A source's text in order, from an offset or a locator, up to about `maxChars` characters. */
export async function readSource(input: z.infer<typeof sourceReadInput>) {
	const material = await findMaterial(input.materialId);
	const inMaterial = eq(t.sourceChunks.materialId, material.id);
	let offset = input.offset;
	if (input.locator !== undefined) {
		const [start] = await db()
			.select({ ordinal: t.sourceChunks.ordinal })
			.from(t.sourceChunks)
			.where(and(inMaterial, eq(t.sourceChunks.locator, input.locator)));
		if (!start) throw new ClientError(404, `This source has no locator "${input.locator}".`);
		offset = start.ordinal;
	}
	const [{ total }] = await db().select({ total: count() }).from(t.sourceChunks).where(inMaterial);
	const chunks: { locator: string; text: string }[] = [];
	let size = 0;
	reading: for (let next = offset; next < total; next += READ_BATCH) {
		const rows = await db()
			.select({ locator: t.sourceChunks.locator, text: t.sourceChunks.text })
			.from(t.sourceChunks)
			.where(and(inMaterial, gte(t.sourceChunks.ordinal, next)))
			.orderBy(asc(t.sourceChunks.ordinal))
			.limit(READ_BATCH);
		for (const row of rows) {
			// The first chunk is always returned, even when it alone exceeds the budget.
			if (chunks.length && size + row.text.length > input.maxChars) break reading;
			chunks.push(row);
			size += row.text.length;
		}
	}
	const end = offset + chunks.length;
	return {
		material: publicMaterial(material),
		totalChunks: total,
		offset,
		nextOffset: end < total ? end : null,
		chunks
	};
}

/** Stores text written by an MCP client as a ready source; it needs no extraction. */
export async function addTextSource(
	projectId: string,
	input: z.infer<typeof textSourceInput>,
	author: string
) {
	const project = await findProject(projectId);
	const id = randomUUID();
	const markdown = input.sections.map((s) => `## ${s.locator}\n\n${s.text}\n`).join('\n');
	const size = Buffer.byteLength(markdown);
	try {
		await mkdir(materialDir(id), { recursive: true, mode: 0o700 });
		await writeFile(originalPath(id), markdown, { mode: 0o600 });
		const material = await db().transaction(async (tx) => {
			if (!(await lockProject(tx, project.id))) error(404, 'Project not found.');
			const [material] = await tx
				.insert(t.materials)
				.values({
					id,
					projectId: project.id,
					name: input.name.trim(),
					filename: `${input.name.trim()}.md`,
					mimeType: 'text/markdown',
					kind: 'file',
					status: 'ready',
					size,
					receivedBytes: size,
					notes: `Added by ${author} via MCP.`
				})
				.returning();
			await replaceSourceChunks(tx, id, input.sections);
			return material;
		});
		return { material: publicMaterial(material), url: projectUrl(project.id) };
	} catch (cause) {
		await removeMaterialFiles(id).catch(() => {});
		throw cause;
	}
}

async function saveOutput(
	projectId: string,
	output: Pick<typeof t.outputs.$inferInsert, 'kind' | 'title' | 'content' | 'quiz'> & {
		citations: Citation[];
	},
	author: string
) {
	const project = await findProject(projectId);
	const snapshot = await sourceSnapshot(project.id, [
		...new Set(output.citations.map((c) => c.materialId))
	]);
	const invalid = findInvalidCitation(output.citations, snapshot);
	if (invalid)
		throw new ClientError(
			400,
			`The citation of ${invalid.materialId} at "${invalid.locator}" does not match the source. Use a locator from search_sources or read_source, and quote its text exactly.`
		);
	const saved = await db().transaction(async (tx) => {
		if (!(await lockProject(tx, project.id))) error(404, 'Project not found.');
		const [saved] = await tx
			.insert(t.outputs)
			.values({
				...output,
				projectId: project.id,
				materialIds: snapshot.map((m) => m.id),
				sourceSnapshot: snapshot,
				modelId: `${author} (MCP)`
			})
			.returning();
		return saved;
	});
	const { id, kind, title, materialIds, createdAt } = publicOutput(saved);
	return { id, kind, title, materialIds, createdAt, url: projectUrl(project.id) };
}
export const saveOverview = (
	projectId: string,
	input: z.infer<typeof citedTextSchema>,
	author: string
) => saveOutput(projectId, { kind: 'summary', quiz: null, ...input }, author);
export const saveQuiz = (projectId: string, quiz: Quiz, author: string) =>
	saveOutput(
		projectId,
		{
			kind: 'quiz',
			title: quiz.title,
			content: '',
			quiz,
			citations: quiz.questions.flatMap((q) => q.citations)
		},
		author
	);
