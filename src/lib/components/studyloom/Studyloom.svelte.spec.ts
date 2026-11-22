import { afterEach, describe, expect, it, vi } from 'vitest';
import { page } from 'vitest/browser';
import { render } from 'vitest-browser-svelte';
import JobActivity from './JobActivity.svelte';
import Upload from './Upload.svelte';
import WebSource from './WebSource.svelte';
import PasteText from './PasteText.svelte';
import type {
	ClaudeModel,
	Job,
	Conversation,
	LibraryEntry,
	LibraryFolder,
	Message,
	Occurrence,
	Task
} from '#lib/domain.js';
import { addDays, localDate, monthGrid } from '#lib/calendar.js';
import MonthView from './calendar/MonthView.svelte';
import TaskListFixture from './tasks/TaskListFixture.svelte';
import Chat from './Chat.svelte';
import LibraryBrowser from './library/LibraryBrowser.svelte';
import MoveDialog from './library/MoveDialog.svelte';
import Markdown from './Markdown.svelte';
import QuestionCard from './QuestionCard.svelte';
import GenerateForm from './GenerateForm.svelte';
import StudyPlayer from './StudyPlayer.svelte';
import type { TutorSession } from '#lib/study/tutor.svelte.js';
import Projects from '../../../routes/projects/+page.svelte';

function response(body: unknown, status = 200) {
	return new Response(JSON.stringify(body), {
		status,
		headers: { 'content-type': 'application/json' }
	});
}

function chooseFile() {
	const input = document.querySelector<HTMLInputElement>('input[type="file"]');
	if (!input) throw new Error('File picker was not rendered.');
	const files = new DataTransfer();
	files.items.add(new File(['abc'], 'notes.xyz'));
	input.files = files.files;
	input.dispatchEvent(new Event('change', { bubbles: true }));
}

afterEach(() => vi.restoreAllMocks());

describe('Upload', () => {
	it('deletes the pending source before clearing it', async () => {
		const onSaved = vi.fn();
		const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
			const path = String(input);
			if (path.endsWith('/uploads')) return response({ materialId: 'material-1', chunkSize: 2 });
			if (path.endsWith('/complete')) return response({ message: 'Finish failed' }, 500);
			if (init?.method === 'DELETE') return response({ ok: true });
			return response({ ok: true });
		});
		render(Upload, { projectId: 'project-1', modelId: 'model-1', onSaved });
		chooseFile();
		await expect.element(page.getByRole('alert')).toHaveTextContent('Finish failed');

		await page.getByRole('button', { name: 'Discard' }).click();
		await vi.waitFor(() => expect(onSaved).toHaveBeenCalledOnce());
		expect(fetchMock).toHaveBeenCalledWith(
			'/api/materials/material-1',
			expect.objectContaining({ method: 'DELETE' })
		);
		await expect.element(page.getByRole('button', { name: 'Discard' })).not.toBeInTheDocument();
	});

	it('keeps a pending upload resumable when deletion fails', async () => {
		const onSaved = vi.fn();
		let chunkCalls = 0;
		let completeCalls = 0;
		vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
			const path = String(input);
			if (path.endsWith('/uploads')) return response({ materialId: 'material-2', chunkSize: 2 });
			if (path.includes('/chunks/')) {
				chunkCalls++;
				return response({ ok: true });
			}
			if (path.endsWith('/complete')) {
				completeCalls++;
				return completeCalls === 1
					? response({ message: 'Finish failed' }, 500)
					: response({ ok: true });
			}
			if (init?.method === 'DELETE') return response({ message: 'Cannot delete' }, 500);
			return response({ ok: true });
		});
		render(Upload, { projectId: 'project-1', modelId: 'model-1', onSaved });
		chooseFile();
		await expect.element(page.getByRole('alert')).toHaveTextContent('Finish failed');

		await page.getByRole('button', { name: 'Discard' }).click();
		await expect.element(page.getByRole('alert')).toHaveTextContent('Cannot delete');
		await expect.element(page.getByRole('button', { name: 'Resume upload' })).toBeInTheDocument();
		expect(onSaved).not.toHaveBeenCalled();

		await page.getByRole('button', { name: 'Resume upload' }).click();
		await vi.waitFor(() => expect(onSaved).toHaveBeenCalledOnce());
		expect(chunkCalls).toBe(2);
		expect(completeCalls).toBe(2);
	});
});

