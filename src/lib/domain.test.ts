import { expect, it } from 'vitest';
import { interruptedJobs, type Job } from './domain';

let clock = 0;
const job = (fields: Partial<Job>): Job => ({
	id: `job-${++clock}`,
	projectId: 'p',
	materialId: null,
	kind: 'ingest',
	status: 'failed',
	progress: '',
	error: 'Failed',
	outputId: null,
	conversationId: null,
	attemptId: null,
	lessonAnswerId: null,
	createdAt: new Date(Date.UTC(2026, 10, 22, 10, clock)).toISOString(),
	updatedAt: '',
	...fields
});

it('lists interrupted jobs newest first, without those a later job replaced', () => {
	const replacedIngest = job({ materialId: 'm1' });
	const session = job({ kind: 'session', status: 'cancelled' });
	const failedChat = job({ kind: 'chat', conversationId: 'c1' });
	const reprocess = job({ materialId: 'm1', status: 'succeeded', error: null });
	const failedVoice = job({ kind: 'voice', outputId: 'lesson1' });
	const running = job({ kind: 'quiz', status: 'running', error: null });
	expect(
		interruptedJobs([replacedIngest, session, failedChat, reprocess, failedVoice, running])
	).toEqual([failedVoice, failedChat, session]);
});
