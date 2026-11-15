import type { StudyOutput } from './domain';

/** The words for each kind of generated study tool. */
export const STUDY_TOOLS: Record<
	StudyOutput['kind'],
	{ one: string; many: string; heading: string; title: string; intro: string }
> = {
	lesson: {
		one: 'lesson',
		many: 'lessons',
		heading: 'Lessons',
		title: 'Learn it step by step',
		intro:
			'Each chapter is explained with slides and figures from your sources, then checked with questions you answer by typing and clicking.'
	},
	summary: {
		one: 'summary',
		many: 'summaries',
		heading: 'Overviews',
		title: 'Build an overview',
		intro: 'Turn your selected materials into an overview with references to the original sources.'
	},
	quiz: {
		one: 'quiz',
		many: 'quizzes',
		heading: 'Quizzes',
		title: 'Test your understanding',
		intro:
			'Create questions from your selected sources, then get feedback on multiple-choice and written answers.'
	},
	audio: {
		one: 'audio summary',
		many: 'audio summaries',
		heading: 'Audio summaries',
		title: 'Listen to your sources',
		intro:
			'Turn your selected materials into a narrated summary or a tutor and learner conversation, with pauses to think along.'
	},
	session: {
		one: 'study session',
		many: 'study sessions',
		heading: 'Study sessions',
		title: 'Study out loud',
		intro:
			'A voice tutor explains each part, asks you a question and responds to your spoken answer. Once it starts, you only need to talk.'
	}
};
