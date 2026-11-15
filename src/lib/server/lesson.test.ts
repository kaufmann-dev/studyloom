import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Snapshot } from '../domain';
import { writeLesson, type LessonRun } from './lesson';
import { outputDir, outputImagePath } from './outline';

const materialId = '00000000-0000-4000-8000-000000000001';
const jobId = '00000000-0000-4000-8000-0000000000aa';
const ref = (locator: string) => ({ materialId, locator });
const snapshot: Snapshot = [
	{
		id: materialId,
		name: 'Script',
		chunks: [
			{ locator: 'page:1', kind: 'text', text: 'Rentability relates profit to capital.' },
			{ locator: 'page:2', kind: 'text', text: 'Liquidity keeps a company able to pay.' }
		],
		figures: []
	}
];
const outline = {
	title: 'Key figures',
	parts: [
		{
			title: 'Rentability',
			sections: [{ title: 'Profit and capital', locators: [ref('page:1')], exercises: [] }]
		},
		{
			title: 'Liquidity',
			sections: [{ title: 'Able to pay', locators: [ref('page:2')], exercises: [] }]
		}
	]
};
const chapter = (title: string, locator: string) => ({
	sections: [
		{
			title,
			beats: [
				{
					narration: `${title} in a picture.`,
					slide: { kind: 'illustration', prompt: `A diagram of ${title}`, caption: title }
				},
				{ narration: 'And in words.', slide: { kind: 'content', markdown: '- One point' } }
			],
			questions: [],
			citations: [ref(locator)]
		}
	]
});
const png = Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), Buffer.alloc(16)]);

describe('lesson writing', () => {
	let data: string;
	let saved: string | undefined;
	beforeEach(async () => {
		saved = process.env.DATA_DIR;
		data = await mkdtemp(join(tmpdir(), 'studyloom-lesson-'));
		process.env.DATA_DIR = data;
	});
	afterEach(async () => {
		if (saved === undefined) delete process.env.DATA_DIR;
		else process.env.DATA_DIR = saved;
		await rm(data, { recursive: true, force: true });
	});
	const run = (ask: LessonRun['ask'], illustrate?: LessonRun['illustrate']): LessonRun => ({
		jobId,
		workspace: join(data, 'jobs', jobId),
		snapshot,
		coverage: 'standard',
		styles: ['choice', 'embedded', 'written'],
		sections: { target: 2, max: 4 },
		signal: AbortSignal.timeout(10_000),
		progress: () => {},
		ask,
		writeData: async () => {},
		illustrate
	});

	it('pays for no chapter and no illustration twice when a run is repeated', async () => {
		const answers = [
			outline,
			chapter('Profit and capital', 'page:1'),
			chapter('Able to pay', 'page:2')
		];
		const ask = vi.fn(async () => answers.shift()) as unknown as LessonRun['ask'];
		const illustrate = vi
			.fn<NonNullable<LessonRun['illustrate']>>()
			.mockResolvedValueOnce({ data: png, mimeType: 'image/png' })
			.mockRejectedValueOnce(new Error('The Gemini image quota is used up.'));
		await expect(writeLesson(run(ask, illustrate))).rejects.toThrow('quota');
		expect(ask).toHaveBeenCalledTimes(3);
		expect(await readFile(outputImagePath(jobId, 'gen-c01s01b1'))).toEqual(png);

		// The second run finds the outline, both chapters and the first picture already there.
		illustrate.mockResolvedValueOnce({ data: png, mimeType: 'image/png' });
		const { lesson, content } = await writeLesson(run(ask, illustrate));
		expect(ask).toHaveBeenCalledTimes(3);
		expect(illustrate).toHaveBeenCalledTimes(3);
		expect(illustrate.mock.calls[2][0]).toBe('A diagram of Able to pay');
		expect(lesson.images).toEqual([
			{
				id: 'gen-c01s01b1',
				origin: 'generated',
				label: 'Profit and capital',
				mimeType: 'image/png'
			},
			{ id: 'gen-c02s01b1', origin: 'generated', label: 'Able to pay', mimeType: 'image/png' }
		]);
		expect(lesson.chapters[1].sections[0].beats[0].slide).toEqual({
			kind: 'image',
			image: 'gen-c02s01b1',
			caption: 'Able to pay'
		});
		expect(content).toContain('## 1. Rentability');
		expect(outputDir(jobId)).toContain(data);
	});
	it('sends an illustration back when illustrations are switched off', async () => {
		const plain = {
			sections: [
				{
					...chapter('Profit and capital', 'page:1').sections[0],
					beats: [{ narration: 'In words.', slide: { kind: 'content', markdown: '- Point' } }]
				}
			]
		};
		const single = { ...outline, parts: [outline.parts[0]] };
		const answers = [single, chapter('Profit and capital', 'page:1'), plain];
		const ask = vi.fn(async () => answers.shift()) as unknown as LessonRun['ask'];
		const { lesson } = await writeLesson(run(ask));
		expect(ask).toHaveBeenCalledTimes(3);
		expect(vi.mocked(ask).mock.calls[2][0]).toContain('Illustrations are switched off');
		expect(lesson.images).toEqual([]);
	});
});
