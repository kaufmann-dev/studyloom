import type { Citation, Snapshot } from '../domain';

/** The first citation whose locator is unknown or whose quote is not in that source chunk. */
export function findInvalidCitation(citations: Citation[], snapshot: Snapshot) {
	// Line breaks and table padding differ between a chunk and a quote of it; the words must not.
	const flat = (text: string) => text.replace(/\s+/g, ' ').trim();
	return citations.find((citation) => {
		const material = snapshot.find((m) => m.id === citation.materialId);
		const chunk = material?.chunks.find((c) => c.locator === citation.locator);
		return !chunk || (citation.quote && !flat(chunk.text).includes(flat(citation.quote)));
	});
}
export function validateCitations(citations: Citation[], snapshot: Snapshot) {
	if (findInvalidCitation(citations, snapshot))
		throw new Error('Claude returned a citation that does not match the source.');
}
