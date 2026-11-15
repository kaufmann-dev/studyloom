import type {
	FieldValue,
	Lesson,
	LessonAnswer,
	LessonSection,
	Question,
	QuestionField
} from '../domain';
import { waitForJob } from '../polling';
import { api, errorText } from '../ui';

/** One screen of a lesson: a beat of an explanation or a question, within a section. */
export interface LessonStep {
	chapter: number;
	section: number;
	kind: 'beat' | 'question';
	index: number;
}
type Values = Record<string, FieldValue>;

const isEssay = (field: QuestionField) => field.type === 'essay';

/**
 * A learner's way through one lesson: where they are, what they answered and what is still
 * open. The place is remembered in this browser; the answers live on the server.
 */
export class LessonSession {
	readonly outputId: string;
	readonly lesson: Lesson;
	/** Every screen in teaching order: each section's beats, then its questions. */
	readonly steps: LessonStep[];
	/** The current screen; one past the last screen is the summary. */
	position = $state(0);
	/** The newest answer to each question, by question id. */
	answers = $state.raw<Record<string, LessonAnswer>>({});
	/** What is typed into questions that have no answer yet, by question id. */
	drafts = $state.raw<Record<string, Values>>({});
	/** Ids of the sections that were opened, which is all a section without questions asks. */
	seen = $state.raw<string[]>([]);
	/** The question whose answer is on its way to the server. */
	busy = $state('');
	error = $state('');
	readonly questionCount: number;
	readonly #lifetime = new AbortController();
	readonly #storageKey: string;

	constructor(outputId: string, lesson: Lesson, answers: LessonAnswer[]) {
		this.outputId = outputId;
		this.lesson = lesson;
		this.#storageKey = `studyloom:lesson:${outputId}`;
		this.steps = lesson.chapters.flatMap((chapter, c) =>
			chapter.sections.flatMap((section, s) => [
				...section.beats.map(
					(_, index) => ({ chapter: c, section: s, kind: 'beat', index }) as const
				),
				...section.questions.map(
					(_, index) => ({ chapter: c, section: s, kind: 'question', index }) as const
				)
			])
		);
		this.questionCount = this.steps.filter((step) => step.kind === 'question').length;
		this.answers = Object.fromEntries(answers.map((answer) => [answer.questionId, answer]));
		const remembered = this.#remembered();
		this.seen = remembered.seen;
		this.position = remembered.position ?? this.#firstOpen();
		this.#arrive();
	}

	get finished() {
		return this.position >= this.steps.length;
	}
	get step() {
		return this.steps[Math.min(this.position, this.steps.length - 1)];
	}
	get chapter() {
		return this.lesson.chapters[this.step.chapter];
	}
	get section() {
		return this.chapter.sections[this.step.section];
	}
	/** The screens of the current section, for moving within it. */
	get sectionSteps() {
		const { chapter, section } = this.step;
		return this.steps
			.map((step, position) => ({ step, position }))
			.filter(({ step }) => step.chapter === chapter && step.section === section);
	}
	get answeredCount() {
		return Object.keys(this.answers).length;
	}

