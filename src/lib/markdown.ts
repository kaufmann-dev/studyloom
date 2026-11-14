import DOMPurify from 'dompurify';
import { Marked } from 'marked';
import markedKatex from 'marked-katex-extension';

/** Where a rendered text's stored images come from: `image:<id>` belongs to this output. */
export interface MarkdownOptions {
	outputId?: string;
}

const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
const ASSET_REFERENCE = new RegExp(`^asset:(${UUID})$`);
const IMAGE_REFERENCE = /^image:([A-Za-z0-9_-]{1,64})$/;
// The only image addresses a rendered text may load: a source figure or an output's own image.
const STORED_IMAGE = new RegExp(
	`^/api/(?:assets/${UUID}/file|outputs/${UUID}/images/[A-Za-z0-9_-]{1,64})$`
);

const escapeHtml = (text: string) =>
	text.replace(
		/[&<>"']/g,
		(c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!
	);

/** The same-origin address of a stored image reference, or nothing for any other address. */
export function storedImageUrl(href: string, outputId?: string) {
	const asset = ASSET_REFERENCE.exec(href);
	if (asset) return `/api/assets/${asset[1]}/file`;
	const image = IMAGE_REFERENCE.exec(href);
	if (image && outputId) return `/api/outputs/${outputId}/images/${image[1]}`;
}

// marked parses synchronously, so the output of the text being rendered can sit here meanwhile.
let outputId: string | undefined;
const markdown = new Marked(
	{ gfm: true, breaks: true },
	// HTML output only: the sanitiser below removes MathML.
	markedKatex({ throwOnError: false, output: 'html' }),
	{
		renderer: {
			image({ href, text }) {
				const src = storedImageUrl(href, outputId);
				return src ? `<img src="${src}" alt="${escapeHtml(text)}" loading="lazy">` : '';
			},
			code({ text, lang }) {
				// Diagrams are drawn later by renderDiagrams; until then the source stays readable.
				return lang === 'mermaid' ? `<pre class="mermaid">${escapeHtml(text)}</pre>` : false;
			}
		}
	}
);

let hooked = false;
function addHooks() {
	hooked = true;
	// Links leave the app, and an image is kept only when it is one of the stored ones, so opening
	// a text never calls out and never reaches another route of the app.
	DOMPurify.addHook('afterSanitizeAttributes', (node) => {
		if (node.tagName === 'A') {
			node.setAttribute('target', '_blank');
			node.setAttribute('rel', 'noopener noreferrer');
		}
		if (node.tagName === 'IMG' && !STORED_IMAGE.test(node.getAttribute('src') ?? '')) node.remove();
	});
}

/** Model-written Markdown as sanitised HTML, with tables, formulas and stored images. Browser only. */
export function renderMarkdown(text: string, options: MarkdownOptions = {}): string {
	if (!hooked) addHooks();
	outputId = options.outputId;
	let html: string;
	try {
		html = markdown.parse(text, { async: false });
	} finally {
		outputId = undefined;
	}
	// KaTeX draws roots and braces as inline SVG.
	return DOMPurify.sanitize(html, { USE_PROFILES: { html: true, svg: true } });
}

let diagrams = 0;
/** Draws the Mermaid blocks of a rendered text. A block that cannot be drawn keeps its source. */
export async function renderDiagrams(blocks: HTMLElement[], dark: boolean, stale: () => boolean) {
	const { default: mermaid } = await import('mermaid');
	mermaid.initialize({
		startOnLoad: false,
		securityLevel: 'strict',
		suppressErrorRendering: true,
		theme: dark ? 'dark' : 'neutral'
	});
	for (const block of blocks) {
		const source = (block.dataset.source ??= block.textContent ?? '');
		try {
			const { svg } = await mermaid.render(`diagram-${++diagrams}`, source);
			if (stale()) return;
			// Mermaid sanitises its own output at the strict security level.
			block.innerHTML = svg;
			block.classList.add('drawn');
		} catch {
			if (stale()) return;
			block.textContent = source;
			block.classList.remove('drawn');
		}
	}
}
