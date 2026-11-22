<script lang="ts">
	import { Pause } from '@lucide/svelte';
	import ConfirmDialog from './ConfirmDialog.svelte';
	import { canResumeReview, pauseNotice, savedProgress } from '#lib/sources.js';
	import { toast } from 'svelte-sonner';
	import {
		interruptedJobs,
		isActiveJob,
		type Job,
		type JobKind,
		type Material
	} from '#lib/domain.js';
	import Button from '#lib/components/ui/button/button.svelte';
	import { Spinner } from '#lib/components/ui/spinner/index.js';
	import { api, errorText } from '#lib/ui.js';

	/** The project's running jobs, with saved review progress and actions for interrupted jobs. */
	let {
		jobs,
		materials,
		onChanged,
		class: className = ''
	}: {
		jobs: Job[];
		materials: Pick<Material, 'id' | 'name'>[];
		onChanged: () => void | Promise<void>;
		class?: string;
	} = $props();

	const KIND_LABELS: Record<JobKind, string> = {
		ingest: 'Processing source',
		recover: 'Saving recording',
		chat: 'Chat answer',
		summary: 'Summary',
		quiz: 'Quiz',
		audio: 'Audio summary',
		session: 'Study session',
		lesson: 'Lesson',
		voice: 'Lesson voice',
		grade: 'Grading'
	};
	const nameOf = (job: Job) => materials.find((material) => material.id === job.materialId)?.name;
	let discarding = $state.raw<Job | null>(null);
	let busy = $state('');
	let active = $derived(jobs.filter(isActiveJob));
	let stopped = $derived(interruptedJobs(jobs));
	let resumable = $derived(stopped.filter(canResumeReview));
	let interrupted = $derived(stopped.filter((job) => !canResumeReview(job)).slice(0, 10));

	async function discardProgress() {
		if (!discarding) return;
		await api(`/api/jobs/${discarding.id}`, { method: 'DELETE' });
		await onChanged();
	}

	async function act(job: Job, action: 'cancel' | 'retry' | 'dismiss') {
		busy = job.id;
		try {
			if (action === 'dismiss') await api(`/api/jobs/${job.id}`, { method: 'DELETE' });
			else await api(`/api/jobs/${job.id}/${action}`, { body: {} });
			await onChanged();
		} catch (cause) {
			toast.error(errorText(cause));
		} finally {
			busy = '';
		}
	}
</script>

{#if active.length || resumable.length || interrupted.length}
	<div class={['space-y-3', className]}>
		{#if active.length}
			<section aria-labelledby="active-jobs-heading">
				<h2 id="active-jobs-heading" class="mb-2 text-sm font-semibold">
					In progress <span class="font-normal text-muted-foreground">({active.length})</span>
				</h2>
				<ul class="max-h-56 divide-y overflow-y-auto border">
					{#each active as job (job.id)}
						<li class="flex items-center gap-3 px-3 py-2">
							<Spinner class="size-3 shrink-0" role="presentation" />
							<div class="min-w-0 flex-1 text-xs">
								<p class="font-medium">
									{KIND_LABELS[job.kind]}{job.kind === 'ingest' && nameOf(job)
										? ` · ${nameOf(job)}`
										: ''}
									{#if job.status === 'queued'}
										<span class="font-normal text-muted-foreground">· queued</span>
									{/if}
								</p>
								<p class="truncate text-muted-foreground" title={job.progress}>
									{[savedProgress(job), job.progress].filter(Boolean).join(' · ') ||
										'Waiting for processing…'}
								</p>
							</div>
							<Button
								variant="ghost"
								size="sm"
								disabled={busy === job.id}
								onclick={() => act(job, 'cancel')}>Cancel</Button
							>
						</li>
					{/each}
				</ul>
			</section>
		{/if}
		{#if resumable.length}
			<section aria-labelledby="paused-jobs-heading">
				<h2 id="paused-jobs-heading" class="mb-2 text-sm font-semibold">Resume processing</h2>
				<ul class="divide-y border">
					{#each resumable as job (job.id)}
						<li class="flex flex-wrap items-center gap-3 px-3 py-2 text-xs">
							<Pause class="size-[18px] shrink-0" aria-hidden="true" />
							<div class="min-w-40 flex-1">
								<p class="font-medium break-words">{nameOf(job) ?? 'Source'}</p>
								<p class="text-muted-foreground">{savedProgress(job)}</p>
								<p class="break-words text-muted-foreground">
									{job.status === 'paused'
										? pauseNotice(job)
										: job.error || 'Processing interrupted.'}
								</p>
							</div>
							<Button
								variant="outline"
								size="sm"
								disabled={busy === job.id}
								onclick={() => act(job, 'retry')}>Resume processing</Button
							>
							<Button
								variant="ghost"
								size="sm"
								disabled={busy === job.id}
								onclick={() => (discarding = job)}>Discard progress</Button
							>
						</li>
					{/each}
				</ul>
			</section>
		{/if}
		{#if interrupted.length}
			<details>
				<summary class="cursor-pointer text-xs text-muted-foreground">
					Interrupted jobs ({interrupted.length})
				</summary>
				<ul class="mt-2 divide-y border">
					{#each interrupted as job (job.id)}
						<li class="flex items-center gap-3 px-3 py-2 text-xs">
							<div class="min-w-0 flex-1">
								<p class="font-medium">{KIND_LABELS[job.kind]}</p>
								<p class="break-words text-destructive">
									{job.error || (job.status === 'cancelled' ? 'Cancelled' : 'Failed')}
								</p>
							</div>
							<Button
								variant="ghost"
								size="sm"
								disabled={busy === job.id}
								onclick={() => act(job, 'retry')}
								>{job.canResumeCreation ? 'Resume creation' : 'Retry'}</Button
							>
							<Button
								variant="ghost"
								size="sm"
								disabled={busy === job.id}
								onclick={() => act(job, 'dismiss')}>Dismiss</Button
							>
						</li>
					{/each}
				</ul>
			</details>
		{/if}
	</div>
{/if}

<ConfirmDialog
	bind:open={
		() => discarding !== null,
		(open) => {
			if (!open) discarding = null;
		}
	}
	title={`Discard processing progress for “${discarding ? (nameOf(discarding) ?? 'Source') : ''}”?`}
	description="The next attempt will process the source from the beginning. Your original file is kept."
	confirmLabel="Discard progress"
	onConfirm={discardProgress}
/>