describe('PasteText', () => {
	it('requires text, then sends it with the optional name and clears the form', async () => {
		const onSaved = vi.fn();
		const fetchMock = vi
			.spyOn(globalThis, 'fetch')
			.mockImplementation(async () => response({ materialId: 'material-1' }, 201));
		render(PasteText, { projectId: 'project-1', onSaved });
		await page.getByRole('button', { name: 'Add text' }).click();
		await expect.element(page.getByText('Paste some text.')).toBeVisible();
		expect(fetchMock).not.toHaveBeenCalled();

		await page.getByLabelText('Paste text').fill('Osmosis\n\nWater follows salt.');
		await page.getByLabelText('Name').fill('Biology notes');
		await page.getByRole('button', { name: 'Add text' }).click();
		await vi.waitFor(() => expect(onSaved).toHaveBeenCalledOnce());
		expect(fetchMock).toHaveBeenCalledWith(
			'/api/projects/project-1/text-sources',
			expect.objectContaining({ method: 'POST' })
		);
		expect(JSON.parse(String(fetchMock.mock.calls[0][1]?.body))).toEqual({
			name: 'Biology notes',
			text: 'Osmosis\n\nWater follows salt.'
		});
		await expect.element(page.getByLabelText('Paste text')).toHaveValue('');
	});
});

