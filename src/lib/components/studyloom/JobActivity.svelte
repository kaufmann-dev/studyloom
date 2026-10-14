<script lang="ts">
	import { toast } from 'svelte-sonner';
	import { isActiveJob, type Job, type JobKind } from '#lib/domain.js';
	import Button from '#lib/components/ui/button/button.svelte';
	import { Spinner } from '#lib/components/ui/spinner/index.js';
	import { api, errorText } from '#lib/ui.js';

	let { jobs, onChanged }: { jobs: Job[]; onChanged: () => void | Promise<void> } = $props();

	const KIND_LABELS: Record<JobKind, string> = {
		ingest: 'Processing source',
		recover: 'Saving recording',
		chat: 'Chat answer',
		summary: 'Summary',
		quiz: 'Quiz',
		audio: 'Audio summary',
		session: 'Study session',
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

{#if active.length}
	<section aria-labelledby="active-jobs-heading" class="space-y-3">
		<h2 id="active-jobs-heading" class="text-sm font-semibold">In progress</h2>
		{#each active as job (job.id)}
			<div class="border p-3">
				<p class="flex items-center gap-2 text-xs font-medium">
					<Spinner class="size-3" role="presentation" />{KIND_LABELS[job.kind]}
					{#if job.status === 'queued'}<span class="font-normal text-muted-foreground"
							>· queued</span
						>{/if}
				</p>
				<p class="mt-1 line-clamp-3 text-xs break-words text-muted-foreground">
					{job.progress || 'Waiting for processing…'}
				</p>
				<Button
					variant="ghost"
					size="sm"
					class="mt-2"
					disabled={busy === job.id}
					onclick={() => act(job, 'cancel')}>Cancel</Button
				>
			</div>
		{/each}
	</section>
{/if}
{#if interrupted.length}
	<details>
		<summary class="cursor-pointer text-xs text-muted-foreground">
			Interrupted jobs ({interrupted.length})
		</summary>
		<ul class="mt-2 space-y-2">
			{#each interrupted as job (job.id)}
				<li class="border p-3 text-xs">
					<p class="font-medium">{KIND_LABELS[job.kind]}</p>
					<p class="mt-1 break-words text-destructive">
						{job.error || (job.status === 'cancelled' ? 'Cancelled' : 'Failed')}
					</p>
					<Button
						variant="ghost"
						size="sm"
						class="mt-2"
						disabled={busy === job.id}
						onclick={() => act(job, 'retry')}>Retry</Button
					>
				</li>
			{/each}
		</ul>
	</details>
{/if}
