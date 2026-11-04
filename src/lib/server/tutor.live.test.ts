import { describe, it } from 'vitest';
import { speakStream } from './elevenlabs';
import { TutorConversation, primerPrompt } from './tutor';
import { DEFAULT_MODEL, type StudyPlan } from '../domain';

// Opt-in check against the real services: TUTOR_LIVE_TEST=1 with CLAUDE_CODE_OAUTH_TOKEN (and
// ELEVENLABS_API_KEY plus TUTOR_VOICE_ID for speech). It prints the latencies a learner feels.
// TUTOR_MODEL picks a model from Claude Code's list; the default is Claude Code's own default.
const plan: StudyPlan = {
	title: 'Osmose',
	intro: 'Zwei Teile folgen.',
	segments: [
		{
			title: 'Wasser folgt dem Salz',
			explanation: 'Teil eins.',
			question: 'Warum schrumpft eine Gurke in Salzwasser?',
			keyPoints: ['Wasser verlässt die Gurke', 'Außen ist die Salzkonzentration höher'],
			modelAnswer:
				'Wasser wandert durch die Membran zur salzigeren Seite, also aus der Gurke heraus.',
			misconceptions: ['Das Salz dringt ein und drückt die Gurke zusammen.'],
			citations: [{ materialId: '00000000-0000-4000-8000-000000000001', locator: 'page:1' }]
		},
		{
			title: 'Zellen in Süßwasser',
			explanation: 'Teil zwei.',
			question: 'Was passiert mit einer Zelle in Süßwasser?',
			keyPoints: ['Sie nimmt Wasser auf und schwillt an'],
			modelAnswer: 'Sie nimmt Wasser auf und schwillt an.',
			misconceptions: [],
			citations: [{ materialId: '00000000-0000-4000-8000-000000000001', locator: 'page:1' }]
		}
	]
};
const answers = [
	'Weil das Wasser aus der Gurke rausgeht, weil draußen mehr Salz ist.',
	'Keine Ahnung ehrlich gesagt.',
	'Das Salz geht in die Gurke rein und macht sie kleiner.'
];

describe.skipIf(!process.env.TUTOR_LIVE_TEST || !process.env.CLAUDE_CODE_OAUTH_TOKEN)(
	'Live tutor latency',
	() => {
		it(
			'answers spoken answers quickly enough for a conversation',
			async () => {
				const modelId = process.env.TUTOR_MODEL ?? DEFAULT_MODEL;
				const excerpts = 'Osmose: Wasser wandert zur Seite mit höherer Salzkonzentration. '.repeat(
					400
				);
				const tutor = new TutorConversation('live-test', modelId, async () =>
					primerPrompt(plan, excerpts, [])
				);
				let started = Date.now();
				await tutor.warm();
				const rows = [{ step: 'start', ms: Date.now() - started, firstDelta: 0, firstSentence: 0 }];
				for (const answer of answers) {
					started = Date.now();
					let firstDelta = 0;
					let firstSentence = 0;
					let text = '';
					const reply = await tutor.ask(
						`Segment 1 of 2 ("Wasser folgt dem Salz"), attempt 1 of 2.\nQuestion asked: ${plan.segments[0].question}\nLearner answer (transcript): <answer>${answer}</answer>`,
						(delta) => {
							firstDelta ||= Date.now() - started;
							text += delta;
							if (!firstSentence && /\n[^\n]*[.!?]\s/.test(text))
								firstSentence = Date.now() - started;
						}
					);
					rows.push({
						step: reply.split('\n')[0],
						ms: Date.now() - started,
						firstDelta,
						firstSentence
					});
				}
				if (process.env.ELEVENLABS_API_KEY && process.env.TUTOR_VOICE_ID)
					for (const modelId of (process.env.TUTOR_SPEECH_MODELS ?? 'eleven_flash_v2_5').split(
						','
					)) {
						started = Date.now();
						for await (const chunk of speakStream({
							text: 'Genau, das Wasser folgt dem Salz.',
							voiceId: process.env.TUTOR_VOICE_ID,
							modelId
						})) {
							rows.push({
								step: `speech ${modelId}`,
								ms: Date.now() - started,
								firstDelta: chunk.length,
								firstSentence: 0
							});
							break;
						}
					}
				console.table(rows);
				await tutor.close();
			},
			10 * 60_000
		);
	}
);
