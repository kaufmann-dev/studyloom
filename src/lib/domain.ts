import { z } from 'zod';
/** Claude Code's recommended model for the account; it follows new model releases. */
export const DEFAULT_MODEL = 'default';
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
/** Starting extraction is optional: a stored source can be processed later. */
export const processInput = modelInput.extend({ process: z.boolean().default(true) });
export const projectInput = z.object({
	name: nonBlank(z.string().max(160), 'Project name is required.'),
	lecturerIds: z
		.array(idSchema)
		.max(20, 'Choose at most 20 lecturers.')
		.default([])
		.refine((ids) => new Set(ids).size === ids.length, 'Each lecturer can be listed once.'),
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
	lecturer: z.boolean(),
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
		lecturer: libraryFields.lecturer.default(false),
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
	/** Only contacts; lecturers can be assigned to projects. */
	lecturer: boolean;
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
export const exceptionInput = z.union([z.object({ cancelled: z.literal(true) }), occurrenceInput]);
export const feedInput = z.object({ timeZone: z.string().min(1).max(100) });
export const moodleInput = z.object({
	url: z
		.url({ protocol: /^https$/, error: 'Paste the https:// calendar address from Moodle.' })
		.max(2000),
	timeZone: z.string().min(1).max(100)
});
/** Own items, or items synced read-only from the Moodle calendar. */
export type CalendarSource = 'custom' | 'moodle';
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
	source: CalendarSource;
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
	source: CalendarSource;
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
	source: CalendarSource;
	projectId: string | null;
	projectName: string | null;
}
export interface CalendarFeed {
	/** Null while the feed is disabled. */
	url: string | null;
	timeZone: string | null;
}
export interface MoodleCalendar {
	connected: boolean;
	/** The Moodle site; the address itself holds a token and never leaves the server. */
	host: string | null;
	timeZone: string | null;
	lastSyncedAt: string | null;
	lastError: string | null;
	events: number;
	tasks: number;
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
/** How much of the selected sources a generated study tool covers; its size follows from that. */
export const COVERAGES = {
	light: { label: 'Light', hint: 'The core ideas only' },
	standard: { label: 'Standard', hint: 'Every major topic' },
	comprehensive: { label: 'Comprehensive', hint: 'Every concept, formula and source exercise' }
} as const;
export type Coverage = keyof typeof COVERAGES;
export const COVERAGE_NAMES = Object.keys(COVERAGES) as [Coverage, ...Coverage[]];
/** What coverage means to the model that writes the study tool. */
export const COVERAGE_BRIEFS: Record<Coverage, string> = {
	light: 'Light coverage: only the core ideas a learner must not miss; leave details out.',
	standard: 'Standard coverage: every major topic of the sources, without minor details.',
	comprehensive:
		'Comprehensive coverage: every concept, definition, formula and worked example of the sources, in the detail an exam demands.'
};
type Sized = 'audio' | 'session' | 'quiz' | 'lesson';
/** Per kind and coverage: one unit per this many source characters, and the least and most units. */
const SIZES: Record<Sized, Record<Coverage, [per: number, least: number, most: number]>> = {
	// words
	audio: { light: [400, 300, 900], standard: [150, 600, 2500], comprehensive: [60, 1000, 6000] },
	// segments
	session: { light: [15000, 3, 5], standard: [8000, 4, 9], comprehensive: [4000, 6, 16] },
	// questions
	quiz: { light: [6000, 5, 15], standard: [3000, 8, 40], comprehensive: [1500, 12, 120] },
	// sections
	lesson: { light: [8000, 3, 12], standard: [4000, 5, 40], comprehensive: [2000, 8, 120] }
};
export interface SourceStats {
	/** Characters of extracted text in the selected sources. */
	characters: number;
	/** Exercises the sources themselves contain. */
	exercises: number;
}
export function sourceStats(snapshot: Snapshot): SourceStats {
	const chunks = snapshot.flatMap((source) => source.chunks);
	return {
		characters: chunks.reduce((sum, chunk) => sum + chunk.text.length, 0),
		exercises: chunks.filter((chunk) => chunk.kind === 'exercise').length
	};
}
/**
 * The size a study tool should have: it grows with the sources and with the coverage. A
 * comprehensive quiz is never smaller than the number of exercises the sources contain.
 */
export function coverageBudget(kind: Sized, coverage: Coverage, stats: SourceStats) {
	const [per, least, most] = SIZES[kind][coverage];
	const sized = Math.min(most, Math.max(least, Math.round(stats.characters / per)));
	const target =
		kind === 'quiz' && coverage === 'comprehensive' ? Math.max(sized, stats.exercises) : sized;
	return { target, max: Math.ceil(target * 1.5) };
}

/** Field and option ids are written by the model and used as keys, so they stay simple. */
const fieldId = z.string().regex(/^[a-z][a-z0-9_]{0,23}$/, 'Use a short lowercase id.');
const points = z.number().min(0.5).max(10).default(1);
const optionSchema = z.object({
	id: fieldId,
	text: z.string().min(1).max(2000),
	/** Why this option is wrong, shown to a learner who chose it. */
	why: z.string().max(600).optional()
});
/**
 * One answer field of a question. A question holds any mix of them inside its text or the cells
 * of a table, which is how matching, classification, yes/no matrices, true/false lists,
 * calculation tables and cloze texts are all built. A new kind of field is one more branch here,
 * one case in the grader and one input.
 */
export const fieldSchema = z.discriminatedUnion('type', [
	/** One of several options. */
	z.object({
		id: fieldId,
		type: z.literal('select'),
		points,
		display: z.enum(['dropdown', 'radio']),
		options: z.array(optionSchema).min(2).max(12),
		correct: fieldId
	}),
	/** Any number of several options, as checkboxes. */
	z.object({
		id: fieldId,
		type: z.literal('multiselect'),
		points,
		options: z.array(optionSchema).min(2).max(30),
		correct: z.array(fieldId).max(30)
	}),
	/** One cell that is marked or left empty. */
	z.object({ id: fieldId, type: z.literal('toggle'), points, correct: z.boolean() }),
	/** A word or short phrase; compared without case and outer spaces. */
	z.object({
		id: fieldId,
		type: z.literal('text'),
		points,
		accepted: z.array(z.string().min(1).max(300)).min(1).max(10)
	}),
	z.object({
		id: fieldId,
		type: z.literal('number'),
		points,
		correct: z.number(),
		tolerance: z.number().min(0).default(0),
		unit: z.string().max(40).optional()
	}),
	/** Free text, graded by Claude against the model answer and rubric. */
	z.object({
		id: fieldId,
		type: z.literal('essay'),
		points,
		modelAnswer: z.string().min(1).max(6000),
		rubric: z.string().max(6000)
	})
]);
export type QuestionField = z.infer<typeof fieldSchema>;
/** `{{id}}` marks where a field sits in a question's text. */
export const FIELD_PLACEHOLDER = /\{\{([a-z][a-z0-9_]{0,23})\}\}/g;
export const questionSchema = z
	.object({
		id: z.string().min(1).max(80),
		/** Markdown holding every field's placeholder exactly once. */
		body: z.string().min(1).max(12000),
		fields: z.array(fieldSchema).min(1).max(60),
		/** Markdown shown after answering. */
		explanation: z.string().max(6000),
		/** What the tutor says after the answer: why it is right, or what would have been right. */
		feedback: z.object({ correct: z.string().max(600), incorrect: z.string().max(600) }),
		/** The source exercise this question asks, if it was taken from the sources. */
		sourceExercise: z.object({ materialId: idSchema, locator: z.string().max(300) }).optional(),
		citations: z.array(citationSchema).min(1).max(20)
	})
	.superRefine((q, ctx) => {
		const issue = (message: string) => ctx.addIssue({ code: 'custom', message });
		const ids = q.fields.map((field) => field.id);
		if (new Set(ids).size !== ids.length) issue('Field ids must be unique within a question.');
		const placed = [...q.body.matchAll(FIELD_PLACEHOLDER)].map((match) => match[1]);
		for (const id of ids)
			if (placed.filter((value) => value === id).length !== 1)
				issue(`The body must contain {{${id}}} exactly once.`);
		const unknown = placed.find((id) => !ids.includes(id));
		if (unknown) issue(`The body contains {{${unknown}}}, which is not a field.`);
		for (const field of q.fields) {
			if (field.type !== 'select' && field.type !== 'multiselect') continue;
			const options = field.options.map((option) => option.id);
			if (new Set(options).size !== options.length)
				issue(`Option ids of ${field.id} must be unique.`);
			const correct = field.type === 'select' ? [field.correct] : field.correct;
			if (correct.some((id) => !options.includes(id)) || new Set(correct).size !== correct.length)
				issue(`The correct answer of ${field.id} must name its options.`);
		}
	});
/** How a question is answered, as offered when creating a quiz or lesson. */
export const QUESTION_STYLES = {
	choice: 'Multiple choice',
	embedded: 'Embedded answers (dropdowns, tables, blanks)',
	written: 'Written answer'
} as const;
export type QuestionStyle = keyof typeof QUESTION_STYLES;
export const QUESTION_STYLE_NAMES = Object.keys(QUESTION_STYLES) as [
	QuestionStyle,
	...QuestionStyle[]
];
export function questionStyle(question: { fields: QuestionField[] }): QuestionStyle {
	const { fields } = question;
	if (fields.every((field) => field.type === 'essay')) return 'written';
	const [only] = fields;
	return fields.length === 1 && (only.type === 'select' || only.type === 'multiselect')
		? 'choice'
		: 'embedded';
}
/** An image an output shows: copied from a source figure or generated for it. */
export const outputImageSchema = z.object({
	id: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/),
	origin: z.enum(['source', 'generated']),
	label: z.string().max(200),
	mimeType: z.enum(['image/png', 'image/jpeg', 'image/webp']),
	materialId: idSchema.optional(),
	locator: z.string().max(300).optional()
});
export type OutputImage = z.infer<typeof outputImageSchema>;
export const quizSchema = z
	.object({
		title: z.string().min(1).max(200),
		parts: z
			.array(
				z.object({
					id: z.string().min(1).max(40),
					title: z.string().min(1).max(200),
					questions: z.array(questionSchema).min(1).max(200)
				})
			)
			.min(1)
			.max(60),
		images: z.array(outputImageSchema).max(500).default([])
	})
	.superRefine((v, ctx) => {
		const ids = v.parts.flatMap((part) => part.questions.map((question) => question.id));
		if (new Set(ids).size !== ids.length)
			ctx.addIssue({ code: 'custom', message: 'Question IDs must be unique.' });
	});
/** What the learner looks at during one step of an explanation. */
export const slideSchema = z.discriminatedUnion('kind', [
	/** One of the lesson's images, with a line saying what it shows. */
	z.object({
		kind: z.literal('image'),
		image: outputImageSchema.shape.id,
		caption: z.string().max(400)
	}),
	/** Markdown: a few key points, a table, a formula or a Mermaid diagram. */
	z.object({ kind: z.literal('content'), markdown: z.string().min(1).max(6000) })
]);
export type Slide = z.infer<typeof slideSchema>;
/** One step of an explanation: a slide and what the tutor says about it. */
export const beatSchema = z.object({
	id: z.string().min(1).max(40),
	/** Spoken text; it is also the text of the beat's voice clip. */
	narration: z.string().trim().min(1).max(900),
	slide: slideSchema
});
export const lessonSectionSchema = z.object({
	id: z.string().min(1).max(40),
	title: z.string().min(1).max(200),
	beats: z.array(beatSchema).min(1).max(5),
	/** Asked after the explanation, each followed by feedback. */
	questions: z.array(questionSchema).max(12),
	citations: z.array(citationSchema).min(1).max(20)
});
export const lessonSchema = z
	.object({
		title: z.string().min(1).max(200),
		chapters: z
			.array(
				z.object({
					id: z.string().min(1).max(40),
					title: z.string().min(1).max(200),
					sections: z.array(lessonSectionSchema).min(1).max(30)
				})
			)
			.min(1)
			.max(60),
		images: z.array(outputImageSchema).max(1000).default([])
	})
	.superRefine((lesson, ctx) => {
		const sections = lesson.chapters.flatMap((chapter) => chapter.sections);
		const ids = [
			...sections.flatMap((section) => section.questions.map((question) => question.id)),
			...sections.flatMap((section) => section.beats.map((beat) => beat.id))
		];
		if (new Set(ids).size !== ids.length)
			ctx.addIssue({ code: 'custom', message: 'Beat and question ids must be unique.' });
	});
export type Lesson = z.infer<typeof lessonSchema>;
export type LessonSection = z.infer<typeof lessonSectionSchema>;
/** All questions of a lesson, in order. */
export const lessonQuestions = (lesson: Lesson) =>
	lesson.chapters.flatMap((chapter) => chapter.sections.flatMap((section) => section.questions));
/** All questions of a quiz, in order. */
export const quizQuestions = (quiz: z.infer<typeof quizSchema>) =>
	quiz.parts.flatMap((part) => part.questions);
/** How an audio summary is spoken: one narrator, or a tutor explaining to a learner. */
export const AUDIO_STYLES = {
	narration: { label: 'Narration', speakers: ['narrator'] },
	dialogue: { label: 'Tutor and learner', speakers: ['tutor', 'learner'] }
} as const;
export type AudioStyle = keyof typeof AUDIO_STYLES;
/** How a dialogue's speakers are named in its transcript; a narrator stays unnamed. */
export const SPEAKER_LABELS: Record<string, string> = { tutor: 'Tutor', learner: 'Learner' };
const elevenLabsId = z.string().regex(/^[A-Za-z0-9_-]{1,100}$/, 'Choose a voice and model.');
export const generationInput = z.object({
	kind: z.enum(['summary', 'quiz', 'audio', 'session', 'lesson']),
	materialIds: sourceSelection,
	modelId,
	/** Audio summaries, study sessions, quizzes and lessons. */
	coverage: z.enum(COVERAGE_NAMES).default('standard'),
	/** Quizzes and lessons. */
	questionStyles: z
		.array(z.enum(QUESTION_STYLE_NAMES))
		.min(1, 'Choose at least one kind of question.')
		.max(QUESTION_STYLE_NAMES.length)
		.default(QUESTION_STYLE_NAMES),
	/** ElevenLabs voices and speech model; audio summaries and study sessions only. */
	voiceId: elevenLabsId.or(z.literal('')).default(''),
	learnerVoiceId: elevenLabsId.or(z.literal('')).default(''),
	speechModelId: elevenLabsId.or(z.literal('')).default(''),
	audioStyle: z.enum(['narration', 'dialogue']).default('narration'),
	/** Lessons only: whether and when the tutor's voice is made. */
	voiceMode: z.enum(['off', 'onDemand', 'all']).default('off'),
	/** Lessons only: generate an illustration where no figure of the sources fits. */
	illustrations: z.boolean().default(false)
});
/** The voice a lesson is read in. */
export const lessonVoiceInput = z.object({ voiceId: elevenLabsId, speechModelId: elevenLabsId });
export const chatInput = z.object({
	conversationId: idSchema.optional(),
	message: nonBlank(z.string().max(30000), 'Message is required.'),
	materialIds: sourceSelection,
	modelId
});
/** What a learner entered: per field its option id, option ids, mark or text. */
const fieldValue = z.union([
	z.string().max(12000),
	z.array(z.string().max(40)).max(30),
	z.boolean()
]);
export type FieldValue = z.infer<typeof fieldValue>;
export const questionAnswerSchema = z.object({
	questionId: z.string().min(1).max(80),
	values: z.record(z.string().max(24), fieldValue)
});
export type QuestionAnswer = z.infer<typeof questionAnswerSchema>;
export const answersSchema = z.object({ answers: z.array(questionAnswerSchema).max(5000) });
/** What a piece of extracted text is: teaching text, a task for the learner, or its answer key. */
export const CHUNK_KINDS = ['text', 'exercise', 'solution'] as const;
export type ChunkKind = (typeof CHUNK_KINDS)[number];
export const chunkResultSchema = z.object({
	locator: nonBlank(z.string().max(300), 'A source locator is required.'),
	kind: z.enum(CHUNK_KINDS).default('text'),
	text: nonBlank(z.string().max(60000), 'Readable source text is required.')
});
/** The sources a job works from, frozen when it was queued: their text and their figures. */
export type Snapshot = {
	id: string;
	name: string;
	chunks: { locator: string; text: string; kind: ChunkKind }[];
	/** Image assets of the source; `id` is what an `asset:` reference in the text names. */
	figures: { id: string; label: string; locator: string; mimeType: string }[];
}[];
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
/** The script Claude writes for an audio summary, one spoken turn per speech request. */
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
	segments: z.array(studySegmentSchema).min(2).max(24)
});
export type StudyPlan = z.infer<typeof studyPlanSchema>;
export const STUDY_VERDICTS = ['correct', 'partial', 'incorrect', 'none'] as const;
export type StudyVerdict = (typeof STUDY_VERDICTS)[number];
export const STUDY_VERDICT_LABELS: Record<StudyVerdict, string> = {
	correct: 'Correct',
	partial: 'Partly right',
	incorrect: 'Not quite',
	none: 'No answer'
};
/** The first line of every live feedback reply: the grade and what happens next. */
export const feedbackHeaderSchema = z.object({
	verdict: z.enum(STUDY_VERDICTS),
	next: z.enum(['continue', 'followUp', 'reexplain']),
	gap: z.string().max(160).default('')
});
export type FeedbackHeader = z.infer<typeof feedbackHeaderSchema>;
const MAX_TEXT_SOURCE_CHARS = 2_000_000;
/** Text pasted into a project as a source; without a name, its first line names it. */
export const pastedTextInput = z.object({
	name: z.string().max(160).default(''),
	text: nonBlank(
		z.string().max(MAX_TEXT_SOURCE_CHARS, 'Pasted text can hold at most 2,000,000 characters.'),
		'Paste some text.'
	)
});
export type Citation = z.infer<typeof citationSchema>;
export type Quiz = z.infer<typeof quizSchema>;
export type Question = z.infer<typeof questionSchema>;
export type JobStatus = 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled';
export type JobKind =
	| 'ingest'
	| 'chat'
	| 'summary'
	| 'quiz'
	| 'audio'
	| 'session'
	| 'lesson'
	| 'voice'
	| 'grade'
	| 'recover';
