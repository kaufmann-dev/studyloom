import { mkdir, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { and, eq } from 'drizzle-orm';
import { lessonQuestions, type LessonInfo } from '../domain';
import { MP3_FORMAT } from './audio';
import { ClientError } from './config';
import { db } from './db';
import * as t from './db/schema';
import { speak } from './elevenlabs';
import { outputDir } from './outline';
import { isMissingFile, writeAtomic } from './voicing';

// A lesson's speech is made clip by clip: when a clip is first asked for, or all at once by a
// voice job. Every clip is stored, so nothing is voiced, or paid for, twice.

const clipsDir = (outputId: string) => join(outputDir(outputId), 'clips');
/** Clip keys are ids this app assigned; anything else never reaches the file system. */
const SAFE_KEY = /^[A-Za-z0-9-]{1,80}$/;
const ANSWER_KEY = /^answer-([0-9a-f-]{36})$/;
const clipPath = (outputId: string, key: string) => join(clipsDir(outputId), `${key}.mp3`);
export const removeClips = (outputId: string) =>
	rm(clipsDir(outputId), { recursive: true, force: true });

/** The keys of every explanation clip of a lesson, in teaching order. */
export const beatKeys = (info: LessonInfo) =>
	info.lesson.chapters.flatMap((chapter) =>
		chapter.sections.flatMap((section) => section.beats.map((beat) => beat.id))
	);

/**
 * What a clip says: a beat's narration, a question's prepared feedback (`<question>-correct`,
 * `<question>-incorrect`) or Claude's feedback on a written answer (`answer-<id>`).
 */
async function clipText(outputId: string, info: LessonInfo, key: string) {
	const sections = info.lesson.chapters.flatMap((chapter) => chapter.sections);
	const beat = sections.flatMap((section) => section.beats).find((item) => item.id === key);
	if (beat) return beat.narration;
	const feedback = /^(.+)-(correct|incorrect)$/.exec(key);
	if (feedback) {
		const question = lessonQuestions(info.lesson).find((item) => item.id === feedback[1]);
		return question?.feedback[feedback[2] as 'correct' | 'incorrect'];
	}
	const answer = ANSWER_KEY.exec(key);
	if (!answer) return undefined;
	const [row] = await db()
		.select({ feedback: t.lessonAnswers.feedback })
		.from(t.lessonAnswers)
		.where(and(eq(t.lessonAnswers.id, answer[1]), eq(t.lessonAnswers.outputId, outputId)));
	return row?.feedback;
}

/** The stored clip, or nothing while it has not been voiced. */
export async function existingClip(outputId: string, key: string) {
	if (!SAFE_KEY.test(key)) return undefined;
	const path = clipPath(outputId, key);
	return stat(path).then(
		() => path,
		(error) => {
			if (isMissingFile(error)) return undefined;
			throw error;
		}
	);
}

const voicing = new Map<string, Promise<string>>();
/**
 * Returns a clip's file, voicing it first if it does not exist yet. Requests for the same clip
 * share one call to ElevenLabs, whether they come from the player or from a voice job.
 */
export async function ensureClip(
	output: { id: string; lesson: LessonInfo | null },
	key: string,
	signal?: AbortSignal
): Promise<string> {
	const info = output.lesson;
	if (!info) throw new ClientError(404, 'This output is not a lesson.');
	const { voice } = info;
	if (!voice) throw new ClientError(409, 'This lesson has no voice. Choose one first.');
	const existing = await existingClip(output.id, key);
	if (existing) return existing;
	const text = SAFE_KEY.test(key) ? (await clipText(output.id, info, key))?.trim() : undefined;
	if (!text) throw new ClientError(404, 'There is nothing to say for this clip.');
	const id = `${output.id}:${key}`;
	let pending = voicing.get(id);
	if (!pending) {
		pending = (async () => {
			// Clips are voiced in any order, so none is stitched to a previous request.
			const { audio } = await speak({
				text,
				voiceId: voice.voiceId,
				modelId: voice.speechModelId,
				format: MP3_FORMAT,
				previousRequestIds: [],
				signal
			});
			await mkdir(clipsDir(output.id), { recursive: true, mode: 0o700 });
			const path = clipPath(output.id, key);
			await writeAtomic(path, audio);
			return path;
		})().finally(() => voicing.delete(id));
		voicing.set(id, pending);
	}
	return pending;
}
