import { copyFile, mkdir, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import {
	COVERAGE_BRIEFS,
	QUESTION_STYLES,
	idSchema,
	questionSchema,
	questionStyle,
	type Coverage,
	type OutputImage,
	type Question,
	type QuestionStyle,
	type Snapshot
} from '../domain';
import { validateCitations } from './citations';
import { dataDir, safeError } from './config';
import { scopedFile } from './storage';
import { isMissingFile, writeAtomic } from './voicing';

// Quizzes and lessons can be far larger than one model answer, so they are made in stages:
// an outline of parts, then one call per part. Each finished stage is saved in a plan outside
// the job workspace, so a retried job continues where it stopped and pays for nothing twice.

/** Everything an output keeps on disk: its plan while it is made, then its images and clips. */
export const outputDir = (id: string) => join(dataDir(), 'outputs', idSchema.parse(id));
export const outputImagePath = (id: string, imageId: string) =>
	join(outputDir(id), 'images', imageId);
export const removeOutputFiles = (id: string) =>
	rm(outputDir(id), { recursive: true, force: true });

/** One chunk of one source. */
const sourceRef = z.object({ materialId: idSchema, locator: z.string().min(1).max(300) });
export type SourceRef = z.infer<typeof sourceRef>;
export const sectionOutlineSchema = z.object({
	title: z.string().min(1).max(200),
	/** The chunks this section teaches from. */
	locators: z.array(sourceRef).min(1).max(600),
	/** The source exercises asked in this section. */
	exercises: z.array(sourceRef).max(600).default([])
});
export const outlineSchema = z.object({
	title: z.string().min(1).max(200),
	parts: z
		.array(
			z.object({
				title: z.string().min(1).max(200),
				sections: z.array(sectionOutlineSchema).min(1).max(30)
			})
		)
		.min(1)
		.max(60)
});
export type Outline = z.infer<typeof outlineSchema>;
export type OutlinePart = Outline['parts'][number];

const key = (ref: SourceRef) => `${ref.materialId} ${ref.locator}`;
const chunksOfKind = (snapshot: Snapshot, kind: 'text' | 'exercise' | 'solution') =>
	snapshot.flatMap((source) =>
		source.chunks
			.filter((chunk) => chunk.kind === kind)
			.map((chunk) => ({ materialId: source.id, locator: chunk.locator }))
	);
/** The exercises the selected sources contain. */
export const sourceExercises = (snapshot: Snapshot) => chunksOfKind(snapshot, 'exercise');
/** How many characters of source text a part teaches from, to share out a size budget. */
export function partCharacters(part: OutlinePart, snapshot: Snapshot) {
	const wanted = new Set(part.sections.flatMap((section) => section.locators).map(key));
	return snapshot
		.flatMap((source) =>
			source.chunks.filter((chunk) =>
				wanted.has(key({ materialId: source.id, locator: chunk.locator }))
			)
		)
		.reduce((sum, chunk) => sum + chunk.text.length, 0);
}

/**
 * Rejects an outline that names chunks the sources do not have or that mishandles exercises:
 * none may be asked twice, and comprehensive coverage asks every one of them.
 */
export function validateOutline(outline: Outline, snapshot: Snapshot, coverage: Coverage) {
	const known = new Set(
		snapshot.flatMap((source) =>
			source.chunks.map((chunk) => key({ materialId: source.id, locator: chunk.locator }))
		)
	);
	const sections = outline.parts.flatMap((part) => part.sections);
	const unknown = sections
		.flatMap((section) => section.locators)
		.find((ref) => !known.has(key(ref)));
	if (unknown)
		throw new Error(`The outline names ${unknown.locator}, which is not in sources.json.`);
	const exercises = new Set(sourceExercises(snapshot).map(key));
	const assigned = sections.flatMap((section) => section.exercises);
	const stray = assigned.find((ref) => !exercises.has(key(ref)));
	if (stray) throw new Error(`${stray.locator} is not an exercise chunk of sources.json.`);
	if (new Set(assigned.map(key)).size !== assigned.length)
		throw new Error('The outline assigns an exercise to more than one section.');
	if (coverage === 'comprehensive' && assigned.length !== exercises.size) {
		const missing = [...exercises].filter((id) => !assigned.some((ref) => key(ref) === id));
		throw new Error(
			`The outline leaves out ${missing.length} of ${exercises.size} exercises, for example ${missing[0].split(' ')[1]}. Assign every exercise chunk to a section.`
		);
	}
}

/** One part that covers everything: enough for sources small enough for a single call. */
export function wholeOutline(snapshot: Snapshot): Outline {
	return {
		title: snapshot
			.map((source) => source.name)
			.join(', ')
			.slice(0, 200),
		parts: [
			{
				title: 'Questions',
				sections: [
					{
						title: 'All sources',
						locators: [...chunksOfKind(snapshot, 'text'), ...chunksOfKind(snapshot, 'solution')],
						exercises: sourceExercises(snapshot)
					}
				]
			}
		]
	};
}

/** Asks Claude for a result validated against a schema. */
export type Ask = <S extends z.ZodType>(task: string, schema: S) => Promise<z.infer<S>>;

/** Runs a model call and its check; a rejected result goes back once with the reason. */
export async function checked<T>(
	produce: (feedback: string) => Promise<T>,
	check: (value: T) => void
) {
	let feedback = '';
	for (let attempt = 0; ; attempt++) {
		const value = await produce(feedback);
		try {
			check(value);
			return value;
		} catch (cause) {
			if (attempt) throw cause;
			feedback = ` Your previous result was rejected: ${safeError(cause)} Return a corrected result.`;
		}
	}
}

/** Has Claude divide the sources into parts and sections along their own structure. */
export function planOutline(
	ask: Ask,
	snapshot: Snapshot,
	options: { purpose: string; coverage: Coverage; sections: { target: number; max: number } }
) {
	const exercises = sourceExercises(snapshot).length;
	const task = `Outline ${options.purpose} over all selected sources.json. ${COVERAGE_BRIEFS[options.coverage]} Follow the sources' own structure: one part per chapter or main topic, each with sections in teaching order. About ${options.sections.target} sections in total and never more than ${options.sections.max}. For every section list the chunks it teaches from as materialId and locator pairs (chunks of kind text and solution; a chunk may serve several sections). ${
		exercises
			? `The sources contain ${exercises} chunks of kind exercise. ${
					options.coverage === 'comprehensive'
						? 'Assign every one of them to exactly one section'
						: 'Assign the most instructive ones, each to exactly one section'
				}: the section that teaches what the exercise asks, or a closing review section of its part when it spans the part.`
			: 'Leave exercises empty: the sources contain no exercise chunks.'
	} Titles are in the language of the sources. Use run_command with Python to list locators and kinds from sources.json instead of typing them from memory.`;
	return checked(
		(feedback) => ask(task + feedback, outlineSchema),
		(outline) => {
			validateOutline(outline, snapshot, options.coverage);
			const sections = outline.parts.reduce((sum, part) => sum + part.sections.length, 0);
			if (sections > options.sections.max)
				throw new Error(
					`The outline has ${sections} sections; the limit is ${options.sections.max}.`
				);
		}
	);
}

const planPath = (id: string) => join(outputDir(id), 'plan.json');
/** The stages of a job that are already paid for. `parts` holds finished parts in order. */
export interface Plan<T> {
	outline?: Outline;
	parts: T[];
}
export async function readPlan<S extends z.ZodType>(
	id: string,
	part: S
): Promise<Plan<z.infer<S>>> {
	try {
		return z
			.object({ outline: outlineSchema.optional(), parts: z.array(part) })
			.parse(JSON.parse(await readFile(planPath(id), 'utf8')));
	} catch (error) {
		if (isMissingFile(error)) return { parts: [] };
		throw error;
	}
}
export async function writePlan(id: string, plan: Plan<unknown>) {
	await mkdir(outputDir(id), { recursive: true, mode: 0o700 });
	await writeAtomic(planPath(id), JSON.stringify(plan));
}
export const removePlan = (id: string) => rm(planPath(id), { force: true });

/** How questions are written, for every job that generates them. */
export function questionRules(styles: QuestionStyle[], hasFigures: boolean) {
	return `Each question: body is Markdown that holds every answer field as a {{id}} placeholder exactly once, inside a sentence, in a list or in the cells of a table, never inside code or a formula. fields describes each placeholder by type: select (one option; display "radio" for a stand-alone choice, "dropdown" inside text or a table), multiselect (any number of options as checkboxes; correct lists every right option and may be empty), toggle (a table cell to mark or leave empty), text (a word or short phrase; accepted lists every answer that counts), number (correct as a plain number, tolerance for rounding, unit if any), essay (free text with modelAnswer and rubric). Build matching and classification as a table with one dropdown per row, yes/no decisions as a table with a dropdown or toggle per cell, several true/false statements as one dropdown per statement, calculations as number fields. Give each wrong option a short why. Field and option ids are short lowercase words or letters. explanation: Markdown shown after answering (tables and LaTeX math in $…$ are rendered). feedback.correct: two or three sentences a tutor says when the answer is right, explaining why it is right. feedback.incorrect: two to four sentences giving the right answer and why, addressing the usual mistake. Both are plain spoken text in the language of the sources, without Markdown, symbols or option letters. Every question cites its evidence in citations.
Questions you write yourself use only these styles: ${styles.map((style) => `${style} (${STYLE_RULES[style]})`).join('; ')}.
Assigned exercises (chunks of kind exercise): turn each one into at least one question that asks what the exercise asks, in the exercise's own format whatever the styles above, and set sourceExercise to its materialId and locator. Take the answer from the solution chunk of the same exercise number (kind solution; marked options are "- [x]", marked table cells "X"). If the sources hold no solution, work it out from the content and say so in the explanation. Tasks that cannot be answered by clicking or typing, such as drawing or group work, become essay fields.
${
	hasFigures
		? 'To show a figure of the sources, write ![label](asset:<id>) with an id from the figures of sources.json; the image files are in figures/ under that id, so view one before you use it. Write no other images.'
		: 'Write no images.'
}`;
}
const STYLE_RULES: Record<QuestionStyle, string> = {
	choice: `${QUESTION_STYLES.choice}: exactly one select field with display "radio", or one multiselect field`,
	embedded: `${QUESTION_STYLES.embedded}: several fields, or dropdown, toggle, text and number fields set in text or a table`,
	written: `${QUESTION_STYLES.written}: only essay fields`
};

const ASSET_IMAGE = /(!\[[^\]]*\]\()asset:([0-9a-f-]{36})(\))/g;
const ANY_IMAGE = /!\[[^\]]*\]\(([^)\s]*)[^)]*\)/g;
/** The source figures a Markdown text shows. Any other image is rejected. */
export function figuresIn(text: string, snapshot: Snapshot) {
	const figures = new Set(snapshot.flatMap((source) => source.figures.map((figure) => figure.id)));
	return [...text.matchAll(ANY_IMAGE)].map((match) => {
		const id = /^asset:([0-9a-f-]{36})$/.exec(match[1])?.[1];
		if (!id || !figures.has(id))
			throw new Error(`The image ${match[1]} is not a figure of sources.json.`);
		return id;
	});
}
/** Points a text's figure references at the output's own copies. */
export const useOutputImages = (text: string) =>
	text.replace(
		ASSET_IMAGE,
		(_, open: string, id: string, close: string) => `${open}image:${id}${close}`
	);

