import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AnswerTimer, finalNext, nextPosition, resumeStep } from './study-run';
import type { StudyAnswer } from '../domain';

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe('End of an answer', () => {
	it('waits out thinking pauses and finishes after the chosen pause', () => {
		const finish = vi.fn();
		const timer = new AnswerTimer(2500, finish);
		timer.ready();
		timer.speechStart();
		timer.complete('Water moves out');
		vi.advanceTimersByTime(2000);
		// Speaking again cancels the pause.
		timer.speechStart();
		vi.advanceTimersByTime(5000);
		expect(finish).not.toHaveBeenCalled();
		timer.complete('because there is more salt outside.');
		vi.advanceTimersByTime(2499);
		expect(finish).not.toHaveBeenCalled();
		vi.advanceTimersByTime(1);
		expect(finish).toHaveBeenCalledExactlyOnceWith(
			'Water moves out because there is more salt outside.'
		);
	});
	it('counts fifteen seconds of silence, or only noise, as no answer', () => {
		const finish = vi.fn();
		const timer = new AnswerTimer(2500, finish);
		timer.ready();
		timer.speechStart();
		timer.complete('  ');
		vi.advanceTimersByTime(14_999);
		expect(finish).not.toHaveBeenCalled();
		vi.advanceTimersByTime(1);
		expect(finish).toHaveBeenCalledWith('');
	});
	it('finishes at once when the learner is done, or with the last turn while still speaking', () => {
		const quiet = vi.fn();
		const idle = new AnswerTimer(2500, quiet);
		idle.ready();
		expect(idle.done()).toBe(false);
		expect(quiet).toHaveBeenCalledWith('');

		const finish = vi.fn();
		const timer = new AnswerTimer(2500, finish);
		timer.ready();
		timer.speechStart();
		expect(timer.done()).toBe(true);
		expect(finish).not.toHaveBeenCalled();
		timer.complete('It swells.');
		expect(finish).toHaveBeenCalledExactlyOnceWith('It swells.');
		vi.advanceTimersByTime(10_000);
		expect(finish).toHaveBeenCalledOnce();
	});
	it('stops an endless answer after three minutes', () => {
		const finish = vi.fn();
		const timer = new AnswerTimer(2500, finish);
		timer.ready();
		timer.speechStart();
		vi.advanceTimersByTime(180_000);
		expect(finish).toHaveBeenCalledWith('');
	});
});

const answer = (segmentIndex: number, attempt: number, next: StudyAnswer['next']): StudyAnswer => ({
	id: `${segmentIndex}-${attempt}`,
	segmentIndex,
	attempt,
	answer: 'An answer',
	verdict: 'partial',
	next,
	gap: '',
	feedback: 'Feedback.',
	createdAt: ''
});

describe('Session position', () => {
	it('follows up once, then always moves on', () => {
		expect(nextPosition({ segmentIndex: 2, attempt: 1 }, 'continue')).toEqual({
			segmentIndex: 3,
			attempt: 1
		});
		expect(nextPosition({ segmentIndex: 2, attempt: 1 }, 'followUp')).toEqual({
			segmentIndex: 2,
			attempt: 2
		});
		expect(nextPosition({ segmentIndex: 2, attempt: 2 }, 'reexplain')).toEqual({
			segmentIndex: 3,
			attempt: 1
		});
		expect(finalNext(2, 'followUp')).toBe('continue');
		expect(finalNext(1, 'reexplain')).toBe('reexplain');
	});
	it('resumes where the learner stopped without losing or repeating an answer', () => {
		expect(resumeStep({ segmentIndex: 0, attempt: 1 }, [])).toEqual({
			kind: 'present',
			intro: true
		});
		const first = answer(0, 1, 'followUp');
		expect(resumeStep({ segmentIndex: 0, attempt: 1 }, [first])).toEqual({
			kind: 'replay',
			answer: first
		});
		expect(resumeStep({ segmentIndex: 0, attempt: 2 }, [first])).toEqual({
			kind: 'followUp',
			previous: first
		});
		expect(resumeStep({ segmentIndex: 1, attempt: 1 }, [first, answer(0, 2, 'continue')])).toEqual({
			kind: 'present',
			intro: false
		});
	});
});