describe('WebSource', () => {
	it('rejects addresses that are not web addresses without calling the server', async () => {
		const fetchMock = vi.spyOn(globalThis, 'fetch');
		render(WebSource, { projectId: 'project-1', modelId: 'model-1', onSaved: vi.fn() });
		await page.getByLabelText('Web page').fill('ftp://example.com/file');
		await page.getByRole('button', { name: 'Add web page' }).click();
		await expect.element(page.getByText('Enter an http or https web address.')).toBeInTheDocument();
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it('sends the address with the processing model and clears the field', async () => {
		const onSaved = vi.fn();
		const fetchMock = vi
			.spyOn(globalThis, 'fetch')
			.mockImplementation(async () => response({ materialId: 'material-1', jobId: 'job-1' }, 202));
		render(WebSource, { projectId: 'project-1', modelId: 'model-1', onSaved });
		await page.getByLabelText('Web page').fill('https://example.com/article');
		await page.getByRole('button', { name: 'Add web page' }).click();
		await vi.waitFor(() => expect(onSaved).toHaveBeenCalledOnce());
		expect(fetchMock).toHaveBeenCalledWith(
			'/api/projects/project-1/web-sources',
			expect.objectContaining({
				method: 'POST',
				body: JSON.stringify({
					url: 'https://example.com/article',
					modelId: 'model-1',
					process: true
				})
			})
		);
		await expect.element(page.getByLabelText('Web page')).toHaveValue('');
	});

	it('reports a page that cannot be downloaded and keeps the address', async () => {
		const onSaved = vi.fn();
		vi.spyOn(globalThis, 'fetch').mockImplementation(async () =>
			response({ message: 'The page was not found (HTTP 404).' }, 400)
		);
		render(WebSource, { projectId: 'project-1', modelId: 'model-1', onSaved });
		await page.getByLabelText('Web page').fill('https://example.com/gone');
		await page.getByRole('button', { name: 'Add web page' }).click();
		await expect
			.element(page.getByRole('alert'))
			.toHaveTextContent('The page was not found (HTTP 404).');
		await expect.element(page.getByLabelText('Web page')).toHaveValue('https://example.com/gone');
		expect(onSaved).not.toHaveBeenCalled();
	});
});

const conversations: Conversation[] = ['a', 'b', 'c', 'created'].map((id) => ({
	id,
	projectId: 'project-1',
	title: `Conversation ${id.toUpperCase()}`,
	materialIds: ['source-1'],
	modelId: 'model-1',
	createdAt: '2026-01-01T00:00:00Z',
	updatedAt: '2026-01-01T00:00:00Z'
}));
const models: ClaudeModel[] = [{ modelId: 'model-1', displayLabel: 'Model 1', description: '' }];

function result(id: string) {
	const message: Message = {
		id: `message-${id}`,
		conversationId: id,
		role: 'user',
		content: `Message ${id.toUpperCase()}`,
		citations: [],
		modelId: null,
		createdAt: '2026-01-01T00:00:00Z'
	};
	return new Response(
		JSON.stringify({
			conversation: conversations.find((item) => item.id === id),
			messages: [message]
		}),
		{ status: 200, headers: { 'content-type': 'application/json' } }
	);
}

function selectConversation(id: string) {
	const select = document.querySelector<HTMLSelectElement>('#conversation');
	if (!select) throw new Error('Conversation picker was not rendered.');
	select.value = id;
	select.dispatchEvent(new Event('change', { bubbles: true }));
}

describe('Chat', () => {
	it('restores the loaded conversation after failure and ignores late responses', async () => {
		const pending = new Map<string, Array<(response: Response) => void>>();
		vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
			const id = String(input).split('/').at(-1) ?? '';
			return new Promise<Response>((resolve) => {
				pending.set(id, [...(pending.get(id) ?? []), resolve]);
			});
		});
		function finish(id: string, response: Response) {
			const resolve = pending.get(id)?.shift();
			if (!resolve) throw new Error(`No pending request for ${id}.`);
			resolve(response);
		}
		render(Chat, {
			projectId: 'project-1',
			materialIds: ['source-1'],
			materials: [],
			models,
			conversations,
			jobs: [],
			onChanged: vi.fn()
		});

		selectConversation('a');
		finish('a', result('a'));
		await expect.element(page.getByText('Message A')).toBeInTheDocument();

		selectConversation('b');
		await expect.element(page.getByText('Message A')).not.toBeInTheDocument();
		await expect
			.element(page.getByRole('button', { name: 'Copy conversation' }))
			.not.toBeInTheDocument();
		finish('b', new Response(JSON.stringify({ message: 'Load failed' }), { status: 500 }));
		await expect.element(page.getByRole('alert')).toHaveTextContent('Load failed');
		await expect.element(page.getByText('Message A')).toBeInTheDocument();
		expect(document.querySelector<HTMLSelectElement>('#conversation')?.value).toBe('a');

		selectConversation('b');
		selectConversation('c');
		finish('c', result('c'));
		await expect.element(page.getByText('Message C')).toBeInTheDocument();
		finish('b', result('b'));
		await expect.element(page.getByText('Message B')).not.toBeInTheDocument();
		expect(document.querySelector<HTMLSelectElement>('#conversation')?.value).toBe('c');
	});

	it('keeps an accepted chat target when its first refresh fails', async () => {
		let createdLoads = 0;
		let finishJob: ((response: Response) => void) | undefined;
		vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
			const path = String(input);
			if (path === '/api/conversations/a') return result('a');
			if (path.endsWith('/chat')) return response({ jobId: 'job-1', conversationId: 'created' });
			if (path === '/api/conversations/created') {
				createdLoads++;
				return createdLoads === 1
					? response({ message: 'Conversation unavailable' }, 500)
					: result('created');
			}
			if (path === '/api/jobs/job-1')
				return new Promise<Response>((resolve) => {
					finishJob = resolve;
				});
			throw new Error(`Unexpected request: ${path}`);
		});
		render(Chat, {
			projectId: 'project-1',
			materialIds: ['source-1'],
			materials: [],
			models,
			conversations,
			jobs: [],
			onChanged: vi.fn()
		});

		selectConversation('a');
		await expect.element(page.getByText('Message A')).toBeInTheDocument();
		await page.getByRole('textbox', { name: 'Your question' }).fill('What happened?');
		await page.getByRole('button', { name: 'Send' }).click();
		await expect.element(page.getByRole('alert')).toHaveTextContent('Conversation unavailable');
		expect(document.querySelector<HTMLSelectElement>('#conversation')?.value).toBe('created');
		await expect.element(page.getByText('Message A')).not.toBeInTheDocument();

		await vi.waitFor(() => expect(finishJob).toBeTypeOf('function'));
		finishJob?.(response({ job: { status: 'succeeded' } }));
		await expect.element(page.getByText('Message CREATED')).toBeInTheDocument();
		expect(createdLoads).toBe(2);
		expect(document.querySelector<HTMLSelectElement>('#conversation')?.value).toBe('created');
	});
});

