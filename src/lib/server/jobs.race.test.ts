import { describe, expect, it } from 'vitest';
import { and, eq, sql } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { db, closeDatabase } from './db';
import { jobs, outputs, projects } from './db/schema';
import { completeJob } from './jobs';
import { useTestDatabase } from './testing';

describe.skipIf(!process.env.TEST_DATABASE_URL)('job completion and cancellation', () => {
	it('publishes a result only when completion wins the job lock', async () => {
		const environment = await useTestDatabase('race');
		const [project] = await db().insert(projects).values({ name: 'Job race test' }).returning();
		const owner = randomUUID();
		const makeJob = async () => {
			const [job] = await db()
				.insert(jobs)
				.values({
					projectId: project.id,
					kind: 'summary',
					queue: 'background',
					status: 'running',
					leaseOwner: owner
				})
				.returning();
			return job;
		};
		const cancel = (id: string) =>
			db()
				.update(jobs)
				.set({ status: 'cancelled', leaseOwner: null })
				.where(and(eq(jobs.id, id), eq(jobs.status, 'running')))
				.returning({ id: jobs.id });
		const publish = (job: Awaited<ReturnType<typeof makeJob>>) =>
			completeJob(
				job,
				async (tx) => {
					await tx.insert(outputs).values({
						id: job.id,
						projectId: project.id,
						kind: 'summary',
						title: 'Result',
						content: 'Completed',
						materialIds: [],
						sourceSnapshot: [],
						modelId: 'test'
					});
				},
				job.id
			);
		try {
			const cancelledFirst = await makeJob();
			expect(await cancel(cancelledFirst.id)).toHaveLength(1);
			await expect(publish(cancelledFirst)).rejects.toThrow('cancelled or superseded');
			expect(
				await db().select().from(outputs).where(eq(outputs.id, cancelledFirst.id))
			).toHaveLength(0);

			const completedFirst = await makeJob();
			let entered!: () => void;
			let release!: () => void;
			const inside = new Promise<void>((resolve) => (entered = resolve));
			const gate = new Promise<void>((resolve) => (release = resolve));
			const completion = completeJob(
				completedFirst,
				async (tx) => {
					entered();
					await gate;
					await tx.insert(outputs).values({
						id: completedFirst.id,
						projectId: project.id,
						kind: 'summary',
						title: 'Result',
						content: 'Completed',
						materialIds: [],
						sourceSnapshot: [],
						modelId: 'test'
					});
				},
				completedFirst.id
			);
			await inside;
			try {
				await expect(
					db().transaction(async (tx) => {
						await tx.execute(sql`set local lock_timeout = '100ms'`);
						await tx
							.update(jobs)
							.set({ status: 'cancelled', leaseOwner: null })
							.where(and(eq(jobs.id, completedFirst.id), eq(jobs.status, 'running')));
					})
				).rejects.toMatchObject({ cause: { code: '55P03' } });
			} finally {
				release();
			}
			await completion;
			expect(await cancel(completedFirst.id)).toHaveLength(0);
			const [saved] = await db().select().from(jobs).where(eq(jobs.id, completedFirst.id));
			expect(saved.status).toBe('succeeded');
			expect(
				await db().select().from(outputs).where(eq(outputs.id, completedFirst.id))
			).toHaveLength(1);
		} finally {
			await db().delete(projects).where(eq(projects.id, project.id));
			await closeDatabase();
			await environment.restore();
		}
	});
});
