import type { FeedbackHeader, StudyAnswer } from '../domain';

const NO_SPEECH_MS = 15_000;
const MAX_ANSWER_MS = 180_000;
const DONE_WAIT_MS = 3_000;

/**
 * Decides when a spoken answer is finished. People pause to think mid-answer, so an answer
 * ends only after the learner's chosen pause follows the last finished speech turn; new speech
 * cancels the pause. Silence from the start means no answer.
 */
export class AnswerTimer {
	private parts: string[] = [];
	private speaking = false;
	private doneRequested = false;
	private finished = false;
	private pause: ReturnType<typeof setTimeout> | undefined;
	private cap: ReturnType<typeof setTimeout> | undefined;
	constructor(
		private readonly graceMs: number,
		private readonly onFinish: (answer: string) => void
	) {}
	/** Listening has begun. */
	ready() {
		this.arm(NO_SPEECH_MS);
		this.cap = setTimeout(() => this.finish(), MAX_ANSWER_MS);
	}
	speechStart() {
		this.speaking = true;
		this.clearPause();
	}
	complete(text: string) {
		this.speaking = false;
		if (text.trim()) this.parts.push(text.trim());
		if (this.doneRequested) return this.finish();
		this.arm(this.parts.length ? this.graceMs : NO_SPEECH_MS);
	}
	/**
	 * The learner said they are done. Returns true when speech is still being transcribed: the
	 * caller then ends the stream, and the answer finishes with its last turn.
	 */
	done() {
		if (!this.speaking) {
			this.finish();
			return false;
		}
		this.doneRequested = true;
		this.arm(DONE_WAIT_MS);
		return true;
	}
	dispose() {
		this.finished = true;
		this.clearPause();
		clearTimeout(this.cap);
	}
	private arm(ms: number) {
		this.clearPause();
		this.pause = setTimeout(() => this.finish(), ms);
	}
	private clearPause() {
		clearTimeout(this.pause);
		this.pause = undefined;
	}
	private finish() {
		if (this.finished) return;
		this.dispose();
		this.onFinish(this.parts.join(' '));
	}
}

export interface Position {
	segmentIndex: number;
	attempt: number;
}
/** The tutor may follow up once; after the second attempt the session always moves on. */
export function nextPosition(position: Position, next: FeedbackHeader['next']): Position {
	if (position.attempt >= 2 || next === 'continue')
		return { segmentIndex: position.segmentIndex + 1, attempt: 1 };
	return { segmentIndex: position.segmentIndex, attempt: 2 };
}
export const finalNext = (attempt: number, next: FeedbackHeader['next']) =>
	attempt >= 2 ? 'continue' : next;

export type ResumeStep =
	/** Feedback was saved but may not have been heard: say it again, then move on. */
	| { kind: 'replay'; answer: StudyAnswer }
	/** The follow-up question ends the first attempt's feedback: say it again, then listen. */
	| { kind: 'followUp'; previous: StudyAnswer | undefined }
	/** Present the part (after the intro at the very start), then listen. */
	| { kind: 'present'; intro: boolean };
export function resumeStep(position: Position, answers: StudyAnswer[]): ResumeStep {
	const at = (attempt: number) =>
		answers.find((a) => a.segmentIndex === position.segmentIndex && a.attempt === attempt);
	const saved = at(position.attempt);
	if (saved) return { kind: 'replay', answer: saved };
	if (position.attempt >= 2) return { kind: 'followUp', previous: at(1) };
	return { kind: 'present', intro: position.segmentIndex === 0 && !answers.length };
}
