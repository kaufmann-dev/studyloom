export type RecordingSource = 'microphone' | 'tab' | 'both';

export interface LocalRecording {
	id: string;
	projectId: string;
	name: string;
	source: RecordingSource;
	createdAt: string;
	nextSequence: number;
	samples: number;
}

export interface AudioChunk {
	recordingId: string;
	sequence: number;
	startSample: number;
	pcm: ArrayBuffer;
}

let database: Promise<IDBDatabase> | undefined;

function openDatabase() {
	return (database ??= new Promise<IDBDatabase>((resolve, reject) => {
		const request = indexedDB.open('studyloom-recordings', 1);
		request.onupgradeneeded = () => {
			request.result.createObjectStore('recordings', { keyPath: 'id' });
			const chunks = request.result.createObjectStore('chunks', {
				keyPath: ['recordingId', 'sequence']
			});
			chunks.createIndex('recording', 'recordingId');
		};
		request.onsuccess = () => resolve(request.result);
		request.onerror = () => {
			database = undefined;
			reject(request.error);
		};
		request.onblocked = () => {
			database = undefined;
			reject(new Error('Close other Studyloom tabs to open local recording storage.'));
		};
	}));
}

function done(transaction: IDBTransaction) {
	return new Promise<void>((resolve, reject) => {
		transaction.oncomplete = () => resolve();
		transaction.onabort = transaction.onerror = () =>
			reject(transaction.error ?? new Error('Local audio storage failed.'));
	});
}

function value<T>(request: IDBRequest<T>) {
	return new Promise<T>((resolve, reject) => {
		request.onsuccess = () => resolve(request.result);
		request.onerror = () => reject(request.error);
	});
}

export async function saveRecording(recording: LocalRecording) {
	const db = await openDatabase();
	const transaction = db.transaction('recordings', 'readwrite');
	transaction.objectStore('recordings').put(recording);
	await done(transaction);
}

/** Commit audio and its sequence/sample cursor atomically before transmitting anything. */
export async function storeChunk(recording: LocalRecording, chunk: AudioChunk) {
	const db = await openDatabase();
	const transaction = db.transaction(['recordings', 'chunks'], 'readwrite');
	transaction.objectStore('recordings').put(recording);
	transaction.objectStore('chunks').put(chunk);
	await done(transaction);
}

export async function acknowledgeChunk(id: string, sequence: number) {
	const db = await openDatabase();
	const transaction = db.transaction('chunks', 'readwrite');
	transaction.objectStore('chunks').delete([id, sequence]);
	await done(transaction);
}

export async function listRecordings(projectId: string) {
	const db = await openDatabase();
	const all = await value<LocalRecording[]>(
		db.transaction('recordings').objectStore('recordings').getAll()
	);
	return all.filter((recording) => recording.projectId === projectId);
}

export async function firstPendingChunk(id: string) {
	const db = await openDatabase();
	return value<AudioChunk | undefined>(
		db.transaction('chunks').objectStore('chunks').index('recording').get(id)
	);
}

export async function countPendingChunks(id: string) {
	const db = await openDatabase();
	return value(db.transaction('chunks').objectStore('chunks').index('recording').count(id));
}

export async function removeRecording(id: string) {
	const db = await openDatabase();
	const transaction = db.transaction(['recordings', 'chunks'], 'readwrite');
	transaction.objectStore('recordings').delete(id);
	const cursor = transaction.objectStore('chunks').index('recording').openCursor(id);
	cursor.onsuccess = () => {
		if (cursor.result) {
			cursor.result.delete();
			cursor.result.continue();
		}
	};
	await done(transaction);
}
