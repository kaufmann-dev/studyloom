import { describe, expect, it } from 'vitest';
import { safeReturnTo, sessionAlive, hashToken } from './auth';
import { claudeEnvironment } from './claude';
import { scopedFile, wavHeader } from './storage';
import { findInvalidCitation, validateCitations, gradeChoice, readArtifact } from './jobs';
import { safeError } from './config';
import {
	answersSchema,
	chatInput,
	ingestionSchema,
	libraryInput,
	libraryPatchInput,
	projectInput,
	quizSchema
} from '../domain';
import { mkdtemp, writeFile, symlink, rm, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const id = '9c9aaee7-3c97-4ca8-8daa-da26beeeaa32';
const citation = { materialId: id, locator: 'page:1', quote: 'Evidence' };
const question = {
	id: 'q1',
	type: 'multiple_choice' as const,
	question: 'Which?',
	options: ['A', 'B'],
	correctAnswer: 'A',
	rubric: 'Correct choice',
	explanation: 'Evidence supports A.',
	citations: [citation]
};
describe('authentication boundaries', () => {
	it('preserves local destinations and rejects open redirects and auth loops', () => {
		expect(safeReturnTo('/projects/test?material=one')).toBe('/projects/test?material=one');
		for (const path of [
			'https://evil.test',
			'//evil.test',
			'/\\evil.test',
			'/auth/start',
			'/login',
			'/\nevil.test'
		])
			expect(safeReturnTo(path)).toBe('/');
	});
	it('expires at both idle and absolute boundaries', () => {
		const now = Date.now();
		expect(
			sessionAlive({ lastActiveAt: new Date(now - 86399999), expiresAt: new Date(now + 1) }, now)
		).toBe(true);
		expect(
			sessionAlive(
				{ lastActiveAt: new Date(now - 86400000), expiresAt: new Date(now + 999999) },
				now
			)
		).toBe(false);
		expect(sessionAlive({ lastActiveAt: new Date(now), expiresAt: new Date(now) }, now)).toBe(
			false
		);
		expect(hashToken('opaque session')).not.toContain('opaque');
	});
	it('gives Claude Code its login token but no other app secret', () => {
		const saved = { ...process.env };
		try {
			Object.assign(process.env, {
				CLAUDE_CODE_OAUTH_TOKEN: 'sk-ant-oat01-token',
				ELEVENLABS_API_KEY: 'eleven',
				OIDC_CLIENT_SECRET: 'oidc',
				DATABASE_URL: 'postgres://secret',
				ANTHROPIC_API_KEY: 'api-key',
				DATA_DIR: '/private/data'
			});
			const env = claudeEnvironment();
			expect(Object.keys(env).sort()).toEqual(
				[
					'CLAUDE_AGENT_SDK_CLIENT_APP',
					'CLAUDE_CODE_OAUTH_TOKEN',
					'CLAUDE_CONFIG_DIR',
					'HOME',
					'LANG',
					'PATH',
					...(process.env.SSL_CERT_DIR ? ['SSL_CERT_DIR'] : []),
					...(process.env.SSL_CERT_FILE ? ['SSL_CERT_FILE'] : [])
				].sort()
			);
			expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBe('sk-ant-oat01-token');
			expect(env.CLAUDE_CONFIG_DIR).toBe('/private/data/claude/config');
			expect(safeError(new Error('token sk-ant-oat01-token leaked'))).not.toContain('oat01');
		} finally {
			process.env = saved;
		}
	});
});
describe('source and tool boundaries', () => {
	it('preserves user whitespace while rejecting blank project names and messages', () => {
		expect(projectInput.parse({ name: '  Course  ', description: '  Notes  ' })).toMatchObject({
			name: '  Course  ',
			description: '  Notes  '
		});
		expect(chatInput.parse({ message: 'hello ', materialIds: [id] }).message).toBe('hello ');
		expect(
			libraryInput.parse({ kind: 'link', name: 'My Link ', url: 'https://example.edu' }).name
		).toBe('My Link ');
		expect(libraryPatchInput.parse({ name: 'hello ' }).name).toBe('hello ');
		expect(libraryPatchInput.parse({ parentId: id })).toEqual({ parentId: id });
		expect(() => projectInput.parse({ name: '   ', description: '' })).toThrow();
		expect(projectInput.parse({ name: 'Course' })).toMatchObject({ lecturerIds: [] });
		expect(() => projectInput.parse({ name: 'Course', lecturerIds: [id, id] })).toThrow(
			'Each lecturer can be listed once.'
		);
		expect(() => projectInput.parse({ name: 'Course', lecturerIds: ['not-an-id'] })).toThrow();
		expect(() => chatInput.parse({ message: '\t\n', materialIds: [id] })).toThrow();
		expect(() => answersSchema.parse({ answers: [{ questionId: 'q1', value: '' }] })).toThrow();
		expect(() =>
			libraryInput.parse({ kind: 'link', name: '   ', url: 'https://example.edu' })
		).toThrow('Name is required.');
		expect(() => libraryPatchInput.parse({ name: '\t\n' })).toThrow('Name is required.');
	});
	it('rejects empty extracted chunks and contradictory ingestion statuses', () => {
		expect(() =>
			ingestionSchema.parse({ status: 'ready', notes: '', chunks: [], assets: [] })
		).toThrow('Readable content');
		expect(() =>
			ingestionSchema.parse({
				status: 'partial',
				notes: '',
				chunks: [{ locator: '   ', text: 'content' }],
				assets: []
			})
		).toThrow('locator');
		expect(() =>
			ingestionSchema.parse({
				status: 'unreadable',
				notes: '',
				chunks: [{ locator: 'page:1', text: 'content' }],
				assets: []
			})
		).toThrow('Unreadable');
	});
	it('reports missing and malformed Claude artifacts without exposing filesystem errors', async () => {
		const root = await mkdtemp(join(tmpdir(), 'studyloom-artifact-'));
		try {
			await mkdir(join(root, 'files'));
			await expect(readArtifact(root, 'extracted.json')).rejects.toThrow(
				'Claude completed without writing extracted.json'
			);
			await writeFile(join(root, 'files', 'result.json'), '{');
			await expect(readArtifact(root, 'result.json')).rejects.toThrow(
				'Claude wrote invalid JSON in result.json'
			);
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});
	it('redacts filesystem paths from operational errors', () => {
		const error = Object.assign(
			new Error("ENOENT: no such file or directory, stat '/data/jobs/id/files/result.json'"),
			{
				code: 'ENOENT',
				path: '/data/jobs/id/files/result.json'
			}
		);
		expect(safeError(error)).toBe('File operation failed (ENOENT).');
	});
	it('rejects traversal and symlinks outside a job workspace', async () => {
		const root = await mkdtemp(join(tmpdir(), 'studyloom-test-'));
		try {
			await mkdir(join(root, 'work'));
			await writeFile(join(root, 'outside'), 'secret');
			await writeFile(join(root, 'work', 'inside'), 'source');
			await symlink(join(root, 'outside'), join(root, 'work', 'escape'));
			expect(await scopedFile(join(root, 'work'), 'inside')).toBe(join(root, 'work', 'inside'));
			await expect(scopedFile(join(root, 'work'), '../outside')).rejects.toThrow('inside');
			await expect(scopedFile(join(root, 'work'), 'escape')).rejects.toThrow('inside');
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});
	it('writes WAV headers only for whole 16-bit samples', () => {
		expect(wavHeader(48000).toString('ascii', 0, 4)).toBe('RIFF');
		expect(() => wavHeader(3)).toThrow('Invalid PCM');
	});
	it('requires citations and quotes to resolve against selected source snapshots', () => {
		const snapshot = [
			{
				id,
				name: 'Course',
				chunks: [{ locator: 'page:1', text: 'Evidence supports A.', kind: 'text' as const }],
				figures: []
			}
		];
		expect(() => validateCitations([citation], snapshot)).not.toThrow();
		expect(() => validateCitations([{ ...citation, locator: 'page:2' }], snapshot)).toThrow(
			'citation'
		);
		expect(() => validateCitations([{ ...citation, quote: 'Invented' }], snapshot)).toThrow(
			'citation'
		);
		// A quote may wrap differently than the chunk it was copied from.
		expect(() =>
			validateCitations([{ ...citation, quote: 'Evidence\n  supports A.' }], snapshot)
		).not.toThrow();
		const unknown = { ...citation, locator: 'page:9' };
		expect(findInvalidCitation([citation, unknown], snapshot)).toEqual(unknown);
		expect(findInvalidCitation([citation], snapshot)).toBeUndefined();
	});
	it('rejects ambiguous quiz options and scores choices on the server', () => {
		const quiz = quizSchema.parse({ title: 'Quiz', questions: [question] });
		expect(gradeChoice(quiz, [{ questionId: 'q1', value: 'A' }])[0].score).toBe(1);
		expect(gradeChoice(quiz, [{ questionId: 'q1', value: 'B' }])[0].score).toBe(0);
		expect(() =>
			quizSchema.parse({ title: 'Quiz', questions: [{ ...question, options: ['A', 'A'] }] })
		).toThrow();
	});
});