describe('Projects page', () => {
	function serve(projects: Response | (() => Response)) {
		vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) =>
			String(input) === '/api/pins'
				? response({ pins: [] })
				: typeof projects === 'function'
					? projects()
					: projects
		);
	}

	it('shows the first-project prompt only after a successful empty response', async () => {
		serve(response({ projects: [] }));
		render(Projects);
		await expect.element(page.getByText('Your first project starts here')).toBeInTheDocument();
	});

	it('shows a load error without claiming there are no projects', async () => {
		serve(() => response({ message: 'Projects unavailable' }, 500));
		render(Projects);
		await expect.element(page.getByRole('alert')).toMatchTextContent('Projects unavailable');
		await expect.element(page.getByText('Your first project starts here')).not.toBeInTheDocument();
	});
});

const folders: LibraryFolder[] = [
	{ id: 'uni', parentId: null, name: 'University' },
	{ id: 'docs', parentId: 'uni', name: 'Documents' },
	{ id: 'archive', parentId: 'docs', name: 'Archive' },
	{ id: 'travel', parentId: null, name: 'Travel' }
];

function libraryEntry(overrides: Partial<LibraryEntry>): LibraryEntry {
	return {
		id: 'entry',
		parentId: null,
		kind: 'note',
		name: 'Entry',
		url: '',
		phone: '',
		email: '',
		website: '',
		lecturer: false,
		notes: '',
		text: '',
		filename: null,
		mimeType: null,
		size: 0,
		receivedBytes: 0,
		status: null,
		createdAt: '2026-01-01T00:00:00Z',
		updatedAt: '2026-01-01T00:00:00Z',
		...overrides
	};
}

describe('Library move dialog', () => {
	it('opens at the current location and moves the item to the chosen folder', async () => {
		const onMoved = vi.fn();
		const fetchMock = vi
			.spyOn(globalThis, 'fetch')
			.mockImplementation(async (input) =>
				String(input) === '/api/library/folders' ? response({ folders }) : response({ entry: {} })
			);
		render(MoveDialog, {
			entry: libraryEntry({ id: 'note-1', name: 'Deadline', parentId: 'docs' }),
			onClose: vi.fn(),
			onMoved
		});

		await expect
			.element(page.getByRole('radio', { name: 'Documents', exact: false }))
			.toHaveAttribute('aria-checked', 'true');
		await expect.element(page.getByRole('button', { name: 'Move here' })).toBeDisabled();

		await page.getByRole('radio', { name: 'Travel', exact: false }).click();
		await page.getByRole('button', { name: 'Move to Travel' }).click();
		await vi.waitFor(() => expect(onMoved).toHaveBeenCalledWith('Travel'));
		expect(fetchMock).toHaveBeenCalledWith(
			'/api/library/note-1',
			expect.objectContaining({ method: 'PATCH', body: JSON.stringify({ parentId: 'travel' }) })
		);
	});

	it('never offers a folder its own subtree as a destination', async () => {
		vi.spyOn(globalThis, 'fetch').mockImplementation(async () => response({ folders }));
		render(MoveDialog, {
			entry: libraryEntry({ id: 'docs', kind: 'folder', name: 'Documents', parentId: 'uni' }),
			onClose: vi.fn(),
			onMoved: vi.fn()
		});

		await expect
			.element(page.getByRole('radio', { name: 'University', exact: false }))
			.toBeInTheDocument();
		await expect
			.element(page.getByRole('radio', { name: 'Travel', exact: false }))
			.toBeInTheDocument();
		await expect
			.element(page.getByRole('radio', { name: 'Documents', exact: false }))
			.not.toBeInTheDocument();
		await expect
			.element(page.getByRole('radio', { name: 'Archive', exact: false }))
			.not.toBeInTheDocument();
	});
});

