<script lang="ts" module>
	import { browser } from '$app/environment';
	import DOMPurify from 'dompurify';
	import { marked } from 'marked';

	// Links leave the app, and remote images are dropped so opening an answer never calls out.
	if (browser)
		DOMPurify.addHook('afterSanitizeAttributes', (node) => {
			if (node.tagName !== 'A') return;
			node.setAttribute('target', '_blank');
			node.setAttribute('rel', 'noopener noreferrer');
		});

	function render(text: string): string {
		const html = marked.parse(text, { async: false, gfm: true, breaks: true });
		return DOMPurify.sanitize(html, { USE_PROFILES: { html: true }, FORBID_TAGS: ['img'] });
	}
</script>

<script lang="ts">
	/** Renders model-written Markdown. The HTML is sanitised; without a DOM the text stays plain. */
	let { text, class: className = '' }: { text: string; class?: string } = $props();
</script>

{#if browser}
	<!-- eslint-disable-next-line svelte/no-at-html-tags -- sanitised by DOMPurify in render() -->
	<div class={['markdown', className]}>{@html render(text)}</div>
{:else}
	<p class={['whitespace-pre-wrap', className]}>{text}</p>
{/if}
