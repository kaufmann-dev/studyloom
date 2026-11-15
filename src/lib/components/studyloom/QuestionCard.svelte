<script lang="ts">
	import { mount, unmount, untrack } from 'svelte';
	import type { Attachment } from 'svelte/attachments';
	import {
		FIELD_PLACEHOLDER,
		type FieldValue,
		type Grade,
		type Material,
		type Question
	} from '#lib/domain.js';
	import { renderMarkdown } from '#lib/markdown.js';
	import Citations from './Citations.svelte';
	import FieldInput from './FieldInput.svelte';
	import Markdown from './Markdown.svelte';

	/**
	 * One question: its text with an input wherever a field is placed, and once it is graded the
	 * marks, explanation and sources.
	 */
	let {
		question,
		values = $bindable(),
		grade,
		locked = false,
		heading,
		outputId,
		projectId,
		materials = [],
		onChange
	}: {
		question: Question;
		/** What was entered, by field id. */
		values: Record<string, FieldValue>;
		grade?: Grade;
		locked?: boolean;
		heading: string;
		outputId: string;
		projectId: string;
		materials?: Material[];
		onChange?: () => void;
	} = $props();

	let html = $derived(renderMarkdown(question.body, { outputId }));

	/** A field's name for assistive technology: its table row and column, or its position. */
	function fieldLabel(slot: HTMLElement, index: number) {
		const cell = slot.closest('td, th');
		const row = cell?.closest('tr');
		if (cell && row) {
			const first = row.cells[0] === cell ? '' : (row.cells[0]?.textContent?.trim() ?? '');
			const column = [...row.cells].indexOf(cell as HTMLTableCellElement);
			const header = cell.closest('table')?.tHead?.rows[0]?.cells[column]?.textContent?.trim();
			const name = [first, header].filter(Boolean).join(', ');
			if (name) return name;
		}
		return `Answer ${index + 1}`;
	}

	/**
	 * Puts an input where each `{{field}}` stands. The text is sanitised before this runs, so
	 * nothing the model wrote can create an input, and only this question's fields are replaced.
	 */
	function fields(rendered: string): Attachment<HTMLElement> {
		return (node) => {
			if (!rendered) return;
			const known = new Map(question.fields.map((field) => [field.id, field]));
			const walker = document.createTreeWalker(node, NodeFilter.SHOW_TEXT);
			const texts: Text[] = [];
			while (walker.nextNode()) texts.push(walker.currentNode as Text);
			const mounted: Record<string, unknown>[] = [];
			let index = 0;
			for (const text of texts) {
				if (text.parentElement?.closest('code, pre, .katex')) continue;
				const parts = text.data.split(FIELD_PLACEHOLDER);
				if (parts.length === 1) continue;
				// split() with one capture group alternates plain text and field ids.
				const pieces = parts.map((part, i) => {
					const field = i % 2 ? known.get(part) : undefined;
					if (i % 2 === 0) return document.createTextNode(part);
					if (!field) return document.createTextNode(`{{${part}}}`);
					const slot = document.createElement('span');
					slot.dataset.field = field.id;
					return slot;
				});
				text.replaceWith(...pieces);
				for (const slot of pieces) {
					if (!(slot instanceof HTMLElement)) continue;
					const field = known.get(slot.dataset.field!)!;
					const position = index++;
					mounted.push(
						untrack(() =>
							mount(FieldInput, {
								target: slot,
								props: {
									field,
									label: fieldLabel(slot, position),
									value: () => values[field.id],
									onValue: (next: FieldValue) => {
										values = { ...values, [field.id]: next };
										onChange?.();
									},
									locked: () => locked,
									grade: () => grade?.fields.find((item) => item.fieldId === field.id)
								}
							})
						)
					);
				}
			}
			return () => {
				for (const component of mounted) void unmount(component);
			};
		};
	}
</script>

<section class="space-y-3" aria-label={heading}>
	<h3 class="text-xs font-semibold text-muted-foreground">{heading}</h3>
	{#key html}
		<div class="markdown [&_td]:align-middle" {@attach fields(html)}>
			<!-- eslint-disable-next-line svelte/no-at-html-tags -- sanitised by DOMPurify in renderMarkdown() -->
			{@html html}
		</div>
	{/key}
	{#if grade}
		<div class="space-y-2 bg-muted p-4 text-sm">
			<p class="font-semibold">
				{#if grade.state === 'pending'}
					Being graded…
				{:else}
					{grade.score} / {grade.maxScore} {grade.maxScore === 1 ? 'point' : 'points'}
				{/if}
			</p>
			{#if question.explanation}
				<Markdown text={question.explanation} {outputId} class="text-muted-foreground" />
			{/if}
			<Citations {projectId} citations={question.citations} {materials} />
		</div>
	{/if}
</section>
