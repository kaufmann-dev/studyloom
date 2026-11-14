<script lang="ts">
	import { browser } from '$app/env';
	import { mode } from 'mode-watcher';
	import type { Attachment } from 'svelte/attachments';
	import { renderDiagrams, renderMarkdown } from '#lib/markdown.js';

	/**
	 * Renders model-written Markdown: tables, formulas, diagrams and stored images. The HTML is
	 * sanitised; without a DOM the text stays plain. `outputId` resolves an output's own images.
	 */
	let {
		text,
		class: className = '',
		outputId
	}: { text: string; class?: string; outputId?: string } = $props();

	let html = $derived(browser ? renderMarkdown(text, { outputId }) : '');

	/** Draws the diagrams again whenever the text or the theme changes. */
	function diagrams(rendered: string, dark: boolean): Attachment<HTMLElement> {
		return (node) => {
			const blocks = [...node.querySelectorAll<HTMLElement>('pre.mermaid')];
			if (!rendered || !blocks.length) return;
			let stale = false;
			void renderDiagrams(blocks, dark, () => stale);
			return () => {
				stale = true;
			};
		};
	}
</script>

{#if browser}
	<div class={['markdown', className]} {@attach diagrams(html, mode.current === 'dark')}>
		<!-- eslint-disable-next-line svelte/no-at-html-tags -- sanitised by DOMPurify in renderMarkdown() -->
		{@html html}
	</div>
{:else}
	<p class={['whitespace-pre-wrap', className]}>{text}</p>
{/if}
