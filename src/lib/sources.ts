import type { Material, ProjectMaterial } from './domain';

export const STATUS_LABELS: Record<Material['status'], string> = {
	uploading: 'Upload incomplete',
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

/** Whether processing can be started again: after a failure, a partial result or a stalled upload. */
export function canRetry(material: ProjectMaterial) {
	return (
		material.status === 'failed' ||
		(material.status === 'partial' && material.counts.chunks > 0) ||
		(material.status === 'uploading' && material.receivedBytes === material.size)
	);
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
