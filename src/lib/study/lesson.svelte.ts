import type {
	FieldValue,
	Lesson,
	LessonAnswer,
	LessonSection,
	LessonVoice,
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
const PLAYER_SETTINGS = 'studyloom:lesson-player';
export const PLAYBACK_RATES = [0.75, 1, 1.25, 1.5, 2];

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
	/** The voice the lesson is read in; without one it is read as text. */
	voice = $state.raw<LessonVoice | null>(null);
	playing = $state(false);
	/** A clip is being voiced or fetched before it can play. */
	preparing = $state(false);
	audioError = $state('');
	/** Whether the next explanation starts by itself when one ends. */
	autoplay = $state(true);
	rate = $state(1);
	/** Whether the narration is shown as text while it is spoken. */
	showText = $state(false);
	#audio?: HTMLAudioElement;
	/** The clip the player was last asked for; a slower, older request must not start. */
	#wanted = '';
	readonly questionCount: number;
	readonly #lifetime = new AbortController();
	readonly #storageKey: string;

	constructor(
		outputId: string,
		lesson: Lesson,
		answers: LessonAnswer[],
		voice: LessonVoice | null = null
	) {
		this.outputId = outputId;
		this.lesson = lesson;
		this.voice = voice;
		this.#restoreSettings();
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
		this.stop();
		// Moving on is the learner's doing, so the next explanation may start speaking.
		if (this.autoplay && !this.finished && this.step.kind === 'beat') void this.play();
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
			if (jobId) {
				const job = await waitForJob(jobId, this.#lifetime.signal);
				if (!job) return;
				await this.#reload();
				if (job.status !== 'succeeded') {
					this.error = job.error ?? 'Grading did not complete. Try the question again.';
					return;
				}
			}
			if (this.question?.id === question.id) void this.play();
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

	/** The clip that belongs to the current screen: its narration, or the feedback on its answer. */
	get clipKey(): string {
		if (this.finished) return '';
		if (this.step.kind === 'beat') return this.section.beats[this.step.index].id;
		const question = this.question;
		const answer = question && this.answers[question.id];
		if (!question || !answer || answer.status !== 'graded') return '';
		if (question.fields.some(isEssay) && answer.feedback) return `answer-${answer.id}`;
		return `${question.id}-${answer.result.state === 'correct' ? 'correct' : 'incorrect'}`;
	}
	#clipUrl = (key: string) => `/api/outputs/${this.outputId}/clips/${key}`;
	/** Has the server voice a clip, unless it already exists. */
	#prepare = (key: string) => api(this.#clipUrl(key), { body: {} });
	#player() {
		if (this.#audio) return this.#audio;
		const audio = new Audio();
		audio.onplay = () => (this.playing = true);
		audio.onpause = () => (this.playing = false);
		audio.onended = () => {
			this.playing = false;
			if (this.autoplay && !this.finished && this.step.kind === 'beat') this.next();
		};
		audio.onerror = () => {
			this.playing = false;
			if (audio.src) this.audioError = 'This clip could not be played.';
		};
		return (this.#audio = audio);
	}
	/** Speaks the current screen's clip from the start, voicing it first if it is new. */
	async play() {
		const key = this.clipKey;
		if (!this.voice || !key || typeof Audio === 'undefined') return;
		this.#wanted = key;
		this.audioError = '';
		this.preparing = true;
		try {
			await this.#prepare(key);
			if (this.#wanted !== key) return;
			const audio = this.#player();
			audio.src = this.#clipUrl(key);
			audio.playbackRate = this.rate;
			await audio.play();
			this.#prepareNext();
		} catch (cause) {
			// A browser may refuse to start sound before the first click; the Play button remains.
			if (
				this.#wanted === key &&
				!(cause instanceof DOMException && cause.name === 'NotAllowedError')
			)
				this.audioError = errorText(cause);
		} finally {
			if (this.#wanted === key) this.preparing = false;
		}
	}
	/** While one explanation plays, the next one is voiced so it starts without a wait. */
	#prepareNext() {
		const next = this.steps[this.position + 1];
		if (next?.kind !== 'beat') return;
		const beat = this.lesson.chapters[next.chapter].sections[next.section].beats[next.index];
		void this.#prepare(beat.id).catch(() => {});
	}
	/** Pauses, resumes, or starts the current clip. */
	toggle() {
		const audio = this.#audio;
		if (this.playing) audio?.pause();
		else if (audio?.src.endsWith(this.#clipUrl(this.clipKey)) && !audio.ended)
			void audio.play().catch(() => {});
		else void this.play();
	}
	stop() {
		this.#wanted = '';
		this.preparing = false;
		this.audioError = '';
		if (!this.#audio) return;
		this.#audio.pause();
		this.#audio.removeAttribute('src');
	}
	setRate(rate: number) {
		this.rate = rate;
		if (this.#audio) this.#audio.playbackRate = rate;
		this.#saveSettings();
	}
	setAutoplay(autoplay: boolean) {
		this.autoplay = autoplay;
		this.#saveSettings();
	}
	setShowText(showText: boolean) {
		this.showText = showText;
		this.#saveSettings();
	}
	/** A new voice, or none; what was playing in the old one stops. */
	setVoice(voice: LessonVoice | null) {
		this.stop();
		this.voice = voice;
	}
	#restoreSettings() {
		try {
			const saved = JSON.parse(localStorage.getItem(PLAYER_SETTINGS) ?? 'null');
			if (PLAYBACK_RATES.includes(saved?.rate)) this.rate = saved.rate;
			if (typeof saved?.autoplay === 'boolean') this.autoplay = saved.autoplay;
			if (typeof saved?.showText === 'boolean') this.showText = saved.showText;
		} catch {
			// The defaults apply.
		}
	}
	#saveSettings() {
		try {
			localStorage.setItem(
				PLAYER_SETTINGS,
				JSON.stringify({ rate: this.rate, autoplay: this.autoplay, showText: this.showText })
			);
		} catch {
			// The settings last for this visit only.
		}
	}
	destroy() {
		this.#lifetime.abort();
		this.stop();
	}
}