/** Rejects questions that break the rules a schema cannot express. */
export function checkQuestions(
	questions: Question[],
	context: {
		snapshot: Snapshot;
		styles: QuestionStyle[];
		/** The source exercises these questions were asked to cover. */
		exercises: SourceRef[];
		/** Whether every assigned exercise must be asked. */
		complete: boolean;
		max: number;
	}
) {
	if (questions.length > context.max)
		throw new Error(`There are ${questions.length} questions; the limit here is ${context.max}.`);
	const assigned = new Set(context.exercises.map(key));
	const asked = new Set<string>();
	for (const [i, question] of questions.entries()) {
		const where = `Question ${i + 1}`;
		validateCitations(question.citations, context.snapshot);
		figuresIn(`${question.body}\n${question.explanation}`, context.snapshot);
		if (!question.feedback.correct.trim() || !question.feedback.incorrect.trim())
			throw new Error(`${where} needs feedback.correct and feedback.incorrect.`);
		if (question.sourceExercise) {
			if (!assigned.has(key(question.sourceExercise)))
				throw new Error(`${where} names a sourceExercise that was not assigned to this part.`);
			asked.add(key(question.sourceExercise));
		} else if (!context.styles.includes(questionStyle(question)))
			throw new Error(
				`${where} is a ${questionStyle(question)} question; only ${context.styles.join(', ')} are wanted.`
			);
	}
	const missing = context.exercises.filter((ref) => !asked.has(key(ref)));
	if (context.complete && missing.length)
		throw new Error(
			`${missing.length} assigned exercises have no question, for example ${missing[0].locator}. Ask every assigned exercise.`
		);
}

