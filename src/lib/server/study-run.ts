import type { FeedbackHeader, StudyAnswer } from '../domain';

/** Listening this long without "I'm done" pauses the session instead of streaming forever. */
const MAX_LISTEN_MS = 10 * 60_000;
/** After "I'm done", the last words still being transcribed may take this long to arrive. */
const FLUSH_WAIT_MS = 5_000;

/**
 * Collects a spoken answer until the learner says they are done. Pauses never end an answer,
 * so nobody has to hurry; "I'm done" is the only way to finish one.
 */
export class AnswerCollector {
	private parts: string[] = [];
	private doneRequested = false;
	private finished = false;
	private flush: ReturnType<typeof setTimeout> | undefined;
	private cap: ReturnType<typeof setTimeout> | undefined;
	constructor(
		private readonly onFinish: (answer: string) => void,
		private readonly onTimeout: () => void
	) {}
	/** Listening has begun. */
	ready() {
		this.cap = setTimeout(() => {
			if (this.finished) return;
			this.dispose();
			this.onTimeout();
		}, MAX_LISTEN_MS);
	}
	/** A finished speech turn. */
	complete(text: string) {
		if (!this.finished && text.trim()) this.parts.push(text.trim());
	}
	/**
	 * The learner is done. The caller then ends the transcription stream, which delivers the last
	 * words before it closes; the answer finishes at the close, or after a short wait.
	 */
	done() {
		if (this.doneRequested || this.finished) return;
		this.doneRequested = true;
		this.flush = setTimeout(() => this.finish(), FLUSH_WAIT_MS);
	}
	/** The stream closed. Returns false when that was not expected, so the caller can fail. */
	closed() {
		if (!this.doneRequested) return this.finished;
		this.finish();
		return true;
	}
	dispose() {
		this.finished = true;
		clearTimeout(this.flush);
		clearTimeout(this.cap);
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
