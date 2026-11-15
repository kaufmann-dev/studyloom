import { describe, expect, it } from 'vitest';
import { questionSchema, questionStyle, coverageBudget, type QuestionField } from '../domain';
import { gradeField, gradeQuestion, parseNumber } from './grading';

const citation = { materialId: '00000000-0000-4000-8000-000000000001', locator: 'page:1' };
const options = [
	{ id: 'a', text: 'Kunden' },
	{ id: 'b', text: 'Lieferanten' },
	{ id: 'c', text: 'Kapitalgeber' }
];
const field = (value: Record<string, unknown>) =>
	questionSchema.shape.fields.element.parse(value) as QuestionField;
const question = (body: string, fields: unknown[]) => ({
	id: 'q1',
	body,
	fields,
	explanation: '',
	feedback: { correct: '', incorrect: '' },
	citations: [citation]
});

describe('numbers as learners write them', () => {
	it.each([
		['16,67', 16.67],
		['16.67 %', 16.67],
		['1.200.000,--', 1200000],
		['€ 34.000', 34000],
		['34,000', 34000],
		['1,234.56', 1234.56],
		['1.234,56', 1234.56],
		['−3,5', -3.5],
		['0.125', 0.125],
		['773 Stück', 773]
	])('reads %s', (text, value) => expect(parseNumber(text)).toBe(value));
	it('rejects what is not a number', () => {
		expect(parseNumber('')).toBeNull();
		expect(parseNumber('viel')).toBeNull();
		expect(parseNumber('--')).toBeNull();
	});
});

describe('field grading', () => {
	it('grades single choices and marks', () => {
		const select = field({ id: 'f', type: 'select', display: 'dropdown', options, correct: 'b' });
		expect(gradeField(select, 'b')).toMatchObject({
			state: 'correct',
			score: 1,
			expected: 'Lieferanten'
		});
		expect(gradeField(select, 'a').state).toBe('incorrect');
		expect(gradeField(select, undefined).state).toBe('incorrect');
		const marked = field({ id: 'f', type: 'toggle', correct: true });
		const empty = field({ id: 'f', type: 'toggle', correct: false });
		expect(gradeField(marked, true).state).toBe('correct');
		expect(gradeField(marked, undefined).state).toBe('incorrect');
		// A cell that belongs empty is right when nothing was entered.
		expect(gradeField(empty, undefined).state).toBe('correct');
		expect(gradeField(empty, true).state).toBe('incorrect');
	});
	it('gives partial credit for several right answers and none for ticking everything', () => {
		const multi = field({ id: 'f', type: 'multiselect', points: 2, options, correct: ['a', 'c'] });
		expect(gradeField(multi, ['a', 'c'])).toMatchObject({ state: 'correct', score: 2 });
		expect(gradeField(multi, ['a'])).toMatchObject({ state: 'partial', score: 1 });
		expect(gradeField(multi, ['a', 'b', 'c'])).toMatchObject({ state: 'partial', score: 1 });
		expect(gradeField(multi, ['b']).state).toBe('incorrect');
		const none = field({ id: 'f', type: 'multiselect', options, correct: [] });
		expect(gradeField(none, []).state).toBe('correct');
		expect(gradeField(none, ['a']).state).toBe('incorrect');
	});
	it('compares text loosely and numbers within their tolerance', () => {
		const text = field({ id: 'f', type: 'text', accepted: ['Break-even-Point', 'Gewinnschwelle'] });
		expect(gradeField(text, '  gewinnschwelle ').state).toBe('correct');
		expect(gradeField(text, 'Cashflow').state).toBe('incorrect');
		const number = field({ id: 'f', type: 'number', correct: 16.67, tolerance: 0.01, unit: '%' });
		expect(gradeField(number, '16,67 %')).toMatchObject({ state: 'correct', expected: '16.67 %' });
		expect(gradeField(number, '16,7').state).toBe('incorrect');
		expect(gradeField(number, 'viel').state).toBe('incorrect');
		// 1.234 may be one thousand or a decimal; either reading can be the right answer.
		const small = field({ id: 'f', type: 'number', correct: 1.234 });
		const large = field({ id: 'f', type: 'number', correct: 1234 });
		expect(gradeField(small, '1.234').state).toBe('correct');
		expect(gradeField(large, '1.234').state).toBe('correct');
	});
	it('leaves written answers to Claude unless nothing was written', () => {
		const essay = field({ id: 'f', type: 'essay', modelAnswer: 'Because…', rubric: '' });
		expect(gradeField(essay, 'My reasoning').state).toBe('pending');
		expect(gradeField(essay, '  ').state).toBe('incorrect');
	});
});

