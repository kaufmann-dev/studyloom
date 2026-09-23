import { afterEach, describe, expect, it, vi } from 'vitest';
import { page } from 'vitest/browser';
import { render } from 'vitest-browser-svelte';
import Upload from './Upload.svelte';
import type { Conversation, Message, MuseModel } from '$lib/domain';
import Chat from './Chat.svelte';
import Projects from '../../../routes/+page.svelte';

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

const conversations: Conversation[] = ['a', 'b', 'c', 'created'].map((id) => ({
	id,
	projectId: 'project-1',
	title: `Conversation ${id.toUpperCase()}`,
	materialIds: ['source-1'],
	modelId: 'model-1',
	createdAt: '2026-01-01T00:00:00Z',
	updatedAt: '2026-01-01T00:00:00Z'
}));
const models: MuseModel[] = [
	{ modelId: 'model-1', displayLabel: 'Model 1', contextLimit: null, description: null }
];

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
	it('shows the first-project prompt only after a successful empty response', async () => {
		vi.spyOn(globalThis, 'fetch').mockResolvedValue(
			new Response(JSON.stringify({ projects: [] }), { status: 200 })
		);
		render(Projects);
		await expect.element(page.getByText('Your first project starts here')).toBeInTheDocument();
	});

	it('shows a load error without claiming there are no projects', async () => {
		vi.spyOn(globalThis, 'fetch').mockResolvedValue(
			new Response(JSON.stringify({ message: 'Projects unavailable' }), { status: 500 })
		);
		render(Projects);
		await expect.element(page.getByRole('alert')).toHaveTextContent('Projects unavailable');
		await expect.element(page.getByText('Your first project starts here')).not.toBeInTheDocument();
	});
});
