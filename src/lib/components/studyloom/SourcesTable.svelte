<script lang="ts">
	import { goto } from '$app/navigation';
	import { resolve } from '$app/paths';
	import type { Path } from '$app/types';
	import { toast } from 'svelte-sonner';
	import {
		ArrowDown,
		ArrowUp,
		Download,
		Ellipsis,
		FileText,
		RefreshCw,
		Save,
		Search,
		Trash2
	} from '@lucide/svelte';
	import { isActiveJob, type ProjectMaterial } from '#lib/domain.js';
	import Button from '#lib/components/ui/button/button.svelte';
	import { Checkbox } from '#lib/components/ui/checkbox/index.js';
	import * as DropdownMenu from '#lib/components/ui/dropdown-menu/index.js';
	import * as InputGroup from '#lib/components/ui/input-group/index.js';
	import { Spinner } from '#lib/components/ui/spinner/index.js';
	import * as Table from '#lib/components/ui/table/index.js';
	import { getProject } from '#lib/project.svelte.js';
	import { STATUS_LABELS, playingTime, processAction, sourceType } from '#lib/sources.js';
	import { api, dateLabel, errorText, fileSize, plural } from '#lib/ui.js';
	import ConfirmDialog from './ConfirmDialog.svelte';

	/** Every source of the open project with what was extracted from it. */
	const project = getProject();
	type SortKey = 'name' | 'type' | 'size' | 'added' | 'status';
	const COLUMNS: { key: SortKey; label: string; numeric?: boolean }[] = [
		{ key: 'name', label: 'Name' },
		{ key: 'type', label: 'Type' },
		{ key: 'size', label: 'Size', numeric: true },
		{ key: 'added', label: 'Added' },
		{ key: 'status', label: 'Status' }
	];
	let sort = $state<{ key: SortKey; descending: boolean }>({ key: 'added', descending: true });
	let filter = $state('');
	let busy = $state('');
	let deleting = $state.raw<ProjectMaterial | null>(null);
	/** Rows ticked for processing in one go. */
	let ticked = $state<string[]>([]);
	let processable = $derived(project.materials.filter((material) => processAction(material)));
	let chosen = $derived(processable.filter((material) => ticked.includes(material.id)));

	const sortValue: Record<SortKey, (material: ProjectMaterial) => string | number> = {
		name: (material) => material.name.toLowerCase(),
		type: (material) => sourceType(material),
		size: (material) => material.size,
		added: (material) => material.createdAt,
		status: (material) => STATUS_LABELS[material.status]
	};
	let rows = $derived.by(() => {
		const needle = filter.trim().toLowerCase();
		const value = sortValue[sort.key];
		return project.materials
			.filter((material) => !needle || material.name.toLowerCase().includes(needle))
			.toSorted((a, b) => {
				const [x, y] = [value(a), value(b)];
				// Equal values keep the newest source first, so the order never jumps.
				const order = x < y ? -1 : x > y ? 1 : b.createdAt.localeCompare(a.createdAt);
				return sort.descending && x !== y ? -order : order;
			});
	});
	const progressOf = (material: ProjectMaterial) =>
		project.data?.jobs.find((job) => job.materialId === material.id && isActiveJob(job))
			?.progress ?? '';
	const detail = (material: ProjectMaterial) =>
		resolve('/projects/[id]/sources/[materialId]', {
			id: project.projectId,
			materialId: material.id
		});
	const subtitle = (material: ProjectMaterial) =>
		material.sourceUrl
			? new URL(material.sourceUrl).hostname
			: material.filename !== material.name
				? material.filename
				: '';

	function sortBy(key: SortKey) {
		sort = { key, descending: sort.key === key ? !sort.descending : key === 'added' };
	}
	async function act(material: ProjectMaterial, path: string, body: unknown) {
		busy = material.id;
		try {
			await api(path, { body });
			await project.refresh();
		} catch (cause) {
			toast.error(errorText(cause));
		} finally {
			busy = '';
		}
	}
	const process = (material: ProjectMaterial) =>
		api(`/api/materials/${material.id}/process`, { body: { modelId: project.processingModel } });
	function tick(id: string, checked: boolean) {
		ticked = checked ? [...ticked, id] : ticked.filter((value) => value !== id);
	}
	/** Queues every ticked source; one that cannot start is reported and the rest go on. */
	async function processChosen() {
		busy = 'all';
		const failures: string[] = [];
		for (const material of chosen) {
			try {
				await process(material);
			} catch (cause) {
				failures.push(`${material.name}: ${errorText(cause)}`);
			}
		}
		ticked = [];
		busy = '';
		if (failures.length) toast.error(failures.join('\n'));
		await project.refresh();
	}
	async function remove() {
		const material = deleting;
		if (!material) return;
		await api(`/api/materials/${material.id}`, { method: 'DELETE' });
		toast.success(`Deleted “${material.name}”.`);
		await project.refresh();
	}
