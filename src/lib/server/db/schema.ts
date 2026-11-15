import {
	pgTable,
	text,
	uuid,
	timestamp,
	bigint,
	integer,
	boolean,
	date,
	jsonb,
	index,
	uniqueIndex,
	check,
	primaryKey,
	real
} from 'drizzle-orm/pg-core';
import type { AnyPgColumn } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import type {
	AudioInfo,
	Citation,
	FeedbackHeader,
	JobKind,
	LessonInfo,
	QuestionAnswer,
	Quiz,
	Grade,
	Repeat,
	Snapshot,
	StudyInfo,
	StudyVerdict
} from '../../domain';
const time = (name: string) => timestamp(name, { withTimezone: true }).notNull().defaultNow();
const pk = () => uuid('id').primaryKey().defaultRandom();
/** Own items, or items synced read-only from the Moodle calendar. */
const source = () =>
	text('source', { enum: ['custom', 'moodle'] })
		.notNull()
		.default('custom');
const SOURCE_VALUES = sql.raw(`'custom', 'moodle'`);
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
export const libraryEntries = pgTable(
	'library_entries',
	{
		id: pk(),
		parentId: uuid('parent_id').references((): AnyPgColumn => libraryEntries.id, {
			onDelete: 'cascade'
		}),
		kind: text('kind').$type<'folder' | 'file' | 'link' | 'contact' | 'note'>().notNull(),
		name: text('name').notNull(),
		url: text('url').notNull().default(''),
		phone: text('phone').notNull().default(''),
		email: text('email').notNull().default(''),
		website: text('website').notNull().default(''),
		/** Contacts marked as lecturers can be assigned to projects. */
		lecturer: boolean('lecturer').notNull().default(false),
		notes: text('notes').notNull().default(''),
		text: text('text').notNull().default(''),
		filename: text('filename'),
		mimeType: text('mime_type'),
		size: bigint('size', { mode: 'number' }).notNull().default(0),
		receivedBytes: bigint('received_bytes', { mode: 'number' }).notNull().default(0),
		status: text('status').$type<'uploading' | 'ready'>(),
		createdAt: time('created_at'),
		updatedAt: time('updated_at')
	},
	(t) => [
		index('library_parent_idx').on(t.parentId),
		check('library_kind_check', sql`${t.kind} in ('folder', 'file', 'link', 'contact', 'note')`),
		check('library_not_own_parent_check', sql`${t.parentId} is distinct from ${t.id}`),
		check('library_lecturer_contact_check', sql`not ${t.lecturer} or ${t.kind} = 'contact'`),
		check(
			'library_size_check',
			sql`${t.size} >= 0 and ${t.receivedBytes} >= 0 and ${t.receivedBytes} <= ${t.size}`
		)
	]
);
/** Library contacts lecturing a project, in the order the user listed them. */
export const projectLecturers = pgTable(
	'project_lecturers',
	{
		projectId: uuid('project_id')
			.notNull()
			.references(() => projects.id, { onDelete: 'cascade' }),
		contactId: uuid('contact_id')
			.notNull()
			.references(() => libraryEntries.id, { onDelete: 'cascade' }),
		position: integer('position').notNull()
	},
	(t) => [
		primaryKey({ columns: [t.projectId, t.contactId] }),
		index('project_lecturers_contact_idx').on(t.contactId)
	]
);
export const libraryUploadChunks = pgTable(
	'library_upload_chunks',
	{
		id: pk(),
		entryId: uuid('entry_id')
			.notNull()
			.references(() => libraryEntries.id, { onDelete: 'cascade' }),
		sequence: integer('sequence').notNull(),
		size: integer('size').notNull(),
		hash: text('hash').notNull()
	},
	(t) => [uniqueIndex('library_upload_chunk_sequence_idx').on(t.entryId, t.sequence)]
);
export const pins = pgTable(
	'pins',
	{
		id: pk(),
		projectId: uuid('project_id').references(() => projects.id, { onDelete: 'cascade' }),
		libraryId: uuid('library_id').references(() => libraryEntries.id, { onDelete: 'cascade' }),
		createdAt: time('created_at')
	},
	(t) => [
		uniqueIndex('pins_project_idx').on(t.projectId),
		uniqueIndex('pins_library_idx').on(t.libraryId),
		check('pins_one_target_check', sql`(${t.projectId} is null) <> (${t.libraryId} is null)`)
	]
);
const CLOCK_TIME = sql.raw(`'^([01][0-9]|2[0-3]):[0-5][0-9]$'`);
export const tasks = pgTable(
	'tasks',
	{
		id: pk(),
		uid: text('uid').notNull(),
		projectId: uuid('project_id').references(() => projects.id, { onDelete: 'cascade' }),
		title: text('title').notNull(),
		notes: text('notes').notNull().default(''),
		dueDate: date('due_date', { mode: 'string' }).notNull(),
		dueTime: text('due_time'),
		completedAt: timestamp('completed_at', { withTimezone: true }),
		source: source(),
		createdAt: time('created_at'),
		updatedAt: time('updated_at')
	},
	(t) => [
		uniqueIndex('tasks_uid_idx').on(t.uid),
		index('tasks_due_idx').on(t.completedAt, t.dueDate),
		index('tasks_project_idx').on(t.projectId),
		check('tasks_due_time_check', sql`${t.dueTime} is null or ${t.dueTime} ~ ${CLOCK_TIME}`),
		check('tasks_source_check', sql`${t.source} in (${SOURCE_VALUES})`)
	]
);
export const events = pgTable(
	'events',
	{
		id: pk(),
		uid: text('uid').notNull(),
		projectId: uuid('project_id').references(() => projects.id, { onDelete: 'cascade' }),
		title: text('title').notNull(),
		location: text('location').notNull().default(''),
		notes: text('notes').notNull().default(''),
		startDate: date('start_date', { mode: 'string' }).notNull(),
		startTime: text('start_time'),
		endDate: date('end_date', { mode: 'string' }).notNull(),
		endTime: text('end_time'),
		repeat: text('repeat').$type<Repeat>().notNull().default('none'),
		repeatUntil: date('repeat_until', { mode: 'string' }),
		source: source(),
		createdAt: time('created_at'),
		updatedAt: time('updated_at')
	},
	(t) => [
		uniqueIndex('events_uid_idx').on(t.uid),
		index('events_range_idx').on(t.startDate, t.endDate),
		index('events_project_idx').on(t.projectId),
		check(
			'events_repeat_check',
			sql`${t.repeat} in ('none', 'daily', 'weekly', 'biweekly', 'monthly', 'yearly')`
		),
		check(
			'events_time_check',
			sql`(${t.startTime} is null) = (${t.endTime} is null) and (${t.startTime} is null or (${t.startTime} ~ ${CLOCK_TIME} and ${t.endTime} ~ ${CLOCK_TIME}))`
		),
		check(
			'events_order_check',
			sql`(${t.endDate}, coalesce(${t.endTime}, '')) >= (${t.startDate}, coalesce(${t.startTime}, ''))`
		),
		check('events_until_check', sql`${t.repeatUntil} is null or ${t.repeat} <> 'none'`),
		check('events_source_check', sql`${t.source} in (${SOURCE_VALUES})`)
	]
);
export const eventExceptions = pgTable(
	'event_exceptions',
	{
		id: pk(),
		eventId: uuid('event_id')
			.notNull()
			.references(() => events.id, { onDelete: 'cascade' }),
		occurrenceDate: date('occurrence_date', { mode: 'string' }).notNull(),
		cancelled: boolean('cancelled').notNull().default(false),
		title: text('title'),
		location: text('location'),
		notes: text('notes'),
		startDate: date('start_date', { mode: 'string' }),
		startTime: text('start_time'),
		endDate: date('end_date', { mode: 'string' }),
		endTime: text('end_time')
	},
	(t) => [
		uniqueIndex('event_exceptions_occurrence_idx').on(t.eventId, t.occurrenceDate),
		check(
			'event_exceptions_override_check',
			sql`${t.cancelled} or (${t.title} is not null and ${t.startDate} is not null and ${t.endDate} is not null)`
		)
	]
);
export const calendarFeed = pgTable(
	'calendar_feed',
	{
		id: integer('id').primaryKey().default(1),
		token: text('token'),
		timeZone: text('time_zone').notNull(),
		updatedAt: time('updated_at')
	},
	(t) => [check('calendar_feed_single_check', sql`${t.id} = 1`)]
);
/** The Moodle calendar subscription; its URL holds an authentication token. */
export const moodleCalendar = pgTable(
	'moodle_calendar',
	{
		id: integer('id').primaryKey().default(1),
		url: text('url'),
		timeZone: text('time_zone').notNull(),
		lastSyncedAt: timestamp('last_synced_at', { withTimezone: true }),
		lastError: text('last_error'),
		updatedAt: time('updated_at')
	},
	(t) => [check('moodle_calendar_single_check', sql`${t.id} = 1`)]
);
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
			.$type<
				| 'uploading'
				| 'stored'
				| 'processing'
				| 'ready'
				| 'partial'
				| 'failed'
				| 'recording'
				| 'paused'
			>()
			.notNull(),
		size: bigint('size', { mode: 'number' }).notNull().default(0),
		receivedBytes: bigint('received_bytes', { mode: 'number' }).notNull().default(0),
		durationMs: bigint('duration_ms', { mode: 'number' }).notNull().default(0),
		/** The address a web page source was downloaded from. */
		sourceUrl: text('source_url'),
		/** Whether the extracted text is Markdown (Claude's extraction) or plain text as it came. */
		contentFormat: text('content_format').$type<'plain' | 'markdown'>().notNull().default('plain'),
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
		/** Exercises and their solutions are told apart from the text that teaches. */
		kind: text('kind').$type<'text' | 'exercise' | 'solution'>().notNull().default('text'),
		text: text('text').notNull()
	},
	(t) => [uniqueIndex('source_chunk_ordinal_idx').on(t.materialId, t.ordinal)]
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
		kind: text('kind').$type<'summary' | 'quiz' | 'audio' | 'session' | 'lesson'>().notNull(),
		title: text('title').notNull(),
		content: text('content').notNull(),
		quiz: jsonb('quiz').$type<Quiz>(),
		audio: jsonb('audio').$type<AudioInfo>(),
		study: jsonb('study').$type<StudyInfo>(),
		lesson: jsonb('lesson').$type<LessonInfo>(),
		citations: jsonb('citations').$type<Citation[]>().notNull().default([]),
		materialIds: jsonb('material_ids').$type<string[]>().notNull(),
		sourceSnapshot: jsonb('source_snapshot').$type<Snapshot>().notNull(),
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
		answers: jsonb('answers').$type<QuestionAnswer[]>().notNull(),
		grades: jsonb('grades').$type<Grade[]>().notNull().default([]),
		// Fields may carry half points.
		score: real('score'),
		maxScore: real('max_score').notNull(),
		status: text('status').$type<'grading' | 'complete' | 'failed'>().notNull(),
		createdAt: time('created_at')
	},
	(t) => [index('attempts_output_idx').on(t.outputId)]
);
/** Every answer a learner gave in a lesson; the newest one per question is the current one. */
export const lessonAnswers = pgTable(
	'lesson_answers',
	{
		id: pk(),
		outputId: uuid('output_id')
			.notNull()
			.references(() => outputs.id, { onDelete: 'cascade' }),
		questionId: text('question_id').notNull(),
		values: jsonb('values').$type<QuestionAnswer['values']>().notNull(),
		result: jsonb('result').$type<Grade>().notNull(),
		score: real('score').notNull(),
		maxScore: real('max_score').notNull(),
		status: text('status').$type<'graded' | 'grading' | 'failed'>().notNull(),
		feedback: text('feedback').notNull().default(''),
		createdAt: time('created_at')
	},
	(t) => [index('lesson_answers_question_idx').on(t.outputId, t.questionId, t.createdAt)]
);
/** One spoken pass through a study session; its position survives disconnects. */
export const studyRuns = pgTable(
	'study_runs',
	{
		id: pk(),
		outputId: uuid('output_id')
			.notNull()
			.references(() => outputs.id, { onDelete: 'cascade' }),
		status: text('status').$type<'active' | 'complete'>().notNull().default('active'),
		segmentIndex: integer('segment_index').notNull().default(0),
		attempt: integer('attempt').notNull().default(1),
		createdAt: time('created_at'),
		updatedAt: time('updated_at'),
		completedAt: timestamp('completed_at', { withTimezone: true })
	},
	(t) => [index('study_runs_output_idx').on(t.outputId)]
);
/** A spoken answer's transcript and the tutor's graded feedback; answer audio is never kept. */
export const studyAnswers = pgTable(
	'study_answers',
	{
		id: pk(),
		runId: uuid('run_id')
			.notNull()
			.references(() => studyRuns.id, { onDelete: 'cascade' }),
		segmentIndex: integer('segment_index').notNull(),
		attempt: integer('attempt').notNull(),
		answer: text('answer').notNull(),
		verdict: text('verdict').$type<StudyVerdict>().notNull(),
		next: text('next').$type<FeedbackHeader['next']>().notNull(),
		gap: text('gap').notNull().default(''),
		feedback: text('feedback').notNull(),
		createdAt: time('created_at')
	},
	(t) => [uniqueIndex('study_answers_turn_idx').on(t.runId, t.segmentIndex, t.attempt)]
);
export const jobs = pgTable(
	'jobs',
	{
		id: pk(),
		projectId: uuid('project_id')
			.notNull()
			.references(() => projects.id, { onDelete: 'cascade' }),
		materialId: uuid('material_id').references(() => materials.id, { onDelete: 'cascade' }),
		kind: text('kind').$type<JobKind>().notNull(),
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
		lessonAnswerId: uuid('lesson_answer_id'),
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
