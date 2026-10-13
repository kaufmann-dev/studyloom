import { z } from 'zod';
export const DEFAULT_MODEL = 'muse-spark-1.3-contributor';
export const TRANSCRIPTION_MODEL = 'muse-voice-transcribe-1.0';
export const UPLOAD_CHUNK_SIZE = 8 * 1024 * 1024;
export const MIME_TYPE =
	/^[A-Za-z0-9][A-Za-z0-9!#$%&'*+.^_`|~-]*\/[A-Za-z0-9][A-Za-z0-9!#$%&'*+.^_`|~-]*$/;
export const idSchema = z.uuid();
// Whitespace is kept while typing; only all-blank values are rejected. The length check
// aborts so an empty value reports the message once rather than once per check.
const nonBlank = (schema: z.ZodString, message: string) =>
	schema
		.min(1, { error: message, abort: true })
		.refine((value) => value.trim().length > 0, message);
const modelId = z.string().min(1).max(160).default(DEFAULT_MODEL);
export const modelInput = z.object({ modelId });
export const projectInput = z.object({
	name: nonBlank(z.string().max(160), 'Project name is required.'),
	description: z.string().max(4000).default('')
});
export const materialUploadInput = z.object({
	filename: z.string().min(1).max(255),
	mimeType: z.string().max(120).regex(MIME_TYPE).default('application/octet-stream'),
	size: z.number().int().positive()
});
export const recordingInput = z.object({
	name: z.string().trim().min(1).max(160),
	source: z.enum(['microphone', 'tab', 'both'])
});
export const LIBRARY_KIND_LABELS = {
	folder: 'Folder',
	file: 'File',
	link: 'Link',
	contact: 'Contact',
	note: 'Note'
} as const;
export type LibraryKind = keyof typeof LIBRARY_KIND_LABELS;
export type EditableLibraryKind = Exclude<LibraryKind, 'file'>;
function isWebUrl(value: string) {
	if (!/^https?:\/\//i.test(value)) return false;
	try {
		return Boolean(new URL(value).hostname);
	} catch {
		return false;
	}
}
const libraryWebUrl = z
	.string()
	.max(2048)
	.refine((value) => !value || isWebUrl(value), 'Enter an http or https URL.');
const libraryFields = {
	name: nonBlank(z.string().max(160), 'Name is required.'),
	parentId: idSchema.nullable(),
	url: libraryWebUrl,
	phone: z.string().max(100),
	email: z.union([z.email(), z.literal('')]),
	website: libraryWebUrl,
	notes: z.string().max(10000),
	text: z.string().max(100000)
};
export const libraryInput = z
	.object({
		kind: z.enum(['folder', 'link', 'contact', 'note']),
		name: libraryFields.name,
		parentId: libraryFields.parentId.default(null),
		url: libraryFields.url.default(''),
		phone: libraryFields.phone.default(''),
		email: libraryFields.email.default(''),
		website: libraryFields.website.default(''),
		notes: libraryFields.notes.default(''),
		text: libraryFields.text.default('')
	})
	.superRefine((value, context) => {
		if (value.kind === 'link' && !value.url)
			context.addIssue({ code: 'custom', path: ['url'], message: 'URL is required.' });
	});
// Patch fields carry no defaults: an omitted field must leave the stored value untouched.
export const libraryPatchInput = z.object(libraryFields).partial();
export const libraryUploadInput = z.object({
	parentId: idSchema.nullable().default(null),
	filename: z.string().trim().min(1).max(255),
	mimeType: z.string().max(120).default('application/octet-stream'),
	size: z.number().int().positive()
});
/** A web page to download and read as a project source. */
export const webSourceInput = z.object({
	url: nonBlank(z.string().trim().max(2048), 'Web address is required.').refine(
		isWebUrl,
		'Enter an http or https web address.'
	)
});
export const pinInput = z.object({
	targetType: z.enum(['project', 'library']),
	targetId: idSchema
});
export interface LibraryEntry {
	id: string;
	parentId: string | null;
	kind: LibraryKind;
	name: string;
	url: string;
	phone: string;
	email: string;
	website: string;
	notes: string;
	text: string;
	filename: string | null;
	mimeType: string | null;
	size: number;
	receivedBytes: number;
	status: 'uploading' | 'ready' | null;
	createdAt: string;
	updatedAt: string;
}
export type LibraryFolder = Pick<LibraryEntry, 'id' | 'parentId' | 'name'>;
export interface LibraryListing {
	entry: LibraryEntry | null;
	children: LibraryEntry[];
	ancestors: { id: string; name: string }[];
}
export interface Pin {
	id: string;
	targetType: 'project' | 'library';
	targetId: string;
	label: string;
	subtitle: string;
	createdAt: string;
}
const CLOCK_TIME = /^([01]\d|2[0-3]):[0-5]\d$/;
const dateField = z.iso.date('Choose a date.');
// An empty string means "no time", which is what an empty time input yields.
const timeField = z.union([z.literal(''), z.string().regex(CLOCK_TIME, 'Enter a time as HH:MM.')]);
const taskFields = {
	title: nonBlank(z.string().max(200), 'Title is required.'),
	notes: z.string().max(4000),
	dueDate: dateField,
	dueTime: timeField,
	projectId: idSchema.nullable()
};
export const taskInput = z.object({
	...taskFields,
	notes: taskFields.notes.default(''),
	dueTime: taskFields.dueTime.default(''),
	projectId: taskFields.projectId.default(null)
});
// Patch fields carry no defaults: an omitted field must leave the stored value untouched.
export const taskPatchInput = z.object({ ...taskFields, done: z.boolean() }).partial();
export const REPEAT_LABELS = {
	none: 'Does not repeat',
	daily: 'Every day',
	weekly: 'Every week',
	biweekly: 'Every 2 weeks',
	monthly: 'Every month',
	yearly: 'Every year'
} as const;
export type Repeat = keyof typeof REPEAT_LABELS;
const REPEATS = Object.keys(REPEAT_LABELS) as [Repeat, ...Repeat[]];
const spanFields = {
	title: nonBlank(z.string().max(200), 'Title is required.'),
	location: z.string().max(300),
	notes: z.string().max(4000),
	startDate: dateField,
	startTime: timeField,
	endDate: dateField,
	endTime: timeField
};
type Span = { startDate: string; startTime: string; endDate: string; endTime: string };
function checkSpan(value: Span, context: z.RefinementCtx) {
	if (!value.startTime !== !value.endTime)
		context.addIssue({
			code: 'custom',
			path: [value.startTime ? 'endTime' : 'startTime'],
			message: 'Set both a start and an end time, or neither.'
		});
	else if (`${value.endDate}T${value.endTime}` < `${value.startDate}T${value.startTime}`)
		context.addIssue({
			code: 'custom',
			path: [value.endDate < value.startDate ? 'endDate' : 'endTime'],
			message: 'The end cannot be before the start.'
		});
}
const eventFields = {
	...spanFields,
	repeat: z.enum(REPEATS),
	repeatUntil: z.union([z.literal(''), dateField]),
	projectId: idSchema.nullable()
};
export const eventInput = z
	.object({
		...eventFields,
		location: eventFields.location.default(''),
		notes: eventFields.notes.default(''),
		startTime: eventFields.startTime.default(''),
		endTime: eventFields.endTime.default(''),
		repeat: eventFields.repeat.default('none'),
		repeatUntil: eventFields.repeatUntil.default(''),
		projectId: eventFields.projectId.default(null)
	})
	.superRefine((value, context) => {
		checkSpan(value, context);
		if (value.repeatUntil && value.repeat !== 'none' && value.repeatUntil < value.startDate)
			context.addIssue({
				code: 'custom',
				path: ['repeatUntil'],
				message: 'The repeat cannot end before the first event.'
			});
	});
export const eventPatchInput = z.object(eventFields).partial();
export const occurrenceInput = z.object(spanFields).superRefine(checkSpan);
export const occurrencePatchInput = z.object(spanFields).partial();
export const exceptionInput = z.union([z.object({ cancelled: z.literal(true) }), occurrenceInput]);
export const feedInput = z.object({ timeZone: z.string().min(1).max(100) });
export const importInput = z.object({
	ics: z.string().min(1),
	timeZone: z.string().min(1).max(100),
	projectId: idSchema.nullable().default(null),
	commit: z.boolean().default(false)
});
export interface Task {
	id: string;
	projectId: string | null;
	projectName: string | null;
	title: string;
	notes: string;
	dueDate: string;
	dueTime: string | null;
	completedAt: string | null;
	createdAt: string;
	updatedAt: string;
}
export interface EventException {
	occurrenceDate: string;
	cancelled: boolean;
	title: string | null;
	location: string | null;
	notes: string | null;
	startDate: string | null;
	startTime: string | null;
	endDate: string | null;
	endTime: string | null;
}
export interface CalendarEvent {
	id: string;
	projectId: string | null;
	projectName: string | null;
	title: string;
	location: string;
	notes: string;
	startDate: string;
	/** Null on both ends means the event lasts all day. */
	startTime: string | null;
	endDate: string;
	endTime: string | null;
	repeat: Repeat;
	repeatUntil: string | null;
	exceptions: EventException[];
	createdAt: string;
	updatedAt: string;
}
/** One concrete occurrence of an event, with any single-occurrence change applied. */
export interface Occurrence {
	key: string;
	eventId: string;
	/** The original start date of this occurrence within its series. */
	occurrenceDate: string;
	title: string;
	location: string;
	notes: string;
	startDate: string;
	startTime: string | null;
	endDate: string;
	endTime: string | null;
	repeating: boolean;
	modified: boolean;
	projectId: string | null;
	projectName: string | null;
}
export interface CalendarFeed {
	/** Null while the feed is disabled. */
	url: string | null;
	timeZone: string | null;
}
export interface ImportSummary {
	events: number;
	tasks: number;
	/** How many of the events and tasks replace items that already exist. */
	updated: number;
	skipped: { reason: string; count: number }[];
}
export const sourceSelection = z.array(idSchema).min(1).max(500);
export const citationSchema = z.object({
	materialId: idSchema,
	locator: z.string().max(300),
	quote: z.string().max(2000).optional()
});
export const questionSchema = z
	.object({
		id: z.string().min(1).max(80),
		type: z.enum(['multiple_choice', 'written']),
		question: z.string().min(1).max(6000),
		options: z.array(z.string().min(1).max(2000)).max(8).default([]),
		correctAnswer: z.string().min(1).max(6000),
		rubric: z.string().min(1).max(6000),
		explanation: z.string().max(6000),
		citations: z.array(citationSchema).min(1).max(20)
	})
	.superRefine((q, ctx) => {
		if (
			q.type === 'multiple_choice' &&
			(q.options.length < 2 || !q.options.includes(q.correctAnswer))
		)
			ctx.addIssue({
				code: 'custom',
				message: 'Multiple-choice answers must exactly match an option.'
			});
		if (new Set(q.options).size !== q.options.length)
			ctx.addIssue({ code: 'custom', message: 'Answer options must be distinct.' });
		if (q.type === 'written' && q.options.length)
			ctx.addIssue({ code: 'custom', message: 'Written questions cannot contain options.' });
	});
export const quizSchema = z
	.object({ title: z.string().min(1).max(200), questions: z.array(questionSchema).min(1).max(50) })
	.superRefine((v, ctx) => {
		if (new Set(v.questions.map((q) => q.id)).size !== v.questions.length)
			ctx.addIssue({ code: 'custom', message: 'Question IDs must be unique.' });
	});
export const AUDIO_LENGTHS = {
	short: { words: 450, parts: 2, label: 'Short (~3 min)' },
	standard: { words: 1000, parts: 3, label: 'Standard (~7 min)' },
	long: { words: 1700, parts: 4, label: 'Long (~12 min)' }
} as const;
/** How an audio summary is spoken: one narrator, or a tutor explaining to a learner. */
export const AUDIO_STYLES = {
	narration: { label: 'Narration', speakers: ['narrator'] },
	dialogue: { label: 'Tutor and learner', speakers: ['tutor', 'learner'] }
} as const;
export type AudioStyle = keyof typeof AUDIO_STYLES;
/** Spoken study sessions: how many parts. */
export const SESSION_LENGTHS = {
	short: { segments: 4, label: 'Short (~10 min)' },
	standard: { segments: 6, label: 'Standard (~15 min)' },
	long: { segments: 9, label: 'Long (~25 min)' }
} as const;
const elevenLabsId = z.string().regex(/^[A-Za-z0-9_-]{1,100}$/, 'Choose a voice and model.');
export const generationInput = z.object({
	kind: z.enum(['summary', 'quiz', 'audio', 'session']),
	materialIds: sourceSelection,
	modelId,
	questionCount: z.number().int().min(1).max(50).default(10),
	questionMix: z.enum(['mixed', 'multiple_choice', 'written']).default('mixed'),
	/** ElevenLabs voices and speech model; audio summaries only. */
	voiceId: elevenLabsId.or(z.literal('')).default(''),
	learnerVoiceId: elevenLabsId.or(z.literal('')).default(''),
	speechModelId: elevenLabsId.or(z.literal('')).default(''),
	audioLength: z.enum(['short', 'standard', 'long']).default('short'),
	audioStyle: z.enum(['narration', 'dialogue']).default('narration'),
	/** Study sessions only. */
	sessionLength: z.enum(['short', 'standard', 'long']).default('standard')
});
export const chatInput = z.object({
	conversationId: idSchema.optional(),
	message: nonBlank(z.string().max(30000), 'Message is required.'),
	materialIds: sourceSelection,
	modelId
});
export const answersSchema = z.object({
	answers: z
		.array(
			z.object({
				questionId: z.string().min(1),
				value: nonBlank(z.string().max(12000), 'Answer is required.')
			})
		)
		.min(1)
		.max(50)
});
export const chunkResultSchema = z.object({
	locator: nonBlank(z.string().max(300), 'A source locator is required.'),
	text: nonBlank(z.string().max(60000), 'Readable source text is required.')
});
export const ingestionSchema = z
	.object({
		status: z.enum(['ready', 'partial', 'unreadable']),
		notes: z.string().max(10000),
		chunks: z.array(chunkResultSchema).max(20000),
		assets: z
			.array(
				z.object({
					path: z.string().min(1).max(500),
					label: z.string().max(200),
					mimeType: z.string().max(100),
					locator: z.string().max(300)
				})
			)
			.max(2000)
			.default([])
	})
	.superRefine((r, ctx) => {
		if (r.status !== 'unreadable' && !r.chunks.length)
			ctx.addIssue({ code: 'custom', message: 'Readable content is required for this status.' });
		if (r.status === 'unreadable' && r.chunks.length)
			ctx.addIssue({
				code: 'custom',
				message: 'Unreadable sources cannot contain readable content.'
			});
	});
/** A cited markdown text: a chat answer or an overview. */
export const citedTextSchema = z.object({
	title: z.string().min(1).max(200),
	content: z.string().min(1).max(200000),
	citations: z.array(citationSchema).min(1).max(500)
});
/** The script Muse writes for an audio summary, one spoken turn per speech request. */
export const audioScriptSchema = (style: AudioStyle) =>
	z.object({
		title: z.string().min(1).max(200),
		turns: z
			.array(
				z.object({
					speaker: z.enum(AUDIO_STYLES[style].speakers),
					text: z.string().trim().min(1).max(1500),
					/** Silence after the turn, giving the listener time to think. */
					pauseAfterSeconds: z.number().min(0).max(6).optional()
				})
			)
			.min(1)
			.max(160),
		citations: z.array(citationSchema).min(1).max(100)
	});
export type AudioScript = z.infer<ReturnType<typeof audioScriptSchema>>;
/** One part of a spoken study session: an explanation, then a question the learner answers aloud. */
export const studySegmentSchema = z.object({
	title: z.string().min(1).max(120),
	explanation: z.string().trim().min(1).max(1600),
	question: z.string().trim().min(1).max(400),
	keyPoints: z.array(z.string().min(1).max(300)).min(1).max(5),
	modelAnswer: z.string().min(1).max(1200),
	misconceptions: z.array(z.string().min(1).max(300)).max(3).default([]),
	citations: z.array(citationSchema).min(1).max(10)
});
export const studyPlanSchema = z.object({
	title: z.string().min(1).max(200),
	intro: z.string().trim().min(1).max(800),
	segments: z.array(studySegmentSchema).min(2).max(12)
});
export type StudyPlan = z.infer<typeof studyPlanSchema>;
export const STUDY_VERDICTS = ['correct', 'partial', 'incorrect', 'none'] as const;
export type StudyVerdict = (typeof STUDY_VERDICTS)[number];
/** The first line of every live feedback reply: the grade and what happens next. */
export const feedbackHeaderSchema = z.object({
	verdict: z.enum(STUDY_VERDICTS),
	next: z.enum(['continue', 'followUp', 'reexplain']),
	gap: z.string().max(160).default('')
});
export type FeedbackHeader = z.infer<typeof feedbackHeaderSchema>;
export const sourceSearchInput = z.object({
	query: nonBlank(z.string().max(500), 'A search query is required.').describe(
		'Words to find. Matching uses exact word forms without stemming, so try variants and synonyms. Supports "quoted phrases", OR and -exclusions.'
	),
	projectId: idSchema.optional().describe('Only search this project.'),
	materialIds: z.array(idSchema).min(1).max(500).optional().describe('Only search these sources.'),
	limit: z.number().int().min(1).max(50).default(10)
});
export const sourceReadInput = z.object({
	materialId: idSchema.describe('Source ID from get_project or search_sources.'),
	locator: z.string().max(300).optional().describe('Start reading at this locator.'),
	offset: z
		.number()
		.int()
		.nonnegative()
		.default(0)
		.describe('Start at this chunk position; pass nextOffset from a previous read to continue.'),
	maxChars: z.number().int().min(1000).max(100000).default(30000)
});
const MAX_TEXT_SOURCE_CHARS = 2_000_000;
/** Text pasted into a project as a source; without a name, its first line names it. */
export const pastedTextInput = z.object({
	name: z.string().max(160).default(''),
	text: nonBlank(
		z.string().max(MAX_TEXT_SOURCE_CHARS, 'Pasted text can hold at most 2,000,000 characters.'),
		'Paste some text.'
	)
});
export const textSourceInput = z
	.object({
		name: nonBlank(z.string().max(160), 'Source name is required.'),
		sections: z
			.array(chunkResultSchema)
			.min(1)
			.max(2000)
			.describe(
				'The text in logical sections. Each locator is a unique, citable section name such as "section:Definitions".'
			)
	})
	.superRefine((value, context) => {
		if (new Set(value.sections.map((s) => s.locator)).size !== value.sections.length)
			context.addIssue({ code: 'custom', path: ['sections'], message: 'Locators must be unique.' });
		if (value.sections.reduce((n, s) => n + s.text.length, 0) > MAX_TEXT_SOURCE_CHARS)
			context.addIssue({
				code: 'custom',
				path: ['sections'],
				message: 'A text source can hold at most 2,000,000 characters.'
			});
	});
export const librarySearchInput = z.object({
	query: nonBlank(z.string().max(200), 'A search query is required.'),
	kind: z.enum(['folder', 'file', 'link', 'contact', 'note']).optional()
});
export interface Connection {
	id: string;
	clientName: string;
	/** Who signed in to approve the connection. */
	userName: string;
	createdAt: string;
	lastUsedAt: string;
}
export type Citation = z.infer<typeof citationSchema>;
export type Quiz = z.infer<typeof quizSchema>;
export type Question = z.infer<typeof questionSchema>;
export type JobStatus = 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled';
export const isActiveJob = (job: { status: JobStatus }) =>
	job.status === 'queued' || job.status === 'running';
export interface Project {
	id: string;
	name: string;
	description: string;
	createdAt: string;
	updatedAt: string;
}
export interface Material {
	id: string;
	projectId: string;
	name: string;
	filename: string;
	mimeType: string;
	kind: 'file' | 'recording';
	status: 'uploading' | 'processing' | 'ready' | 'partial' | 'failed' | 'recording' | 'paused';
	size: number;
	receivedBytes: number;
	durationMs: number;
	/** Where a web page source was downloaded from; null for uploads and recordings. */
	sourceUrl: string | null;
	notes: string;
	createdAt: string;
	updatedAt: string;
}
export interface SourceChunk {
	id: string;
	materialId: string;
	ordinal: number;
	locator: string;
	text: string;
}
export interface TranscriptTurn {
	id: string;
	materialId: string;
	segmentId: string;
	turnId: number;
	startMs: number;
	endMs: number;
	text: string;
	speaker: string | null;
}
export interface MaterialDetails {
	material: Material;
	chunks: SourceChunk[];
	turns: TranscriptTurn[];
	assets: Asset[];
}
export interface ProjectWorkspace {
	project: Project;
	materials: Material[];
	readableMaterialIds: string[];
	conversations: Conversation[];
	outputs: StudyOutput[];
	jobs: Job[];
}
export interface Asset {
	id: string;
	materialId: string;
	label: string;
	mimeType: string;
	locator: string;
}
export interface Conversation {
	id: string;
	projectId: string;
	title: string;
	materialIds: string[];
	modelId: string;
	createdAt: string;
	updatedAt: string;
}
export interface Message {
	id: string;
	conversationId: string;
	role: 'user' | 'assistant';
	content: string;
	citations: Citation[];
	modelId: string | null;
	createdAt: string;
}
export interface AudioVoice {
	speaker: string;
	voiceId: string;
	voiceName: string;
}
export interface AudioInfo {
	style: AudioStyle;
	voices: AudioVoice[];
	speechModelId: string;
	speechModelName: string;
	durationMs: number;
	characters: number;
}
export interface StudyInfo {
	plan: StudyPlan;
	voiceId: string;
	voiceName: string;
	speechModelId: string;
	speechModelName: string;
	characters: number;
}
export interface StudyAnswer {
	id: string;
	segmentIndex: number;
	attempt: number;
	/** The transcript of the spoken answer; empty when the learner did not answer. */
	answer: string;
	verdict: StudyVerdict;
	next: FeedbackHeader['next'];
	gap: string;
	feedback: string;
	createdAt: string;
}
export interface StudyRun {
	id: string;
	outputId: string;
	status: 'active' | 'complete';
	segmentIndex: number;
	attempt: number;
	answers: StudyAnswer[];
	createdAt: string;
	completedAt: string | null;
}
export interface StudyOutput {
	id: string;
	projectId: string;
	kind: 'summary' | 'quiz' | 'audio' | 'session';
	title: string;
	content: string;
	quiz: Quiz | null;
	audio: AudioInfo | null;
	study: StudyInfo | null;
	citations: Citation[];
	materialIds: string[];
	modelId: string;
	createdAt: string;
}
export interface Grade {
	questionId: string;
	score: number;
	maxScore: number;
	feedback: string;
	correctAnswer: string;
	citations: Citation[];
}
export interface QuizAttempt {
	id: string;
	outputId: string;
	answers: { questionId: string; value: string }[];
	grades: Grade[];
	score: number | null;
	maxScore: number;
	status: 'grading' | 'complete' | 'failed';
	createdAt: string;
}
export interface Job {
	id: string;
	projectId: string;
	materialId: string | null;
	kind: string;
	status: JobStatus;
	progress: string;
	error: string | null;
	outputId: string | null;
	conversationId: string | null;
	attemptId: string | null;
	createdAt: string;
	updatedAt: string;
}
export interface MuseAccount {
	state: string;
	label?: string;
	credentialRequired: boolean;
}
export interface MuseStatus {
	account: MuseAccount;
	models: MuseModel[];
	error?: string;
}
export interface MuseModel {
	modelId: string;
	displayLabel: string;
	contextLimit: number | null;
	description: string | null;
}
export interface Voice {
	voiceId: string;
	name: string;
	description: string;
}
export interface SpeechModel {
	modelId: string;
	name: string;
	/** Credits per character relative to the plan's base rate. */
	costMultiplier: number;
	maxCharacters: number;
}