</script>

<section aria-labelledby="sources-heading" class="min-w-0">
	<div class="mb-3 flex flex-wrap items-center justify-between gap-3">
		<h2 id="sources-heading" class="text-sm font-semibold">
			Sources <span class="font-normal text-muted-foreground">({project.materials.length})</span>
		</h2>
		{#if chosen.length}
			<Button size="sm" class="ml-auto" disabled={busy === 'all'} onclick={processChosen}>
				<RefreshCw />Process {chosen.length} selected
			</Button>
		{/if}
		{#if project.materials.length > 1}
			<InputGroup.Root class="w-full sm:w-64">
				<InputGroup.Addon><Search /></InputGroup.Addon>
				<InputGroup.Input
					type="search"
					placeholder="Filter by name"
					aria-label="Filter sources by name"
					bind:value={filter}
				/>
			</InputGroup.Root>
		{/if}
	</div>
	{#if !project.materials.length}
		<p class="border border-dashed p-5 text-sm leading-relaxed text-muted-foreground">
			Add a file, a web page, pasted text or a recording to give this project its first source.
		</p>
	{:else if !rows.length}
		<p class="border border-dashed p-5 text-sm text-muted-foreground">
			No source name contains “{filter.trim()}”.
		</p>
	{:else}
		<div class="border">
			<Table.Root>
				<Table.Header>
					<Table.Row>
						<Table.Head class="w-8">
							<Checkbox
								aria-label="Select all sources that can be processed"
								disabled={!processable.length}
								checked={processable.length > 0 && chosen.length === processable.length}
								indeterminate={chosen.length > 0 && chosen.length < processable.length}
								onCheckedChange={(checked) =>
									(ticked = checked ? processable.map((material) => material.id) : [])}
							/>
						</Table.Head>
						{#each COLUMNS as column (column.key)}
							<Table.Head
								class={[column.numeric && 'text-right']}
								aria-sort={sort.key !== column.key
									? 'none'
									: sort.descending
										? 'descending'
										: 'ascending'}
							>
								<button
									type="button"
									class="inline-flex min-h-6 items-center gap-1 hover:underline"
									onclick={() => sortBy(column.key)}
								>
									{column.label}
									{#if sort.key === column.key}
										{#if sort.descending}<ArrowDown class="size-3" />{:else}<ArrowUp
												class="size-3"
											/>{/if}
									{/if}
								</button>
							</Table.Head>
						{/each}
						<Table.Head>Extracted</Table.Head>
						<Table.Head><span class="sr-only">Actions</span></Table.Head>
					</Table.Row>
				</Table.Header>
				<Table.Body>
					{#each rows as material (material.id)}
						{@const progress = material.status === 'processing' ? progressOf(material) : ''}
						{@const action = processAction(material)}
						<Table.Row>
							<Table.Cell>
								<Checkbox
									aria-label={`Select ${material.name} for processing`}
									disabled={!action}
									checked={ticked.includes(material.id)}
									onCheckedChange={(checked) => tick(material.id, checked)}
								/>
							</Table.Cell>
							<Table.Cell class="max-w-[28rem] min-w-56 whitespace-normal">
								<a
									href={detail(material)}
									class="block truncate font-medium hover:underline"
									title={material.name}>{material.name}</a
								>
								{#if subtitle(material)}
									<p class="truncate text-xs text-muted-foreground" title={subtitle(material)}>
										{subtitle(material)}
									</p>
								{/if}
								{#if material.notes && (material.status === 'partial' || material.status === 'failed')}
									<p class="mt-1 line-clamp-2 text-xs text-muted-foreground" title={material.notes}>
										{material.notes}
									</p>
								{/if}
							</Table.Cell>
							<Table.Cell>{sourceType(material)}</Table.Cell>
							<Table.Cell class="text-right tabular-nums">
								{material.size
									? fileSize(material.size)
									: material.durationMs
										? playingTime(material.durationMs)
										: '–'}
							</Table.Cell>
							<Table.Cell class="whitespace-nowrap">{dateLabel(material.createdAt)}</Table.Cell>
							<Table.Cell class="max-w-56">
								<p class="flex items-center gap-1.5">
									{#if material.status === 'processing'}
										<Spinner class="size-3" role="presentation" />
									{/if}
									<span class={[material.status === 'failed' && 'text-destructive']}>
										{STATUS_LABELS[material.status]}
									</span>
								</p>
								{#if progress}
									<p class="truncate text-xs text-muted-foreground" title={progress}>{progress}</p>
								{/if}
							</Table.Cell>
							<Table.Cell class="whitespace-nowrap text-muted-foreground">
								{#if material.counts.chunks}
									{[
										plural(material.counts.chunks, 'section'),
										...(material.counts.figures ? [plural(material.counts.figures, 'figure')] : []),
										...(material.counts.exercises
											? [plural(material.counts.exercises, 'exercise')]
											: [])
									].join(' · ')}
								{:else}
									–
								{/if}
							</Table.Cell>
							<Table.Cell class="text-right">
								<DropdownMenu.Root>
									<DropdownMenu.Trigger>
										{#snippet child({ props })}
											<Button
												{...props}
												variant="ghost"
												size="icon-sm"
												aria-label={`Actions for ${material.name}`}
												disabled={busy === material.id}
											>
												<Ellipsis />
											</Button>
										{/snippet}
									</DropdownMenu.Trigger>
									<DropdownMenu.Content align="end" class="w-52">
										<DropdownMenu.Item onSelect={() => goto(detail(material))}>
											<FileText />Open
										</DropdownMenu.Item>
										{#if action}
											<DropdownMenu.Item
												onSelect={() =>
													act(material, `/api/materials/${material.id}/process`, {
														modelId: project.processingModel
													})}
											>
												<RefreshCw />{action}
											</DropdownMenu.Item>
										{/if}
										{#if material.kind === 'recording' && material.status === 'paused'}
											<DropdownMenu.Item
												onSelect={() =>
													act(material, `/api/recordings/${material.id}/recover`, {
														finalize: true
													})}
											>
												<Save />Save recording
											</DropdownMenu.Item>
										{/if}
										{#if material.kind === 'file' && material.status !== 'uploading'}
											<DropdownMenu.Item>
												{#snippet child({ props })}
													<a
														{...props}
														href={resolve(`/api/materials/${material.id}/file?download=1` as Path)}
													>
														<Download />Download original
													</a>
												{/snippet}
											</DropdownMenu.Item>
										{/if}
										<DropdownMenu.Separator />
										<DropdownMenu.Item variant="destructive" onSelect={() => (deleting = material)}>
											<Trash2 />Delete
										</DropdownMenu.Item>
									</DropdownMenu.Content>
								</DropdownMenu.Root>
							</Table.Cell>
						</Table.Row>
					{/each}
				</Table.Body>
			</Table.Root>
		</div>
	{/if}
</section>

<ConfirmDialog
	bind:open={
		() => deleting !== null,
		(open) => {
			if (!open) deleting = null;
		}
	}
	title={`Delete “${deleting?.name}”?`}
	description="The source, its transcript and its extracted text are removed permanently."
	onConfirm={remove}
/>
