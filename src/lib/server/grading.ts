import type { FieldGrade, FieldValue, Grade, Question, QuestionField } from '../domain';

// Answers are graded here without Claude. Only free text (`essay`) stays pending for the grade job.

/**
 * Every number a learner may have meant by what they wrote: `16,67`, `16.67 %`, `1.200.000,--`,
 * `€ 34.000`, `-3,5`. One separator before exactly three digits can group thousands or mark
 * decimals (`1.234`), so both readings come back, thousands first. Empty when it is no number.
 */
export function numberReadings(text: string): number[] {
	const value = text
		.trim()
		.replace(/[−–]/g, '-')
		.replace(/,-+$/, '')
		.replace(/[^0-9.,-]/g, '');
	if (!/^-?[0-9.,]*[0-9][0-9.,]*$/.test(value)) return [];
	const comma = value.lastIndexOf(',');
	const dot = value.lastIndexOf('.');
	const grouped = (separator: string) => value.replaceAll(separator, '');
	let readings: string[];
	// With both signs the last one is the decimal sign; the other one groups thousands.
	if (comma >= 0 && dot >= 0)
		readings = [comma > dot ? grouped('.').replace(',', '.') : grouped(',')];
	else if (comma < 0 && dot < 0) readings = [value];
	else {
		const separator = comma >= 0 ? ',' : '.';
		const decimal = value.replace(separator, '.');
		if (value.indexOf(separator) !== value.lastIndexOf(separator)) readings = [grouped(separator)];
		else if (/^-?[1-9]\d{0,2}[.,]\d{3}$/.test(value)) readings = [grouped(separator), decimal];
		else readings = [decimal];
	}
	return readings.map(Number).filter(Number.isFinite);
}
/** The likeliest reading of a written number, or null when the text is not a number. */
export const parseNumber = (text: string): number | null => numberReadings(text)[0] ?? null;

const normal = (text: string) => text.trim().replace(/\s+/g, ' ').toLocaleLowerCase();
const optionText = (field: Extract<QuestionField, { options: unknown }>, id: string) =>
	field.options.find((option) => option.id === id)?.text ?? id;

/** The right answer of a field in words. */
export function expectedAnswer(field: QuestionField): string {
	switch (field.type) {
		case 'select':
			return optionText(field, field.correct);
		case 'multiselect':
			return field.correct.length
				? field.correct.map((id) => optionText(field, id)).join('; ')
				: 'None of them';
		case 'toggle':
			return field.correct ? 'Marked' : 'Not marked';
		case 'text':
			return field.accepted[0];
		case 'number':
			return `${field.correct}${field.unit ? ` ${field.unit}` : ''}`;
		case 'essay':
			return field.modelAnswer;
	}
}

/** Grades one field. Nothing entered counts as wrong, except for a mark that belongs unset. */
export function gradeField(field: QuestionField, value: FieldValue | undefined): FieldGrade {
	const max = field.points;
	const grade = (share: number): FieldGrade => ({
		fieldId: field.id,
		state: share >= 1 ? 'correct' : share > 0 ? 'partial' : 'incorrect',
		score: Math.round(share * max * 100) / 100,
		max,
		expected: expectedAnswer(field)
	});
	switch (field.type) {
		case 'select':
			return grade(value === field.correct ? 1 : 0);
		case 'multiselect': {
			const chosen = Array.isArray(value) ? [...new Set(value)] : [];
			const right = chosen.filter((id) => field.correct.includes(id)).length;
			const wrong = chosen.length - right;
			// Every wrong tick cancels a right one, so ticking everything earns nothing.
			if (!field.correct.length) return grade(wrong ? 0 : 1);
			return grade(Math.max(0, right - wrong) / field.correct.length);
		}
		case 'toggle':
			return grade((value === true) === field.correct ? 1 : 0);
		case 'text':
			return grade(
				typeof value === 'string' && field.accepted.some((text) => normal(text) === normal(value))
					? 1
					: 0
			);
		case 'number': {
			const entered = typeof value === 'string' ? numberReadings(value) : [];
			// A tiny slack keeps binary fractions from failing an exact answer.
			const slack = field.tolerance + Math.abs(field.correct) * 1e-9;
			return grade(entered.some((number) => Math.abs(number - field.correct) <= slack) ? 1 : 0);
		}
		case 'essay':
			return typeof value === 'string' && value.trim()
				? { fieldId: field.id, state: 'pending', score: 0, max, expected: field.modelAnswer }
				: grade(0);
	}
}

/** The overall state of a question from the grades of its fields. */
export function summarise(questionId: string, fields: FieldGrade[]): Grade {
	const score = fields.reduce((sum, field) => sum + field.score, 0);
	const maxScore = fields.reduce((sum, field) => sum + field.max, 0);
	return {
		questionId,
		score: Math.round(score * 100) / 100,
		maxScore,
		state: fields.some((field) => field.state === 'pending')
			? 'pending'
			: fields.every((field) => field.state === 'correct')
				? 'correct'
				: score > 0
					? 'partial'
					: 'incorrect',
		fields
	};
}

export function gradeQuestion(
	question: Question,
	values: Record<string, FieldValue> | undefined
): Grade {
	return summarise(
		question.id,
		question.fields.map((field) => gradeField(field, values?.[field.id]))
	);
}
