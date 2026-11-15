import { beforeEach, describe, expect, it } from 'vitest';
import { lessonSchema, type LessonAnswer } from '#lib/domain.js';
import { LessonSession } from './lesson.svelte.js';

const citation = { materialId: '00000000-0000-4000-8000-000000000001', locator: 'page:1' };
const question = (id: string) => ({
	id,
	body: 'Value: {{value}}',
	fields: [{ id: 'value', type: 'number', correct: 25 }],
	explanation: '',
	feedback: { correct: 'Right, because…', incorrect: 'It is 25, because…' },
	citations: [citation]
});
const section = (id: string, beats: number, questions: string[]) => ({
	id,
	title: id,
	beats: Array.from({ length: beats }, (_, i) => ({
		id: `${id}b${i + 1}`,
		narration: 'Listen.',
		slide: { kind: 'content', markdown: 'Point' }
	})),
	questions: questions.map(question),
	citations: [citation]
});
const lesson = lessonSchema.parse({
	title: 'Key figures',
	chapters: [
		{ id: 'c01', title: 'One', sections: [section('c01s01', 2, ['q1']), section('c01s02', 1, [])] },
		{ id: 'c02', title: 'Two', sections: [section('c02s01', 1, ['q2'])] }
	]
});
const answered = (questionId: string, state: 'correct' | 'incorrect'): LessonAnswer => ({
	id: questionId,
	questionId,
	values: { value: '25' },
	result: { questionId, score: state === 'correct' ? 1 : 0, maxScore: 1, state, fields: [] },
	status: 'graded',
	feedback: '',
	createdAt: ''
});

describe('Lesson session', () => {
	beforeEach(() => localStorage.clear());

	it('walks every beat and question in order and jumps to sections', () => {
		const session = new LessonSession('lesson-1', lesson, []);
		expect(session.steps.map((step) => step.kind)).toEqual([
			'beat',
			'beat',
			'question',
			'beat',
			'beat',
			'question'
		]);
		expect(session.position).toBe(0);
		session.next();
		session.next();
		expect(session.question?.id).toBe('q1');
		session.goTo(1, 0);
		expect(session.section.id).toBe('c02s01');
		expect(session.sectionSteps.map((item) => item.position)).toEqual([4, 5]);
		session.next();
		session.next();
		expect(session.finished).toBe(true);
		session.next();
		expect(session.position).toBe(session.steps.length);
		session.previous();
		expect(session.question?.id).toBe('q2');
	});
	it('starts at the first open question, then where the learner left', () => {
		const first = new LessonSession('lesson-2', lesson, [answered('q1', 'correct')]);
		// q1 is answered, so the lesson opens on the section of q2.
		expect(first.section.id).toBe('c02s01');
		first.goTo(0, 1);
		const again = new LessonSession('lesson-2', lesson, [answered('q1', 'correct')]);
		expect(again.section.id).toBe('c01s02');
	});
	it('knows what is done and what the tutor says', () => {
		const session = new LessonSession('lesson-3', lesson, [answered('q1', 'incorrect')]);
		const [one, two] = lesson.chapters[0].sections;
		expect(session.isDone(one)).toBe(true);
		// A section without questions is done once it was opened.
		expect(session.isDone(two)).toBe(false);
		session.goTo(0, 1);
		expect(session.isDone(two)).toBe(true);
		expect(session.feedbackOf(one.questions[0])).toBe('It is 25, because…');
		expect(session.score(lesson.chapters[0].sections)).toEqual({ earned: 0, possible: 1 });
		session.retry(one.questions[0]);
		expect(session.answerOf('q1')).toBeUndefined();
		expect(session.valuesOf('q1')).toEqual({});
	});
});
