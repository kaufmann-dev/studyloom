<script lang="ts">
	import { toast } from 'svelte-sonner';
	import { isActiveJob, type Job, type JobKind } from '#lib/domain.js';
	import Button from '#lib/components/ui/button/button.svelte';
	import { Spinner } from '#lib/components/ui/spinner/index.js';
	import { api, errorText } from '#lib/ui.js';

	/** The project's running jobs, with the interrupted ones behind a disclosure. */
	let {
		jobs,
		onChanged,
		class: className = ''
	}: { jobs: Job[]; onChanged: () => void | Promise<void>; class?: string } = $props();

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
	let busy = $state('');
	let active = $derived(jobs.filter(isActiveJob));
	let interrupted = $derived(
		jobs.filter((job) => job.status === 'failed' || job.status === 'cancelled').slice(0, 10)
	);

	async function act(job: Job, action: 'cancel' | 'retry') {
		busy = job.id;
		try {
			await api(`/api/jobs/${job.id}/${action}`, { body: {} });
			await onChanged();
		} catch (cause) {
			toast.error(errorText(cause));
		} finally {
			busy = '';
		}
	}
</script>

{#if active.length || interrupted.length}
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
									{KIND_LABELS[job.kind]}
									{#if job.status === 'queued'}
										<span class="font-normal text-muted-foreground">· queued</span>
									{/if}
								</p>
								<p class="truncate text-muted-foreground" title={job.progress}>
									{job.progress || 'Waiting for processing…'}
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
								onclick={() => act(job, 'retry')}>Retry</Button
							>
						</li>
					{/each}
				</ul>
			</details>
		{/if}
	</div>
{/if}