describe('Audio summary form', () => {
	it('offers a separate learner voice for a dialogue and sends both voices', async () => {
		const bodies: unknown[] = [];
		vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
			const path = String(input);
			if (path === '/api/speech')
				return response({
					voices: [
						{ voiceId: 'voice1', name: 'Rachel', description: '' },
						{ voiceId: 'voice2', name: 'Adam', description: '' }
					],
					models: [{ modelId: 'm1', name: 'Flash', costMultiplier: 0.5, maxCharacters: 1000 }]
				});
			if (path.endsWith('/generate')) {
				bodies.push(JSON.parse(String(init?.body)));
				return response({ message: 'Stop here' }, 503);
			}
			return response({});
		});
		render(GenerateForm, {
			projectId: 'project-1',
			kind: 'audio',
			materialIds: ['material-1'],
			models: [
				{
					modelId: 'opus',
					displayLabel: 'Opus',
					description: 'Most capable for complex work'
				}
			],
			onCreated: () => {}
		});
		await expect.element(page.getByLabelText('Narrator voice')).toHaveValue('voice1');
		await page.getByLabelText('Style').selectOptions('dialogue');
		await expect.element(page.getByLabelText('Tutor voice')).toHaveValue('voice1');
		await expect.element(page.getByLabelText('Learner voice')).toHaveValue('voice2');
		await page.getByRole('button', { name: 'Create audio summary' }).click();
		await expect.element(page.getByRole('alert')).toHaveTextContent('Stop here');
		expect(bodies[0]).toMatchObject({
			audioStyle: 'dialogue',
			voiceId: 'voice1',
			learnerVoiceId: 'voice2',
			speechModelId: 'm1'
		});
	});
});

describe('Study player', () => {
	it('uses Space to skip speech or finish an answer, but not while typing', async () => {
		const tutor = {
			phase: 'listening',
			speaking: false,
			segment: 0,
			segments: 4,
			title: 'Water follows salt',
			caption: '',
			partial: 'Water moves',
			verdict: null,
			error: '',
			primary: vi.fn(),
			end: vi.fn()
		};
		render(StudyPlayer, { tutor: tutor as unknown as TutorSession, onResume: () => {} });
		await expect.element(page.getByText('Part 1 of 4 · Water follows salt')).toBeVisible();
		await expect.element(page.getByRole('button', { name: "I'm done" })).toBeEnabled();
		document.body.dispatchEvent(new KeyboardEvent('keydown', { code: 'Space', bubbles: true }));
		expect(tutor.primary).toHaveBeenCalledOnce();
		const input = document.createElement('input');
		document.body.append(input);
		input.dispatchEvent(new KeyboardEvent('keydown', { code: 'Space', bubbles: true }));
		expect(tutor.primary).toHaveBeenCalledOnce();
		input.remove();
		await page.getByRole('button', { name: 'End session' }).click();
		expect(tutor.end).toHaveBeenCalledOnce();
	});
});

