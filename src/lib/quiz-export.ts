import {
	FIELD_PLACEHOLDER,
	quizQuestions,
	type Question,
	type QuestionField,
	type Quiz
} from './domain';

const optionList = (field: Extract<QuestionField, { options: unknown }>) =>
	field.options.map((option) => option.text).join(' / ');
/** How a field prints on paper: a blank, or its options to choose from. */
function blank(field: QuestionField) {
	if (field.type === 'select' || field.type === 'multiselect') return `[ ${optionList(field)} ]`;
	if (field.type === 'toggle') return '[ ]';
	return field.type === 'number' && field.unit ? `____ ${field.unit}` : '____';
}
/** The right answer of a field in words. */
function solution(field: QuestionField) {
	const text = (id: string) =>
		'options' in field ? (field.options.find((option) => option.id === id)?.text ?? id) : id;
	switch (field.type) {
		case 'select':
			return text(field.correct);
		case 'multiselect':
			return field.correct.map(text).join('; ') || 'none';
		case 'toggle':
			return field.correct ? 'marked' : 'not marked';
		case 'text':
			return field.accepted[0];
		case 'number':
			return `${field.correct}${field.unit ? ` ${field.unit}` : ''}`;
		case 'essay':
			return field.modelAnswer;
	}
}
const fill = (question: Question, write: (field: QuestionField) => string) =>
	question.body.replace(FIELD_PLACEHOLDER, (placeholder, id: string) => {
		const field = question.fields.find((item) => item.id === id);
		return field ? write(field) : placeholder;
	});

/** A quiz as Markdown: the questions with blanks first, then every question solved. */
export function quizMarkdown(title: string, quiz: Quiz) {
	const numbered = quizQuestions(quiz).map((question, index) => ({ question, number: index + 1 }));
	const section = (heading: string, write: (field: QuestionField) => string, solved: boolean) =>
		[
			`## ${heading}`,
			...numbered.map(({ question, number }) =>
				[
					`### ${number}.`,
					fill(question, write),
					...(solved && question.explanation ? [question.explanation] : [])
				].join('\n\n')
			)
		].join('\n\n');
	return [
		`# ${title}`,
		section('Questions', blank, false),
		section('Solutions', (field) => `**${solution(field)}**`, true)
	].join('\n\n');
}
