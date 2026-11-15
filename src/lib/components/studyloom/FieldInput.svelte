<script lang="ts">
	import { ArrowRight, Check, X } from '@lucide/svelte';
	import type { FieldGrade, FieldValue, QuestionField } from '#lib/domain.js';
	import Input from '#lib/components/ui/input/input.svelte';
	import * as NativeSelect from '#lib/components/ui/native-select/index.js';
	import Textarea from '#lib/components/ui/textarea/textarea.svelte';

	/**
	 * The input of one answer field. It is mounted into its place in a question's text, so the
	 * current value, lock and grade arrive as functions that are read where they are shown.
	 */
	let {
		field,
		label,
		value,
		onValue,
		locked,
		grade
	}: {
		field: QuestionField;
		/** The accessible name: what this field stands for in its sentence or table. */
		label: string;
		value: () => FieldValue | undefined;
		onValue: (next: FieldValue) => void;
		locked: () => boolean;
		grade: () => FieldGrade | undefined;
	} = $props();
	const uid = $props.id();
	let result = $derived(grade());
	let disabled = $derived(locked());
	let text = $derived.by(() => {
		const current = value();
		return typeof current === 'string' ? current : '';
	});
	let chosen = $derived.by(() => {
		const current = value();
		return Array.isArray(current) ? current : [];
	});
	const pick = (id: string, checked: boolean) =>
		onValue(checked ? [...chosen, id] : chosen.filter((item) => item !== id));
</script>

{#snippet mark()}
	{#if result && result.state !== 'pending'}
		{#if result.state === 'correct'}
			<Check class="inline size-4 shrink-0 text-primary" aria-label="Correct" />
		{:else}
			<X
				class="inline size-4 shrink-0 text-warning"
				aria-label={result.state === 'partial' ? 'Partly correct' : 'Not correct'}
			/>
		{/if}
	{/if}
{/snippet}

{#snippet options(multiple: boolean)}
	{#if field.type === 'select' || field.type === 'multiselect'}
		{@const right = field.type === 'select' ? [field.correct] : field.correct}
		<span role="group" aria-label={label} class="my-2 block space-y-2">
			{#each field.options as option (option.id)}
				{@const picked = multiple ? chosen.includes(option.id) : text === option.id}
				<label
					class={[
						'flex cursor-pointer items-start gap-3 border p-3 text-sm',
						result && right.includes(option.id) && 'border-primary',
						result && picked && !right.includes(option.id) && 'border-warning'
					]}
				>
					{#if multiple}
						<input
							type="checkbox"
							class="mt-0.5 size-4 shrink-0 accent-primary"
							checked={picked}
							{disabled}
							onchange={(event) => pick(option.id, event.currentTarget.checked)}
						/>
					{:else}
						<input
							type="radio"
							name={uid}
							class="mt-0.5 size-4 shrink-0 accent-primary"
							checked={picked}
							{disabled}
							onchange={() => onValue(option.id)}
						/>
					{/if}
					<span class="min-w-0 flex-1 leading-relaxed">
						{option.text}
						{#if result && picked && !right.includes(option.id) && option.why}
							<span class="mt-1 block text-xs text-muted-foreground">{option.why}</span>
						{/if}
					</span>
					{#if result && right.includes(option.id)}
						<Check class="size-4 shrink-0 text-primary" aria-label="Right answer" />
					{:else if result && picked}
						<X class="size-4 shrink-0 text-warning" aria-label="Not correct" />
					{/if}
				</label>
			{/each}
		</span>
	{/if}
{/snippet}

{#snippet expected()}
	{#if result && result.state !== 'correct' && result.state !== 'pending'}
		<span
			class="inline-flex items-center gap-1 text-xs whitespace-normal text-muted-foreground"
			data-expected
		>
			<ArrowRight class="size-3 shrink-0" aria-hidden="true" /><span class="sr-only">Expected:</span
			>{result.expected}
		</span>
	{/if}
{/snippet}

{#if field.type === 'select' && field.display === 'radio'}
	{@render options(false)}
{:else if field.type === 'multiselect'}
	{@render options(true)}
{:else if field.type === 'select'}
	<span class="inline-flex max-w-full flex-wrap items-center gap-1.5 align-middle">
		<NativeSelect.Root
			size="sm"
			class="max-w-full"
			aria-label={label}
			value={text}
			{disabled}
			onchange={(event) => onValue(event.currentTarget.value)}
		>
			<NativeSelect.Option value="">Choose…</NativeSelect.Option>
			{#each field.options as option (option.id)}
				<NativeSelect.Option value={option.id}>{option.text}</NativeSelect.Option>
			{/each}
		</NativeSelect.Root>
		{@render mark()}
		{@render expected()}
	</span>
{:else if field.type === 'toggle'}
	<span class="inline-flex items-center gap-1.5 align-middle">
		<input
			type="checkbox"
			class="size-4 accent-primary"
			aria-label={label}
			checked={value() === true}
			{disabled}
			onchange={(event) => onValue(event.currentTarget.checked)}
		/>
		{@render mark()}
		{@render expected()}
	</span>
{:else if field.type === 'essay'}
	<span class="my-2 block space-y-2">
		<Textarea
			rows={4}
			aria-label={label}
			placeholder="Answer in your own words…"
			value={text}
			{disabled}
			oninput={(event) => onValue(event.currentTarget.value)}
		/>
		{#if result?.state === 'pending'}
			<span class="block text-xs text-muted-foreground">Waiting to be graded…</span>
		{:else if result}
			<span class="flex items-start gap-1.5 text-sm">
				{@render mark()}
				<span class="min-w-0 whitespace-pre-wrap">{result.feedback ?? ''}</span>
			</span>
		{/if}
	</span>
{:else}
	<span class="inline-flex max-w-full flex-wrap items-center gap-1.5 align-middle">
		<Input
			class={['h-8 py-1', field.type === 'number' ? 'w-28' : 'w-44']}
			inputmode={field.type === 'number' ? 'decimal' : undefined}
			autocomplete="off"
			aria-label={label}
			value={text}
			{disabled}
			oninput={(event) => onValue(event.currentTarget.value)}
		/>
		{#if field.type === 'number' && field.unit}<span class="text-sm">{field.unit}</span>{/if}
		{@render mark()}
		{@render expected()}
	</span>
{/if}
