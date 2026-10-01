import { api } from './ui';

export interface PendingUpload {
	/** The server-side record that receives the chunks. */
	id: string;
	file: File;
	chunkSize: number;
	nextSequence: number;
}

export function uploadPercent(upload: PendingUpload): number {
	const sent = upload.nextSequence * upload.chunkSize;
	return Math.min(100, Math.round((sent / upload.file.size) * 100));
}

/**
 * Sends the remaining chunks in order. `onChunk` receives the upload after every stored
 * chunk, so a failed upload can later resume from where it stopped.
 */
export async function sendChunks(
	upload: PendingUpload,
	chunkUrl: (sequence: number) => string,
	onChunk: (upload: PendingUpload) => void
): Promise<PendingUpload> {
	let current = upload;
	while (current.nextSequence * current.chunkSize < current.file.size) {
		const offset = current.nextSequence * current.chunkSize;
		await api(chunkUrl(current.nextSequence), {
			method: 'PUT',
			body: current.file.slice(offset, offset + current.chunkSize)
		});
		current = { ...current, nextSequence: current.nextSequence + 1 };
		onChunk(current);
	}
	return current;
}
