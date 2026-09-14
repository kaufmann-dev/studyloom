import {
	pgTable,
	text,
	uuid,
	timestamp,
	bigint,
	integer,
	jsonb,
	index,
	uniqueIndex,
	check
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import type { Citation, Quiz, Grade } from '../../domain';
const time = (name: string) => timestamp(name, { withTimezone: true }).notNull().defaultNow();
const pk = () => uuid('id').primaryKey().defaultRandom();
export const sessions = pgTable(
	'sessions',
	{
		id: text('id').primaryKey(),
		subject: text('subject').notNull(),
		name: text('name').notNull(),
		idToken: text('id_token').notNull(),
		createdAt: time('created_at'),
		lastActiveAt: time('last_active_at'),
		expiresAt: time('expires_at')
	},
	(t) => [index('sessions_expiry_idx').on(t.expiresAt)]
);
export const authFlows = pgTable('auth_flows', {
	id: text('id').primaryKey(),
	verifier: text('verifier').notNull(),
	nonce: text('nonce').notNull(),
	returnTo: text('return_to').notNull(),
	expiresAt: time('expires_at')
});
export const projects = pgTable('projects', {
	id: pk(),
	name: text('name').notNull(),
	description: text('description').notNull().default(''),
	createdAt: time('created_at'),
	updatedAt: time('updated_at')
});
export const materials = pgTable(
	'materials',
	{
		id: pk(),
		projectId: uuid('project_id')
			.notNull()
			.references(() => projects.id, { onDelete: 'cascade' }),
		name: text('name').notNull(),
		filename: text('filename').notNull(),
		mimeType: text('mime_type').notNull(),
		kind: text('kind').$type<'file' | 'recording'>().notNull(),
		status: text('status')
			.$type<'uploading' | 'processing' | 'ready' | 'partial' | 'failed' | 'recording' | 'paused'>()
			.notNull(),
		size: bigint('size', { mode: 'number' }).notNull().default(0),
		receivedBytes: bigint('received_bytes', { mode: 'number' }).notNull().default(0),
		durationMs: bigint('duration_ms', { mode: 'number' }).notNull().default(0),
		notes: text('notes').notNull().default(''),
		createdAt: time('created_at'),
		updatedAt: time('updated_at')
	},
	(t) => [
		index('materials_project_idx').on(t.projectId),
		check('material_size_nonnegative', sql`${t.size} >= 0`)
	]
);
export const uploadChunks = pgTable(
	'upload_chunks',
	{
		id: pk(),
		materialId: uuid('material_id')
			.notNull()
			.references(() => materials.id, { onDelete: 'cascade' }),
		sequence: integer('sequence').notNull(),
		size: integer('size').notNull(),
		hash: text('hash').notNull(),
		startSample: bigint('start_sample', { mode: 'number' })
	},
	(t) => [uniqueIndex('upload_chunk_sequence_idx').on(t.materialId, t.sequence)]
);
export const sourceChunks = pgTable(
	'source_chunks',
	{
		id: pk(),
		materialId: uuid('material_id')
			.notNull()
			.references(() => materials.id, { onDelete: 'cascade' }),
		ordinal: integer('ordinal').notNull(),
		locator: text('locator').notNull(),
		text: text('text').notNull()
	},
	(t) => [
		uniqueIndex('source_chunk_ordinal_idx').on(t.materialId, t.ordinal),
		index('source_chunk_search_idx').using('gin', sql`to_tsvector('simple', ${t.text})`)
	]
);
export const assets = pgTable(
	'assets',
	{
		id: pk(),
		materialId: uuid('material_id')
			.notNull()
			.references(() => materials.id, { onDelete: 'cascade' }),
		path: text('path').notNull(),
		label: text('label').notNull(),
		mimeType: text('mime_type').notNull(),
		locator: text('locator').notNull()
	},
	(t) => [index('assets_material_idx').on(t.materialId)]
);
export const recordingSegments = pgTable(
	'recording_segments',
	{
		id: uuid('id').primaryKey(),
		materialId: uuid('material_id')
			.notNull()
			.references(() => materials.id, { onDelete: 'cascade' }),
		startSample: bigint('start_sample', { mode: 'number' }).notNull(),
		endSample: bigint('end_sample', { mode: 'number' }),
		status: text('status').$type<'live' | 'complete' | 'interrupted' | 'recovered'>().notNull(),
		createdAt: time('created_at')
	},
	(t) => [index('recording_segments_material_idx').on(t.materialId)]
);
export const transcriptTurns = pgTable(
	'transcript_turns',
	{
		id: pk(),
		materialId: uuid('material_id')
			.notNull()
			.references(() => materials.id, { onDelete: 'cascade' }),
		segmentId: uuid('segment_id')
			.notNull()
			.references(() => recordingSegments.id, { onDelete: 'cascade' }),
		turnId: integer('turn_id').notNull(),
		startMs: bigint('start_ms', { mode: 'number' }).notNull(),
		endMs: bigint('end_ms', { mode: 'number' }).notNull(),
		text: text('text').notNull(),
		speaker: text('speaker')
	},
	(t) => [
		uniqueIndex('transcript_segment_turn_idx').on(t.segmentId, t.turnId),
		index('transcript_material_idx').on(t.materialId)
	]
);
export const conversations = pgTable(
	'conversations',
	{
		id: pk(),
		projectId: uuid('project_id')
			.notNull()
			.references(() => projects.id, { onDelete: 'cascade' }),
		title: text('title').notNull(),
		materialIds: jsonb('material_ids').$type<string[]>().notNull(),
		modelId: text('model_id').notNull(),
		createdAt: time('created_at'),
		updatedAt: time('updated_at')
	},
	(t) => [index('conversations_project_idx').on(t.projectId)]
);
export const messages = pgTable(
	'messages',
	{
		id: pk(),
		conversationId: uuid('conversation_id')
			.notNull()
			.references(() => conversations.id, { onDelete: 'cascade' }),
		role: text('role').$type<'user' | 'assistant'>().notNull(),
		content: text('content').notNull(),
		citations: jsonb('citations').$type<Citation[]>().notNull().default([]),
		modelId: text('model_id'),
		createdAt: time('created_at')
	},
	(t) => [index('messages_conversation_idx').on(t.conversationId)]
);
export const outputs = pgTable(
	'outputs',
	{
		id: pk(),
		projectId: uuid('project_id')
			.notNull()
			.references(() => projects.id, { onDelete: 'cascade' }),
		kind: text('kind').$type<'summary' | 'quiz'>().notNull(),
		title: text('title').notNull(),
		content: text('content').notNull(),
		quiz: jsonb('quiz').$type<Quiz>(),
		citations: jsonb('citations').$type<Citation[]>().notNull().default([]),
		materialIds: jsonb('material_ids').$type<string[]>().notNull(),
		sourceSnapshot: jsonb('source_snapshot')
			.$type<{ id: string; name: string; chunks: { locator: string; text: string }[] }[]>()
			.notNull(),
		modelId: text('model_id').notNull(),
		createdAt: time('created_at')
	},
	(t) => [index('outputs_project_idx').on(t.projectId)]
);
export const attempts = pgTable(
	'attempts',
	{
		id: pk(),
		outputId: uuid('output_id')
			.notNull()
			.references(() => outputs.id, { onDelete: 'cascade' }),
		answers: jsonb('answers').$type<{ questionId: string; value: string }[]>().notNull(),
		grades: jsonb('grades').$type<Grade[]>().notNull().default([]),
		score: integer('score'),
		maxScore: integer('max_score').notNull(),
		status: text('status').$type<'grading' | 'complete' | 'failed'>().notNull(),
		createdAt: time('created_at')
	},
	(t) => [index('attempts_output_idx').on(t.outputId)]
);
export const jobs = pgTable(
	'jobs',
	{
		id: pk(),
		projectId: uuid('project_id')
			.notNull()
			.references(() => projects.id, { onDelete: 'cascade' }),
		materialId: uuid('material_id').references(() => materials.id, { onDelete: 'cascade' }),
		kind: text('kind')
			.$type<'ingest' | 'chat' | 'summary' | 'quiz' | 'grade' | 'recover'>()
			.notNull(),
		queue: text('queue').$type<'interactive' | 'background'>().notNull(),
		status: text('status')
			.$type<'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled'>()
			.notNull()
			.default('queued'),
		payload: jsonb('payload').$type<Record<string, unknown>>().notNull().default({}),
		progress: text('progress').notNull().default('Waiting to start'),
		error: text('error'),
		outputId: uuid('output_id'),
		conversationId: uuid('conversation_id'),
		attemptId: uuid('attempt_id'),
		leaseOwner: text('lease_owner'),
		leaseUntil: timestamp('lease_until', { withTimezone: true }),
		tries: integer('tries').notNull().default(0),
		createdAt: time('created_at'),
		updatedAt: time('updated_at')
	},
	(t) => [
		index('jobs_claim_idx').on(t.queue, t.status, t.createdAt),
		index('jobs_project_idx').on(t.projectId),
		uniqueIndex('jobs_active_material_idx')
			.on(t.materialId)
			.where(sql`${t.status} in ('queued', 'running')`),
		uniqueIndex('jobs_active_conversation_idx')
			.on(t.conversationId)
			.where(sql`${t.status} in ('queued', 'running')`)
	]
);
