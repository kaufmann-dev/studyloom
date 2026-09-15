import { describe, expect, it, vi, beforeEach } from 'vitest';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { museRun } from './muse';
import { missingArtifactError, runMuseWithArtifact } from './jobs';

vi.mock('./muse', async (importOriginal) => ({
	...(await importOriginal<typeof import('./muse')>()),
	museRun: vi.fn()
}));

vi.mock('./sandbox', () => ({
	ensureSandboxAvailable: vi.fn().mockResolvedValue(undefined)
}));

const museRunMock = vi.mocked(museRun);

beforeEach(() => {
	museRunMock.mockReset();
});

describe('missing artifact diagnostics', () => {
	it('keeps the artifact error actionable when there is no model output', () => {
		expect(missingArtifactError('extracted.json', { text: '', stderr: '' }).message).toBe(
			'Muse completed without writing extracted.json. Retry this job.'
		);
	});
	it('attaches the model output and stderr tail to the artifact error', () => {
		expect(
			missingArtifactError('extracted.json', {
				text: 'The tool failed.',
				stderr: 'mcp: connection lost'
			}).message
		).toBe(
			'Muse completed without writing extracted.json. Last output: The tool failed. | mcp: connection lost Retry this job.'
		);
	});
	it('reports the second attempt output when both runs miss the artifact', async () => {
		const workspace = await mkdtemp(join(tmpdir(), 'studyloom-artifact-'));
		try {
			await mkdir(join(workspace, 'files'), { recursive: true });
			museRunMock
				.mockResolvedValueOnce({ text: 'first try said nothing useful', stderr: '' })
				.mockResolvedValueOnce({ text: 'run_command keeps failing: denied', stderr: '' });
			await expect(
				runMuseWithArtifact(
					workspace,
					'model',
					'prompt',
					'result.json',
					AbortSignal.timeout(5000),
					() => {}
				)
			).rejects.toThrow(/run_command keeps failing: denied/);
			expect(museRunMock).toHaveBeenCalledTimes(2);
			expect(String(museRunMock.mock.calls[1]?.[2])).toContain('first try said nothing useful');
		} finally {
			await rm(workspace, { recursive: true, force: true });
		}
	});
	it('returns without a second run when the first run saves the artifact', async () => {
		const workspace = await mkdtemp(join(tmpdir(), 'studyloom-artifact-'));
		try {
			await mkdir(join(workspace, 'files'), { recursive: true });
			await writeFile(join(workspace, 'files', 'result.json'), '{}');
			museRunMock.mockResolvedValue({ text: 'done', stderr: '' });
			await runMuseWithArtifact(
				workspace,
				'model',
				'prompt',
				'result.json',
				AbortSignal.timeout(5000),
				() => {}
			);
			expect(museRunMock).toHaveBeenCalledTimes(1);
		} finally {
			await rm(workspace, { recursive: true, force: true });
		}
	});
});
