import type { Material, ProjectMaterial } from './domain';

export const STATUS_LABELS: Record<Material['status'], string> = {
	uploading: 'Upload incomplete',
	stored: 'Not processed',
	processing: 'Processing',
	ready: 'Ready',
	partial: 'Partly readable',
	failed: 'Failed',
	recording: 'Recording',
	paused: 'Recording paused'
};

/** What kind of source this is, in a word or two, from how it was added and its file type. */
export function sourceType(material: Material): string {
	const type = material.mimeType;
	if (material.kind === 'recording') return 'Recording';
	if (material.sourceUrl) return 'Web page';
	if (type === 'application/pdf') return 'PDF';
	if (type.startsWith('audio/')) return 'Audio';
	if (type.startsWith('video/')) return 'Video';
	if (type.startsWith('image/')) return 'Image';
	if (/spreadsheet|excel|csv/.test(type)) return 'Spreadsheet';
	if (/presentation|powerpoint/.test(type)) return 'Slides';
	if (/wordprocessing|msword|opendocument\.text|rtf/.test(type)) return 'Document';
	if (type.startsWith('text/')) return 'Text';
	return 'File';
}

/**
 * What processing can do for a file source now: start (a stored file or a finished upload), try
 * again after a failure, or redo an extraction that exists. Recordings are saved, not processed.
 */
export function processAction(material: ProjectMaterial) {
	if (material.kind !== 'file') {
		// A recording whose final save failed can be saved again.
		return material.status === 'failed' || material.status === 'partial' ? 'Retry saving' : '';
	}
	if (material.status === 'stored') return 'Process';
	if (material.status === 'uploading')
		return material.receivedBytes === material.size ? 'Continue processing' : '';
	if (material.status === 'failed') return 'Retry processing';
	return material.status === 'ready' || material.status === 'partial' ? 'Reprocess' : '';
}

/** A playing time such as "4:07" or "1:02:45". */
export function playingTime(ms: number) {
	const seconds = Math.floor(ms / 1000);
	const minutes = Math.floor(seconds / 60);
	const rest = String(seconds % 60).padStart(2, '0');
	return minutes < 60
		? `${minutes}:${rest}`
		: `${Math.floor(minutes / 60)}:${String(minutes % 60).padStart(2, '0')}:${rest}`;
}