describe('questions', () => {
	const matrix = question(
		'| Markt | Kunden |\n|---|---|\n| Absatzmarkt | {{a}} |\n| Arbeitsmarkt | {{b}} |',
		[
			{ id: 'a', type: 'toggle', correct: true },
			{ id: 'b', type: 'toggle', correct: false }
		]
	);
	it('adds up the fields of a table question', () => {
		const parsed = questionSchema.parse(matrix);
		expect(gradeQuestion(parsed, { a: true })).toMatchObject({
			state: 'correct',
			score: 2,
			maxScore: 2
		});
		expect(gradeQuestion(parsed, { a: true, b: true })).toMatchObject({
			state: 'partial',
			score: 1
		});
		expect(gradeQuestion(parsed, undefined)).toMatchObject({ state: 'partial', score: 1 });
		expect(questionStyle(parsed)).toBe('embedded');
	});
	it('requires every field in the body exactly once and correct answers among the options', () => {
		expect(() => questionSchema.parse({ ...matrix, body: 'Only {{a}}' })).toThrow('{{b}}');
		expect(() => questionSchema.parse({ ...matrix, body: `${matrix.body} {{a}}` })).toThrow(
			'{{a}}'
		);
		expect(() => questionSchema.parse({ ...matrix, body: `${matrix.body} {{zz}}` })).toThrow('zz');
		expect(() =>
			questionSchema.parse(
				question('{{f}}', [{ id: 'f', type: 'select', display: 'radio', options, correct: 'x' }])
			)
		).toThrow('correct answer');
	});
	it('names the style of a question by its fields', () => {
		const style = (fields: unknown[]) =>
			questionStyle(
				questionSchema.parse(question(fields.map((_, i) => `{{f${i}}}`).join(' '), fields))
			);
		expect(style([{ id: 'f0', type: 'select', display: 'radio', options, correct: 'a' }])).toBe(
			'choice'
		);
		expect(style([{ id: 'f0', type: 'multiselect', options, correct: ['a'] }])).toBe('choice');
		expect(style([{ id: 'f0', type: 'essay', modelAnswer: 'x', rubric: '' }])).toBe('written');
		expect(style([{ id: 'f0', type: 'number', correct: 1 }])).toBe('embedded');
		expect(
			style([
				{ id: 'f0', type: 'select', display: 'dropdown', options, correct: 'a' },
				{ id: 'f1', type: 'select', display: 'dropdown', options, correct: 'b' }
			])
		).toBe('embedded');
	});
});

describe('coverage budgets', () => {
	const kinds = ['audio', 'session', 'quiz', 'lesson'] as const;
	it('grow with the sources and with the coverage, within their limits', () => {
		for (const kind of kinds) {
			const at = (coverage: 'light' | 'standard' | 'comprehensive', characters: number) =>
				coverageBudget(kind, coverage, { characters, exercises: 0 }).target;
			for (const size of [1000, 50_000, 600_000]) {
				expect(at('light', size)).toBeLessThanOrEqual(at('standard', size));
				expect(at('standard', size)).toBeLessThanOrEqual(at('comprehensive', size));
			}
			for (const coverage of ['light', 'standard', 'comprehensive'] as const) {
				expect(at(coverage, 1000)).toBeLessThanOrEqual(at(coverage, 50_000));
				expect(at(coverage, 50_000)).toBeLessThanOrEqual(at(coverage, 600_000));
				expect(at(coverage, 1000)).toBeGreaterThan(0);
			}
		}
	});
	it('makes a comprehensive quiz at least as long as the sources have exercises', () => {
		const budget = coverageBudget('quiz', 'comprehensive', { characters: 20_000, exercises: 101 });
		expect(budget.target).toBe(101);
		expect(budget.max).toBeGreaterThan(101);
		expect(coverageBudget('quiz', 'standard', { characters: 20_000, exercises: 101 }).target).toBe(
			8
		);
	});
});