describe('Markdown', () => {
	it('formats model text and strips anything that could run or call out', async () => {
		render(Markdown, {
			text: '**Key idea**\n\n<script>window.hacked = true</script><img src="https://example.com/x.png" onerror="window.hacked = true">\n\n[source](https://example.com)'
		});
		await expect.element(page.getByText('Key idea')).toBeInTheDocument();
		expect(document.querySelector('.markdown strong')?.textContent).toBe('Key idea');
		expect(document.querySelector('.markdown script, .markdown img')).toBeNull();
		expect(document.querySelector('.markdown a')?.getAttribute('rel')).toBe('noopener noreferrer');
		expect((window as { hacked?: boolean }).hacked).toBeUndefined();
	});
	it('shows stored figures and formulas but no other image', async () => {
		const asset = '11111111-1111-4111-8111-111111111111';
		render(Markdown, {
			text: `Rentability $r = \\frac{E}{K}$\n\n![Cycle](asset:${asset})\n\n![Job](/api/jobs/${asset})\n\n<img src="/api/jobs/${asset}/cancel">\n\n![Own](image:img01)`
		});
		await expect.poll(() => document.querySelector('.markdown img')).not.toBeNull();
		const images = [...document.querySelectorAll('.markdown img')];
		expect(images.map((image) => image.getAttribute('src'))).toEqual([`/api/assets/${asset}/file`]);
		expect(images[0].getAttribute('alt')).toBe('Cycle');
		expect(document.querySelector('.markdown .katex')).not.toBeNull();
	});
	it('resolves an output’s own images', async () => {
		const outputId = '22222222-2222-4222-8222-222222222222';
		render(Markdown, { text: 'Slide\n\n![Own](image:img01)', outputId });
		await expect.poll(() => document.querySelector('.markdown img')).not.toBeNull();
		expect(document.querySelector('.markdown img')?.getAttribute('src')).toBe(
			`/api/outputs/${outputId}/images/img01`
		);
	});
});

describe('Question card', () => {
	const question = {
		id: 'q1',
		body: 'Which partner meets the company where? Rentability is {{rate}}.\n\n| Market | Partner |\n|---|---|\n| Absatzmarkt | {{sales}} |\n| Arbeitsmarkt | {{work}} |',
		fields: [
			{ id: 'rate', type: 'number' as const, points: 1, correct: 25, tolerance: 0, unit: '%' },
			...(['sales', 'work'] as const).map((id) => ({
				id,
				type: 'select' as const,
				display: 'dropdown' as const,
				points: 1,
				options: [
					{ id: 'k', text: 'Kunden' },
					{ id: 'm', text: 'Mitarbeitende' }
				],
				correct: id === 'sales' ? 'k' : 'm'
			}))
		],
		explanation: 'Customers are met on the sales market.',
		feedback: { correct: '', incorrect: '' },
		citations: []
	};
	const props = {
		question,
		heading: 'Question 1',
		outputId: '22222222-2222-4222-8222-222222222222',
		projectId: 'project-1'
	};
	it('puts an input where each field stands, named by its table row', async () => {
		const onChange = vi.fn();
		render(QuestionCard, { ...props, values: {}, onChange });
		const sales = page.getByLabelText('Absatzmarkt, Partner');
		await expect.element(sales).toBeInTheDocument();
		await expect.element(page.getByLabelText('Arbeitsmarkt, Partner')).toBeInTheDocument();
		expect(document.body.textContent).not.toContain('{{');
		await sales.selectOptions('Kunden');
		await page.getByLabelText('Answer 1').fill('25');
		expect(onChange).toHaveBeenCalledTimes(2);
		await expect.element(sales).toHaveValue('k');
	});
	it('marks each field once the answer is graded', async () => {
		render(QuestionCard, {
			...props,
			values: { rate: '20', sales: 'k', work: 'k' },
			locked: true,
			grade: {
				questionId: 'q1',
				score: 1,
				maxScore: 3,
				state: 'partial',
				fields: [
					{ fieldId: 'rate', state: 'incorrect', score: 0, max: 1, expected: '25 %' },
					{ fieldId: 'sales', state: 'correct', score: 1, max: 1, expected: 'Kunden' },
					{ fieldId: 'work', state: 'incorrect', score: 0, max: 1, expected: 'Mitarbeitende' }
				]
			}
		});
		await expect.element(page.getByText('1 / 3 points')).toBeInTheDocument();
		const expected = [...document.querySelectorAll('[data-expected]')].map((node) =>
			node.textContent?.replace(/\s+/g, ' ').trim()
		);
		expect(expected).toEqual(['Expected:25 %', 'Expected:Mitarbeitende']);
		await expect.element(page.getByLabelText('Absatzmarkt, Partner')).toBeDisabled();
		expect(document.querySelectorAll('[aria-label="Not correct"]')).toHaveLength(2);
	});
});

