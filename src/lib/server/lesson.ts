import { mkdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import {
	COVERAGE_BRIEFS,
	citationSchema,
	lessonSchema,
	questionSchema,
	type Citation,
	type Coverage,
	type Lesson,
	type OutputImage,
	type QuestionStyle,
	type Slide,
	type Snapshot
} from '../domain';
import { validateCitations } from './citations';
import { imageType } from './figures';
import {
	checked,
	checkQuestions,
	figuresIn,
	outputDir,
	outputImagePath,
	planOutline,
	questionRules,
	readPlan,
	removePlan,
	storeSourceImages,
	useOutputImages,
	writePlan,
	type Ask,
	type OutlinePart
} from './outline';
import { writeAtomic } from './voicing';

// A lesson explains its sources chapter by chapter: each section is a few beats (a slide and
// what the tutor says about it) followed by questions the learner answers by typing and clicking.

/** A slide as Claude writes it: a figure of the sources by its id, or Markdown content. */
const slideDraftSchema = z.discriminatedUnion('kind', [
	z.object({
		kind: z.literal('figure'),
		figure: z.string().min(1).max(64),
		caption: z.string().max(400)
	}),
	z.object({ kind: z.literal('content'), markdown: z.string().min(1).max(6000) }),
	/** A picture to generate, where the sources have none that fits. */
	z.object({
		kind: z.literal('illustration'),
		prompt: z.string().min(1).max(1500),
		caption: z.string().max(400)
	})
]);
const sectionDraftSchema = z.object({
	title: z.string().min(1).max(200),
	beats: z
		.array(z.object({ narration: z.string().trim().min(1).max(900), slide: slideDraftSchema }))
		.min(1)
		.max(5),
	questions: z.array(questionSchema).max(12),
	citations: z.array(citationSchema).min(1).max(20)
});
/** One chapter as Claude writes it: one section per section of the outline, in order. */
export const chapterDraftSchema = z.object({
	sections: z.array(sectionDraftSchema).min(1).max(30)
});
type ChapterDraft = z.infer<typeof chapterDraftSchema>;

/** Questions a section asks beyond the exercises assigned to it. */
const OWN_QUESTIONS: Record<Coverage, number> = { light: 1, standard: 2, comprehensive: 3 };

function chapterTask(
	coverage: Coverage,
	styles: QuestionStyle[],
	hasFigures: boolean,
	illustrated: boolean
) {
	return `Write one chapter of an illustrated lesson on the selected sources.json, in the language of the sources. part.json holds this chapter: its sections in order, the chunks each section teaches from (locators) and the exercises assigned to it. ${COVERAGE_BRIEFS[coverage]} Return exactly one section per section of part.json, in the same order and with the same titles.
Each section explains first, then asks.
beats: one to five steps, each one idea shown on a slide while a tutor speaks. narration: 40 to 120 words of spoken text addressed to the learner as "you": a concrete example or case first, then the general idea. Plain spoken text only: no Markdown, lists, symbols, citations or mentions of the slide; write numbers, units and abbreviations as they are spoken. slide: what the learner looks at meanwhile. ${
		hasFigures
			? 'Use a figure of the sources where one shows what the narration explains: kind "figure" with an id from the figures of sources.json and a one-sentence caption; the image files are in figures/ under that id, so view a figure before you use it. Otherwise use'
			: 'Use'
	} kind "content": Markdown with at most about sixty words that complements the narration instead of repeating it, such as three key points, a small table, a formula in LaTeX ($…$) or a \`\`\`mermaid diagram of a process or structure.${
		illustrated
			? ' Where a picture would explain an idea better than text and no figure of the sources shows it, use kind "illustration": prompt describes one clean explanatory diagram or illustration in the style of a textbook figure, on a white background, with at most a few short labels in the language of the sources and no long text; caption says in one sentence what it shows. Use at most one illustration per section.'
			: ''
	}
questions: about ${OWN_QUESTIONS[coverage]} questions that check what this section taught, plus every exercise assigned to the section. A section that only introduces the chapter may ask nothing.
citations: the evidence for the section's explanation.
${questionRules(styles, hasFigures)}`;
}

/** The figures of the sources a chapter shows on slides and in its questions. */
function chapterFigures(chapter: ChapterDraft, snapshot: Snapshot) {
	const known = new Set(snapshot.flatMap((source) => source.figures.map((figure) => figure.id)));
	return chapter.sections.flatMap((section) => [
		...section.beats.flatMap(({ slide }) => {
			if (slide.kind === 'content') return figuresIn(slide.markdown, snapshot);
			if (slide.kind === 'illustration') return [];
			if (!known.has(slide.figure))
				throw new Error(`The slide figure ${slide.figure} is not a figure of sources.json.`);
			return [slide.figure];
		}),
		...section.questions.flatMap((question) =>
			figuresIn(`${question.body}\n${question.explanation}`, snapshot)
		)
	]);
}

/** Rejects a chapter that does not follow its outline or breaks the rules for questions. */
export function checkChapter(
	chapter: ChapterDraft,
	part: OutlinePart,
	context: { snapshot: Snapshot; styles: QuestionStyle[]; coverage: Coverage; illustrated: boolean }
) {
	const illustrations = chapter.sections.map(
		(section) => section.beats.filter((beat) => beat.slide.kind === 'illustration').length
	);
	if (!context.illustrated && illustrations.some(Boolean))
		throw new Error('Illustrations are switched off; use a figure of the sources or content.');
	if (illustrations.some((count) => count > 1))
		throw new Error('Use at most one illustration per section.');
	if (chapter.sections.length !== part.sections.length)
		throw new Error(
			`part.json has ${part.sections.length} sections; you returned ${chapter.sections.length}.`
		);
	chapterFigures(chapter, context.snapshot);
	for (const [i, section] of chapter.sections.entries()) {
		try {
			validateCitations(section.citations, context.snapshot);
			checkQuestions(section.questions, {
				snapshot: context.snapshot,
				styles: context.styles,
				exercises: part.sections[i].exercises,
				complete: context.coverage === 'comprehensive',
				max: 12
			});
		} catch (cause) {
			throw new Error(`Section ${i + 1}: ${cause instanceof Error ? cause.message : cause}`, {
				cause
			});
		}
	}
}

const number = (value: number) => String(value + 1).padStart(2, '0');
/** The outline as readable Markdown: the lesson's table of contents. */
const contents = (lesson: Lesson) =>
	lesson.chapters
		.map(
			(chapter, i) =>
				`## ${i + 1}. ${chapter.title}\n\n${chapter.sections.map((section) => `- ${section.title}`).join('\n')}`
		)
		.join('\n\n');

export interface LessonRun {
	jobId: string;
	workspace: string;
	snapshot: Snapshot;
	coverage: Coverage;
	styles: QuestionStyle[];
	/** How many sections the lesson should have. */
	sections: { target: number; max: number };
	signal: AbortSignal;
	progress: (text: string) => void;
	ask: Ask;
	/** Puts a JSON file into the job workspace for Claude to read. */
	writeData: (name: string, value: unknown) => Promise<void>;
	/** Generates a picture from a prompt; absent when illustrations are switched off. */
	illustrate?: (prompt: string, signal: AbortSignal) => Promise<{ data: Buffer; mimeType: string }>;
}
const generatedId = (c: number, s: number, b: number) => `gen-c${number(c)}s${number(s)}b${b + 1}`;
const GENERATED_TYPES = ['image/png', 'image/jpeg', 'image/webp'] as const;
/**
 * Generates the illustrations the chapters ask for into the output's image store. A picture that
 * is already there is kept, so a retried job pays for no image twice.
 */
async function illustrate(run: LessonRun, chapters: ChapterDraft[]): Promise<OutputImage[]> {
	const wanted = chapters.flatMap((chapter, c) =>
		chapter.sections.flatMap((section, s) =>
			section.beats.flatMap((beat, b) =>
				beat.slide.kind === 'illustration'
					? [{ id: generatedId(c, s, b), prompt: beat.slide.prompt, label: beat.slide.caption }]
					: []
			)
		)
	);
	if (!wanted.length) return [];
	if (!run.illustrate) throw new Error('Illustrations are switched off.');
	await mkdir(join(outputDir(run.jobId), 'images'), { recursive: true, mode: 0o700 });
	const images: OutputImage[] = [];
	for (const [i, image] of wanted.entries()) {
		run.signal.throwIfAborted();
		const path = outputImagePath(run.jobId, image.id);
		let mimeType = await readFile(path).then(imageType, () => undefined);
		if (!mimeType) {
			run.progress(`Illustrating slide ${i + 1} of ${wanted.length}`);
			const generated = await run.illustrate(image.prompt, run.signal);
			await writeAtomic(path, generated.data);
			mimeType = imageType(generated.data);
		}
		images.push({
			id: image.id,
			origin: 'generated',
			label: image.label.slice(0, 200),
			mimeType: z.enum(GENERATED_TYPES).parse(mimeType)
		});
	}
	return images;
}

/**
 * Writes a lesson: an outline along the sources' own structure, then one chapter per call. The
 * outline and every finished chapter are kept in the output's plan, so a retry continues with
 * the first chapter that is missing.
 */
export async function writeLesson(run: LessonRun) {
	const { snapshot, coverage, styles } = run;
	const plan = await readPlan(run.jobId, chapterDraftSchema);
	if (!plan.outline) {
		run.progress('Outlining the lesson');
		plan.outline = await planOutline(run.ask, snapshot, {
			purpose: 'an illustrated lesson that explains the sources step by step',
			coverage,
			sections: run.sections
		});
		await writePlan(run.jobId, plan);
	}
	const { outline } = plan;
	const hasFigures = snapshot.some((source) => source.figures.length > 0);
	const illustrated = Boolean(run.illustrate);
	const task = chapterTask(coverage, styles, hasFigures, illustrated);
	for (const [i, part] of outline.parts.entries()) {
		if (plan.parts[i]) continue;
		run.signal.throwIfAborted();
		run.progress(`Writing chapter ${i + 1} of ${outline.parts.length}: ${part.title}`);
		await run.writeData('part.json', part);
		plan.parts[i] = await checked(
			(feedback) => run.ask(task + feedback, chapterDraftSchema),
			(chapter) => checkChapter(chapter, part, { snapshot, styles, coverage, illustrated })
		);
		await writePlan(run.jobId, plan);
	}
	const images = [
		...(await storeSourceImages(
			run.jobId,
			run.workspace,
			snapshot,
			plan.parts.flatMap((chapter) => chapterFigures(chapter, snapshot))
		)),
		...(await illustrate(run, plan.parts))
	];
	const lesson = lessonSchema.parse({
		title: outline.title,
		images,
		chapters: outline.parts.map((part, c) => ({
			id: `c${number(c)}`,
			title: part.title,
			sections: plan.parts[c].sections.map((section, s) => {
				const id = `c${number(c)}s${number(s)}`;
				return {
					id,
					title: part.sections[s].title,
					citations: section.citations,
					beats: section.beats.map((beat, b) => ({
						id: `${id}b${b + 1}`,
						narration: beat.narration,
						slide: ((): Slide => {
							const { slide } = beat;
							if (slide.kind === 'content')
								return { kind: 'content', markdown: useOutputImages(slide.markdown) };
							return {
								kind: 'image',
								image: slide.kind === 'figure' ? slide.figure : generatedId(c, s, b),
								caption: slide.caption
							};
						})()
					})),
					questions: section.questions.map((question, q) => ({
						...question,
						id: `${id}q${q + 1}`,
						body: useOutputImages(question.body),
						explanation: useOutputImages(question.explanation)
					}))
				};
			})
		}))
	});
	const sections = lesson.chapters.flatMap((chapter) => chapter.sections);
	const citations: Citation[] = sections.flatMap((section) => [
		...section.citations,
		...section.questions.flatMap((question) => question.citations)
	]);
	return { lesson, content: contents(lesson), citations };
}

/** Forgets the stages of a lesson once it is saved. */
export const finishLesson = (jobId: string) => removePlan(jobId);