const EXTENSIONS: Record<string, string> = {
	'image/png': 'png',
	'image/jpeg': 'jpg',
	'image/webp': 'webp'
};
/** The workspace name of a source figure, where Claude can view it. */
export const figureFile = (figure: { id: string; mimeType: string }) =>
	`figures/${figure.id}.${EXTENSIONS[figure.mimeType] ?? 'bin'}`;

/**
 * Copies the source figures an output shows from the job workspace into the output's own image
 * store, so the output keeps them when a source is processed again or deleted.
 */
export async function storeSourceImages(
	outputId: string,
	workspace: string,
	snapshot: Snapshot,
	ids: string[]
): Promise<OutputImage[]> {
	const images: OutputImage[] = [];
	await mkdir(join(outputDir(outputId), 'images'), { recursive: true, mode: 0o700 });
	for (const id of new Set(ids)) {
		const source = snapshot.find((item) => item.figures.some((figure) => figure.id === id))!;
		const figure = source.figures.find((item) => item.id === id)!;
		const mimeType = z.enum(['image/png', 'image/jpeg', 'image/webp']).parse(figure.mimeType);
		const file = await scopedFile(join(workspace, 'files'), figureFile(figure)).catch(() => {
			throw new Error('A figure of the sources no longer exists. Create this again.');
		});
		await copyFile(file, outputImagePath(outputId, id));
		images.push({
			id,
			origin: 'source',
			label: figure.label,
			mimeType,
			materialId: source.id,
			locator: figure.locator
		});
	}
	return images;
}

/** What one part of a quiz or lesson asks: the questions Claude wrote for it. */
export const partQuestionsSchema = z.object({
	title: z.string().min(1).max(200),
	questions: z.array(questionSchema).min(1).max(200)
});