describe('Library browser', () => {
	it('moves an item when its row is dropped on a folder row', async () => {
		const children = [
			libraryEntry({ id: 'travel', kind: 'folder', name: 'Travel' }),
			libraryEntry({ id: 'note-1', name: 'Deadline' })
		];
		const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
			const path = String(input);
			if (path === '/api/pins') return response({ pins: [] });
			if (path === '/api/library') return response({ entry: null, children, ancestors: [] });
			return response({ entry: {} });
		});
		render(LibraryBrowser, { entryId: null });
		await expect.element(page.getByText('Deadline')).toBeInTheDocument();

		const row = (name: string) => page.getByText(name).element().closest('li')!;
		const drag = (type: string, target: Element) =>
			target.dispatchEvent(
				new DragEvent(type, { bubbles: true, cancelable: true, dataTransfer: new DataTransfer() })
			);
		drag('dragstart', row('Deadline'));
		drag('dragover', row('Travel'));
		drag('drop', row('Travel'));

		await vi.waitFor(() =>
			expect(fetchMock).toHaveBeenCalledWith(
				'/api/library/note-1',
				expect.objectContaining({ method: 'PATCH', body: JSON.stringify({ parentId: 'travel' }) })
			)
		);
	});
});

describe('Tasks and calendar', () => {
	const today = localDate(new Date());
	const task = (extra: Partial<Task> = {}): Task => ({
		id: 'task-1',
		projectId: null,
		projectName: null,
		title: 'Hand in essay',
		notes: '',
		dueDate: today,
		dueTime: null,
		completedAt: null,
		source: 'custom',
		createdAt: '2026-09-01T00:00:00.000Z',
		updatedAt: '2026-09-01T00:00:00.000Z',
		...extra
	});

	it('flags a task due today and completes it from the list', async () => {
		const fetchMock = vi
			.spyOn(globalThis, 'fetch')
			.mockImplementation(async () =>
				response({ task: task({ completedAt: '2026-10-01T10:00:00.000Z' }) })
			);
		render(TaskListFixture, { tasks: [task()] });
		await expect.element(page.getByText('Today', { exact: true })).toBeVisible();
		await page.getByRole('checkbox', { name: 'Mark Hand in essay as done' }).click();
		// Components of earlier tests may still be loading their own data.
		const patches = () =>
			fetchMock.mock.calls.filter(([path]) => String(path) === '/api/tasks/task-1');
		await vi.waitFor(() => expect(patches()).toHaveLength(1));
		const [, init] = patches()[0];
		expect(init).toMatchObject({ method: 'PATCH', body: JSON.stringify({ done: true }) });
		await expect.element(page.getByText('Hand in essay')).not.toBeInTheDocument();
	});

	it('shows events and deadlines on their day in the month', async () => {
		const occurrence: Occurrence = {
			key: 'event-1:' + today,
			eventId: 'event-1',
			occurrenceDate: today,
			title: 'Lecture',
			location: '',
			notes: '',
			startDate: today,
			startTime: '09:00',
			endDate: today,
			endTime: '10:00',
			repeating: true,
			modified: false,
			source: 'custom',
			projectId: null,
			projectName: null
		};
		const onEvent = vi.fn();
		const onTask = vi.fn();
		render(MonthView, {
			props: {
				weeks: monthGrid(today, 'en-US'),
				anchor: today,
				occurrences: [occurrence],
				tasks: [task(), task({ id: 'task-2', title: 'Later task', dueDate: addDays(today, 40) })],
				now: new Date(),
				onOpenDay: vi.fn(),
				onEvent,
				onTask
			}
		});
		await page.getByRole('button', { name: 'Event: Lecture, 09:00 – 10:00' }).click();
		expect(onEvent).toHaveBeenCalledWith(occurrence);
		await page.getByRole('button', { name: 'Task: Hand in essay, Today' }).click();
		expect(onTask).toHaveBeenCalledOnce();
		await expect.element(page.getByText('Later task')).not.toBeInTheDocument();
	});
});

