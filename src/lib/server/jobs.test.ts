import { describe, expect, it, vi, beforeEach } from 'vitest';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { claudeRun } from './claude';
import { missingArtifactError, runClaudeWithArtifact } from './jobs';

vi.mock('./claude', async (importOriginal) => ({
	...(await importOriginal<typeof import('./claude')>()),
	claudeRun: vi.fn()
}));

const claudeRunMock = vi.mocked(claudeRun);

beforeEach(() => {
	claudeRunMock.mockReset();
});

describe('missing artifact diagnostics', () => {
	it('keeps the artifact error actionable when there is no model output', () => {
		expect(missingArtifactError('extracted.json', { text: '', stderr: '' }).message).toBe(
			'Claude completed without writing extracted.json. Retry this job.'
		);
	});
	it('attaches the model output and stderr tail to the artifact error', () => {
		expect(
			missingArtifactError('extracted.json', {
				text: 'The tool failed.',
				stderr: 'mcp: connection lost'
			}).message
		).toBe(
			'Claude completed without writing extracted.json. Last output: The tool failed. | mcp: connection lost Retry this job.'
		);
	});
	it('reports the second attempt output when both runs miss the artifact', async () => {
		const workspace = await mkdtemp(join(tmpdir(), 'studyloom-artifact-'));
		try {
			await mkdir(join(workspace, 'files'), { recursive: true });
			claudeRunMock
				.mockResolvedValueOnce({ text: 'first try said nothing useful', stderr: '' })
				.mockResolvedValueOnce({ text: 'run_command keeps failing: denied', stderr: '' });
			await expect(
				runClaudeWithArtifact(
					workspace,
					'model',
					'prompt',
					'result.json',
					AbortSignal.timeout(5000),
					() => {}
				)
			).rejects.toThrow(/run_command keeps failing: denied/);
			expect(claudeRunMock).toHaveBeenCalledTimes(2);
			expect(claudeRunMock.mock.calls[1]?.[0].prompt).toContain('first try said nothing useful');
		} finally {
			await rm(workspace, { recursive: true, force: true });
		}
	});
	it('returns without a second run when the first run saves the artifact', async () => {
		const workspace = await mkdtemp(join(tmpdir(), 'studyloom-artifact-'));
		try {
			await mkdir(join(workspace, 'files'), { recursive: true });
			await writeFile(join(workspace, 'files', 'result.json'), '{}');
			claudeRunMock.mockResolvedValue({ text: 'done', stderr: '' });
			await runClaudeWithArtifact(
				workspace,
				'model',
				'prompt',
				'result.json',
				AbortSignal.timeout(5000),
				() => {}
			);
			expect(claudeRunMock).toHaveBeenCalledTimes(1);
		} finally {
			await rm(workspace, { recursive: true, force: true });
		}
	});
});
