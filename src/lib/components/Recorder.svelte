<script lang="ts">
	import { Mic, Pause, Play, Square, RotateCcw } from '@lucide/svelte';
	import { Button } from '#lib/components/ui/button/index.js';
	import { Label } from '#lib/components/ui/label/index.js';
	import * as NativeSelect from '#lib/components/ui/native-select/index.js';
	import { getProject } from '#lib/project.svelte.js';
	import type { RecordingSource, LocalRecording } from '#lib/recording/storage.js';

	/** The controls of the project's recorder, which keeps running on the project's other pages. */
	let { onSaved }: { onSaved?: (materialId: string) => void } = $props();
	const uid = $props.id();
	const project = getProject();
	const { recorder, projectId } = project;
	let source = $state<RecordingSource>('microphone');
	let deviceId = $state('');
	let inactive = $derived(['idle', 'complete'].includes(recorder.state));
	let busy = $derived(['starting', 'pausing', 'saving'].includes(recorder.state));

	async function save() {
		const id = await recorder.stop();
		if (id) {
			project.leaveWarning = false;
			onSaved?.(id);
		}
	}

	async function recover(recording: LocalRecording) {
		const id = await recorder.recover(recording);
		if (id) onSaved?.(id);
	}
</script>

<section aria-labelledby="{uid}-title" class="space-y-4">
	<div class="flex flex-wrap items-center justify-between gap-3">
		<h2 id="{uid}-title" class="text-sm font-semibold">Record audio</h2>
		<span class="font-mono text-sm tabular-nums" aria-label="Recorded duration"
			>{recorder.duration}</span
		>
	</div>
	<div class="flex flex-wrap items-end gap-3">
		<div class="min-w-0 space-y-1.5">
			<Label for="{uid}-source">Audio source</Label>
			<NativeSelect.Root id="{uid}-source" bind:value={source} disabled={!inactive}>
				<NativeSelect.Option value="microphone">Microphone</NativeSelect.Option>
				<NativeSelect.Option value="tab">Browser tab</NativeSelect.Option>
				<NativeSelect.Option value="both">Microphone and tab</NativeSelect.Option>
			</NativeSelect.Root>
		</div>
		{#if source !== 'tab' && recorder.devices.length > 1}
			<div class="min-w-0 space-y-1.5">
				<Label for="{uid}-microphone">Microphone</Label>
				<NativeSelect.Root
					id="{uid}-microphone"
					class="max-w-64"
					bind:value={deviceId}
					disabled={!inactive}
				>
					<NativeSelect.Option value="">System default</NativeSelect.Option>
					{#each recorder.devices as device (device.deviceId)}
						<NativeSelect.Option value={device.deviceId}>
							{device.label || 'Audio input'}
						</NativeSelect.Option>
					{/each}
				</NativeSelect.Root>
			</div>
		{/if}
		{#if inactive}
			<Button onclick={() => recorder.start(projectId, source, deviceId)}
				><Mic class="size-4" />Start recording</Button
			>
		{:else}
			{#if recorder.state === 'recording'}
				<Button variant="outline" onclick={() => recorder.pause()}
					><Pause class="size-4" />Pause</Button
				>
			{:else if !busy}
				<Button variant="outline" onclick={() => recorder.resume()}
					><Play class="size-4" />Resume</Button
				>
			{/if}
			<Button onclick={save} disabled={busy}
				><Square class="size-4" />{recorder.state === 'saving'
					? 'Saving…'
					: 'Stop and save'}</Button
			>
		{/if}
	</div>
	{#if source !== 'microphone' && inactive}
		<p class="text-sm text-muted-foreground">
			Select a browser tab and enable “Share tab audio” in your browser’s sharing dialog.
		</p>
	{/if}
	{#if recorder.message}
		<p role="status" class="text-sm text-muted-foreground">{recorder.message}</p>
	{/if}
	{#if recorder.error}
		<p role="alert" class="text-sm text-destructive">{recorder.error}</p>
	{/if}
	{#if project.leaveWarning}
		<p role="alert" class="text-sm">Stop and save the recording before leaving this project.</p>
	{/if}
	{#if recorder.pending > 0 && recorder.state === 'interrupted'}
		<p class="text-sm text-muted-foreground">
			{recorder.pending} audio {recorder.pending === 1 ? 'chunk is' : 'chunks are'} waiting in this browser.
			Keep this tab open and retry saving when connected.
		</p>
	{/if}
	{#if recorder.turns.length}
		<div
			class="max-h-56 space-y-3 overflow-y-auto border-l-2 border-border pl-4"
			aria-label="Live transcript"
		>
			{#each recorder.turns as turn (turn.id)}
				<p
					class={[
						'text-sm leading-relaxed whitespace-pre-wrap',
						!turn.final && 'text-muted-foreground'
					]}
				>
					{#if turn.speaker}<span class="font-medium"
							>{turn.speaker}:
						</span>{/if}{turn.text}{#if !turn.final}<span class="sr-only"> (provisional)</span>{/if}
				</p>
			{/each}
		</div>
	{/if}
	{#if recorder.unfinished.length && inactive}
		<div class="space-y-3 border-t border-border pt-4">
			<h3 class="text-sm font-medium">Recover unfinished recordings</h3>
			{#each recorder.unfinished as recording (recording.id)}
				<div class="flex min-w-0 items-center justify-between gap-3">
					<span class="truncate text-sm" title={recording.name}>{recording.name}</span>
					<Button variant="outline" size="sm" onclick={() => recover(recording)}
						><RotateCcw class="size-4" />Recover and save</Button
					>
				</div>
			{/each}
		</div>
	{/if}
</section>