describe('Resumable source processing', () => {
	const job: Job = {
		id: 'review-1',
		projectId: 'project-1',
		materialId: 'source-1',
		kind: 'ingest',
		status: 'paused',
		review: { saved: 64, total: 200, unit: 'pages' },
		resetsAt: null,
		progress: '',
		error: null,
		outputId: null,
		conversationId: null,
		attemptId: null,
		lessonAnswerId: null,
		createdAt: '2026-11-22T08:00:00Z',
		updatedAt: '2026-11-22T09:00:00Z'
	};
	function renderPaused() {
		const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => response({}));
		const onChanged = vi.fn();
		render(JobActivity, {
			jobs: [job],
			materials: [{ id: 'source-1', name: 'Lecture notes.pdf' }],
			onChanged
		});
		return { fetchMock, onChanged };
	}

	it('shows the saved pages and resumes the existing job on request', async () => {
		const { fetchMock, onChanged } = renderPaused();
		await expect.element(page.getByText('Lecture notes.pdf')).toBeVisible();
		await expect.element(page.getByText('64 of 200 pages saved')).toBeVisible();
		await expect
			.element(page.getByText('Claude usage limit reached.', { exact: false }))
			.toBeVisible();
		expect(fetchMock).not.toHaveBeenCalled();
		await page.getByRole('button', { name: 'Resume processing' }).click();
		await vi.waitFor(() => expect(onChanged).toHaveBeenCalledOnce());
		expect(fetchMock).toHaveBeenCalledWith(
			'/api/jobs/review-1/retry',
			expect.objectContaining({ method: 'POST' })
		);
	});

	it('discards a checkpoint only after confirmation', async () => {
		const { fetchMock, onChanged } = renderPaused();
		await page.getByRole('button', { name: 'Discard progress' }).click();
		const dialog = page.getByRole('alertdialog');
		await expect.element(dialog).toBeVisible();
		expect(fetchMock).not.toHaveBeenCalled();
		await dialog.getByRole('button', { name: 'Discard progress' }).click();
		await vi.waitFor(() => expect(onChanged).toHaveBeenCalledOnce());
		expect(fetchMock).toHaveBeenCalledWith(
			'/api/jobs/review-1',
			expect.objectContaining({ method: 'DELETE' })
		);
	});
});

describe('Interrupted study tool creation', () => {
	it('labels the saved job Resume creation and retries its existing ID', async () => {
		const lesson: Job = {
			id: 'lesson-1',
			projectId: 'project-1',
			materialId: null,
			kind: 'lesson',
			status: 'failed',
			canResumeCreation: true,
			progress: '',
			error: 'Interrupted',
			outputId: null,
			conversationId: null,
			attemptId: null,
			lessonAnswerId: null,
			createdAt: '2026-11-22T08:00:00Z',
			updatedAt: '2026-11-22T09:00:00Z'
		};
		const quiz: Job = { ...lesson, id: 'quiz-2', kind: 'quiz', canResumeCreation: false };
		const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => response({}));
		const onChanged = vi.fn();
		render(JobActivity, { jobs: [lesson, quiz], materials: [], onChanged });
		await page.getByText('Interrupted jobs (2)').click();
		await expect
			.element(
				page
					.getByRole('listitem')
					.filter({ hasText: 'Quiz' })
					.getByRole('button', { name: 'Retry' })
			)
			.toBeVisible();
		await page
			.getByRole('listitem')
			.filter({ hasText: 'Lesson' })
			.getByRole('button', { name: 'Resume creation' })
			.click();
		await vi.waitFor(() => expect(onChanged).toHaveBeenCalledOnce());
		expect(fetchMock).toHaveBeenCalledWith(
			'/api/jobs/lesson-1/retry',
			expect.objectContaining({ method: 'POST' })
		);
	});
});
