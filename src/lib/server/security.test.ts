import { describe, expect, it } from 'vitest';
import { safeReturnTo, sessionAlive, hashToken } from './auth';
import { museEnvironment } from './muse';
import { scopedFile, wavHeader } from './storage';
import { validateWav } from './transcribe';
import { validateCitations, gradeChoice, readArtifact } from './jobs';
import { safeError } from './config';
import { answersSchema, chatInput, ingestionSchema, projectInput, quizSchema } from '../domain';
import { sandboxArgs } from './sandbox';
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
	it('passes only an explicit environment allowlist to subscription processes', () => {
		const env = museEnvironment('/private/config');
		for (const secret of [
			'META_API_KEY',
			'TRANSCRIPTION_API_KEY',
			'OIDC_CLIENT_SECRET',
			'DATABASE_URL',
			'HOME'
		])
			expect(env).not.toHaveProperty(secret);
		expect(env.XDG_CONFIG_HOME).toBe('/private/config');
	});
});
describe('source and tool boundaries', () => {
	it('preserves user whitespace while rejecting blank project names and messages', () => {
		expect(projectInput.parse({ name: '  Course  ', description: '  Notes  ' })).toMatchObject({
			name: '  Course  ',
			description: '  Notes  '
		});
		expect(chatInput.parse({ message: 'hello ', materialIds: [id] }).message).toBe('hello ');
		expect(() => projectInput.parse({ name: '   ', description: '' })).toThrow();
		expect(() => chatInput.parse({ message: '\t\n', materialIds: [id] })).toThrow();
		expect(() => answersSchema.parse({ answers: [{ questionId: 'q1', value: '' }] })).toThrow();
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
	it('reports missing and malformed Muse artifacts without exposing filesystem errors', async () => {
		const root = await mkdtemp(join(tmpdir(), 'studyloom-artifact-'));
		try {
			await mkdir(join(root, 'files'));
			await expect(readArtifact(root, 'extracted.json')).rejects.toThrow(
				'Muse completed without writing extracted.json'
			);
			await writeFile(join(root, 'files', 'result.json'), '{');
			await expect(readArtifact(root, 'result.json')).rejects.toThrow(
				'Muse wrote invalid JSON in result.json'
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
	it('isolates namespaces and mounts only the job workspace writable', async () => {
		const args = await sandboxArgs('/private/job/files', 'echo test');
		expect(args).toContain('--unshare-all');
		expect(args).toContain('--clearenv');
		expect(args).not.toContain('--share-net');
		expect(args.filter((v) => v === '--bind')).toHaveLength(1);
		expect(args.slice(args.indexOf('--bind') + 1, args.indexOf('--bind') + 3)).toEqual([
			'/private/job/files',
			'/work'
		]);
		expect(args).not.toContain('/data');
		expect(args).not.toContain('/code');
	});
	it('accepts valid PCM WAV and rejects invalid format, rate and length', () => {
		const valid = Buffer.concat([wavHeader(48000), Buffer.alloc(48000)]);
		expect(() => validateWav(valid)).not.toThrow();
		const stereo = Buffer.from(valid);
		stereo.writeUInt16LE(2, 22);
		expect(() => validateWav(stereo)).toThrow('mono');
		const rate = Buffer.from(valid);
		rate.writeUInt32LE(44100, 24);
		expect(() => validateWav(rate)).toThrow('24 kHz');
		expect(() => validateWav(valid.subarray(0, 100))).toThrow('Truncated');
		expect(() => wavHeader(3)).toThrow('Invalid PCM');
	});
	it('requires citations and quotes to resolve against selected source snapshots', () => {
		const snapshot = [
			{ id, name: 'Course', chunks: [{ locator: 'page:1', text: 'Evidence supports A.' }] }
		];
		expect(() => validateCitations([citation], snapshot)).not.toThrow();
		expect(() => validateCitations([{ ...citation, locator: 'page:2' }], snapshot)).toThrow(
			'citation'
		);
		expect(() => validateCitations([{ ...citation, quote: 'Invented' }], snapshot)).toThrow(
			'citation'
		);
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
