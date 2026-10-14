import { isActiveJob, type Job } from './domain';
import { api } from './ui';

const JOB_POLL_MS = 1500;
const JOB_REQUEST_TIMEOUT_MS = 30_000;

/**
 * Polls a job until it leaves the queue and resolves with its final state.
 * Resolves with nothing when `signal` aborts first, so unmounted components stay untouched.
 * Polls never count as user activity.
 */
export async function waitForJob(
	jobId: string,
	signal: AbortSignal,
	onProgress?: (job: Job) => void
): Promise<Job | undefined> {
	while (!signal.aborted) {
		const result = await api<{ job: Job }>(`/api/jobs/${encodeURIComponent(jobId)}`, {
			signal: AbortSignal.any([signal, AbortSignal.timeout(JOB_REQUEST_TIMEOUT_MS)])
		}).catch((cause) => {
			if (!signal.aborted) throw cause;
		});
		if (!result || signal.aborted) return;
		const { job } = result;
		if (!isActiveJob(job)) return job;
		onProgress?.(job);
		await new Promise<void>((resolve) => {
			const timer = setTimeout(resolve, JOB_POLL_MS);
			signal.addEventListener(
				'abort',
				() => {
					clearTimeout(timer);
					resolve();
				},
				{ once: true }
			);
		});
	}
}

/**
 * Re-runs `task` every `delay` ms for as long as it resolves true.
 * The flag tells the task whether the user asked for this run or the timer did.
 */
export function createPoller(task: (interaction: boolean) => Promise<boolean>, delay = 3000) {
	let timer: ReturnType<typeof setTimeout> | undefined;
	let stopped = false;
	async function run(interaction = false) {
		clearTimeout(timer);
		const again = await task(interaction);
		clearTimeout(timer);
		if (again && !stopped) timer = setTimeout(run, delay);
	}
	return {
		run,
		stop() {
			stopped = true;
			clearTimeout(timer);
		}
	};
}
