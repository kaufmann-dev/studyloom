import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AnswerCollector, finalNext, nextPosition, resumeStep } from './study-run';
import type { StudyAnswer } from '../domain';

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe('End of an answer', () => {
	it('never ends on a pause, only when the learner is done and the stream has closed', () => {
		const finish = vi.fn();
		const answer = new AnswerCollector(finish, vi.fn());
		answer.ready();
		answer.complete('Water moves out');
		vi.advanceTimersByTime(60_000);
		answer.complete('  ');
		answer.complete('because there is more salt outside.');
		expect(finish).not.toHaveBeenCalled();
		answer.done();
		expect(finish).not.toHaveBeenCalled();
		// The last words arrive before the stream closes.
		answer.complete('I think.');
		expect(answer.closed()).toBe(true);
		expect(finish).toHaveBeenCalledExactlyOnceWith(
			'Water moves out because there is more salt outside. I think.'
		);
		vi.advanceTimersByTime(10_000);
		expect(finish).toHaveBeenCalledOnce();
	});
	it('finishes shortly after done when the stream does not close, and with nothing said', () => {
		const finish = vi.fn();
		const answer = new AnswerCollector(finish, vi.fn());
		answer.ready();
		answer.done();
		vi.advanceTimersByTime(4_999);
		expect(finish).not.toHaveBeenCalled();
		vi.advanceTimersByTime(1);
		expect(finish).toHaveBeenCalledWith('');
	});
	it('reports an unexpected close and pauses after ten minutes without done', () => {
		const finish = vi.fn();
		const timeout = vi.fn();
		const answer = new AnswerCollector(finish, timeout);
		answer.ready();
		expect(answer.closed()).toBe(false);
		vi.advanceTimersByTime(10 * 60_000);
		expect(timeout).toHaveBeenCalledOnce();
		answer.done();
		vi.advanceTimersByTime(10_000);
		expect(finish).not.toHaveBeenCalled();
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