export const isActiveJob = (job: { status: JobStatus }) =>
	job.status === 'queued' || job.status === 'running';
/** What a job works on, when a later job for the same thing takes its place. */
const jobTarget = (job: Job) =>
	(job.materialId && `material:${job.materialId}`) ||
	(job.conversationId && `conversation:${job.conversationId}`) ||
	(job.attemptId && `attempt:${job.attemptId}`) ||
	(job.lessonAnswerId && `answer:${job.lessonAnswerId}`) ||
	(job.kind === 'voice' && job.outputId && `voice:${job.outputId}`) ||
	undefined;
/** Failed and cancelled jobs, newest first, without those a later job for the same thing replaced. */
export function interruptedJobs(jobs: Job[]) {
	const later = new Set<string>();
	return jobs
		.toSorted((a, b) => b.createdAt.localeCompare(a.createdAt))
		.filter((job) => {
			const target = jobTarget(job);
			const replaced = target !== undefined && later.has(target);
			if (target) later.add(target);
			return !replaced && (job.status === 'failed' || job.status === 'cancelled');
		});
}
/** A Library contact marked as lecturer, as assigned to a project. */
export interface ProjectLecturer {
	id: string;
	name: string;
}
export type ProjectSort = 'updated' | 'name' | 'lecturer';
export interface Project {
	id: string;
	name: string;
	/** In the order the user listed them. */
	lecturers: ProjectLecturer[];
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
	status:
		'uploading' | 'stored' | 'processing' | 'ready' | 'partial' | 'failed' | 'recording' | 'paused';
	size: number;
	receivedBytes: number;
	durationMs: number;
	/** Where a web page source was downloaded from; null for uploads and recordings. */
	sourceUrl: string | null;
	/** Markdown when Claude extracted the source, plain for text and transcripts stored as they came. */
	contentFormat: 'plain' | 'markdown';
	notes: string;
	createdAt: string;
	updatedAt: string;
}
/** How much was extracted from a source. */
export interface MaterialCounts {
	chunks: number;
	figures: number;
	exercises: number;
}
/** A source as the project overview lists it. */
export interface ProjectMaterial extends Material {
	counts: MaterialCounts;
}
export interface SourceChunk {
	id: string;
	materialId: string;
	ordinal: number;
	locator: string;
	kind: ChunkKind;
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
/** A saved overview, quiz, audio summary or study session as lists show it. */
export type OutputSummary = Pick<
	StudyOutput,
	'id' | 'projectId' | 'kind' | 'title' | 'materialIds' | 'createdAt'
>;
export interface ProjectWorkspace {
	project: Project;
	materials: ProjectMaterial[];
	conversations: Conversation[];
	outputs: OutputSummary[];
	jobs: Job[];
}
/** Whether a source holds extracted text that chat and study tools can use. */
export const isReadable = (material: ProjectMaterial) =>
	(material.status === 'ready' || material.status === 'partial') && material.counts.chunks > 0;
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
	kind: 'summary' | 'quiz' | 'audio' | 'session' | 'lesson';
	title: string;
	content: string;
	quiz: Quiz | null;
	audio: AudioInfo | null;
	study: StudyInfo | null;
	lesson: LessonInfo | null;
	citations: Citation[];
	materialIds: string[];
	modelId: string;
	createdAt: string;
}
/** A lesson as it is stored: what it teaches and how it was set up. */
export interface LessonVoice {
	voiceId: string;
	voiceName: string;
	speechModelId: string;
	speechModelName: string;
}
export interface LessonInfo {
	lesson: Lesson;
	/** Null while the lesson is read as text only; a voice can be chosen at any time. */
	voice: LessonVoice | null;
	/** Whether slides without a fitting source figure were illustrated. */
	illustrations: boolean;
}
/** One answer to a lesson question, graded at once except for free text. */
export interface LessonAnswer {
	id: string;
	questionId: string;
	values: Record<string, FieldValue>;
	result: Grade;
	status: 'graded' | 'grading' | 'failed';
	/** What the tutor says about a written answer once Claude has graded it. */
	feedback: string;
	createdAt: string;
}
/** How one field of an answer was graded; `pending` waits for Claude to grade free text. */
export interface FieldGrade {
	fieldId: string;
	state: 'correct' | 'partial' | 'incorrect' | 'pending';
	score: number;
	max: number;
	/** The right answer in words, for display. */
	expected: string;
	/** Claude's comment on a written answer. */
	feedback?: string;
}
export interface Grade {
	questionId: string;
	score: number;
	maxScore: number;
	state: FieldGrade['state'];
	fields: FieldGrade[];
}
export interface QuizAttempt {
	id: string;
	outputId: string;
	answers: QuestionAnswer[];
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
	kind: JobKind;
	status: JobStatus;
	progress: string;
	error: string | null;
	outputId: string | null;
	conversationId: string | null;
	attemptId: string | null;
	lessonAnswerId: string | null;
	createdAt: string;
	updatedAt: string;
}
/** One entry of Claude Code's live model list; aliases such as `opus` track the newest version. */
export interface ClaudeModel {
	modelId: string;
	displayLabel: string;
	description: string;
}
export interface ClaudeStatus {
	configured: boolean;
	models: ClaudeModel[];
	error?: string;
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