	/** Where to begin without a remembered place: the first section with an open question. */
	#firstOpen() {
		const open = this.steps.findIndex(
			(step) => step.kind === 'question' && !this.answers[this.#questionAt(step).id]
		);
		if (open < 0) return 0;
		const { chapter, section } = this.steps[open];
		return this.steps.findIndex((step) => step.chapter === chapter && step.section === section);
	}
	#questionAt(step: LessonStep) {
		return this.lesson.chapters[step.chapter].sections[step.section].questions[step.index];
	}
	#remembered(): { position?: number; seen: string[] } {
		try {
			const saved = JSON.parse(localStorage.getItem(this.#storageKey) ?? 'null');
			const position = Number.isInteger(saved?.position) ? saved.position : undefined;
			return {
				position: position >= 0 && position <= this.steps.length ? position : undefined,
				seen: Array.isArray(saved?.seen)
					? saved.seen.filter((id: unknown) => typeof id === 'string')
					: []
			};
		} catch {
			return { seen: [] };
		}
	}
	/** Notes the section just entered and remembers the place. */
	#arrive() {
		if (!this.finished && !this.seen.includes(this.section.id))
			this.seen = [...this.seen, this.section.id];
		try {
			localStorage.setItem(
				this.#storageKey,
				JSON.stringify({ position: this.position, seen: this.seen })
			);
		} catch {
			// Without storage the place is simply not remembered.
		}
	}

	goToStep(position: number) {
		this.position = Math.max(0, Math.min(this.steps.length, position));
		this.error = '';
		this.#arrive();
	}
	next = () => this.goToStep(this.position + 1);
	previous = () => this.goToStep(this.position - 1);
	/** Opens a section at its first screen. */
	goTo(chapter: number, section: number) {
		const position = this.steps.findIndex(
			(step) => step.chapter === chapter && step.section === section
		);
		if (position >= 0) this.goToStep(position);
	}

	/** The question on the current screen, if it is one. */
	get question(): Question | undefined {
		return this.step.kind === 'question' && !this.finished
			? this.#questionAt(this.step)
			: undefined;
	}
	answerOf(questionId: string): LessonAnswer | undefined {
		return this.answers[questionId];
	}
	/** What a question shows in its fields: the given answer, or what is being typed. */
	valuesOf(questionId: string): Values {
		return this.answers[questionId]?.values ?? this.drafts[questionId] ?? {};
	}
	setDraft(questionId: string, values: Values) {
		this.drafts = { ...this.drafts, [questionId]: values };
	}
	/** What the tutor says about an answer: Claude's words for free text, else the prepared ones. */
	feedbackOf(question: Question): string {
		const answer = this.answers[question.id];
		if (!answer || answer.status !== 'graded') return '';
		if (question.fields.some(isEssay) && answer.feedback) return answer.feedback;
		return answer.result.state === 'correct'
			? question.feedback.correct
			: question.feedback.incorrect;
	}
	/** A section is done when all its questions are answered, or once it was opened if it asks none. */
	isDone(section: LessonSection) {
		return section.questions.length
			? section.questions.every((question) => this.answers[question.id])
			: this.seen.includes(section.id);
	}
	/** Points earned and possible in a set of sections, counting open questions as zero. */
	score(sections: LessonSection[]) {
		const questions = sections.flatMap((section) => section.questions);
		return {
			earned: questions.reduce(
				(sum, question) => sum + (this.answers[question.id]?.result.score ?? 0),
				0
			),
			possible: questions.reduce(
				(sum, question) =>
					sum + question.fields.reduce((points, field) => points + field.points, 0),
				0
			)
		};
	}

	/** Sends the answer on the current screen; free text is graded by a job that is waited for. */
	async submit(question: Question) {
		if (this.busy) return;
		this.busy = question.id;
		this.error = '';
		try {
			const { answer, jobId } = await api<{ answer: LessonAnswer; jobId?: string }>(
				`/api/outputs/${this.outputId}/answers`,
				{ body: { questionId: question.id, values: this.valuesOf(question.id) } }
			);
			this.answers = { ...this.answers, [question.id]: answer };
			if (!jobId) return;
			const job = await waitForJob(jobId, this.#lifetime.signal);
			if (!job) return;
			await this.#reload();
			if (job.status !== 'succeeded')
				this.error = job.error ?? 'Grading did not complete. Try the question again.';
		} catch (cause) {
			this.error = errorText(cause);
		} finally {
			this.busy = '';
		}
	}
	async #reload() {
		const { answers } = await api<{ answers: LessonAnswer[] }>(`/api/outputs/${this.outputId}`);
		this.answers = Object.fromEntries(answers.map((answer) => [answer.questionId, answer]));
	}
	/** Opens a question again; the earlier answer stays what was entered until it is replaced. */
	retry(question: Question) {
		const previous = this.answers[question.id];
		if (!previous) return;
		this.drafts = { ...this.drafts, [question.id]: {} };
		this.answers = Object.fromEntries(
			Object.entries(this.answers).filter(([id]) => id !== question.id)
		);
		this.error = '';
	}
	/** Forgets every answer and starts at the beginning. */
	async reset() {
		await api(`/api/outputs/${this.outputId}/answers`, { method: 'DELETE' });
		this.answers = {};
		this.drafts = {};
		this.seen = [];
		this.goToStep(0);
	}
	destroy() {
		this.#lifetime.abort();
	}
}
