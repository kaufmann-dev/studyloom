import { SvelteDate } from 'svelte/reactivity';
import type { Job } from '$lib/domain';
import {
	acknowledgeChunk,
	listRecordings,
	firstPendingChunk,
	countPendingChunks,
	removeRecording,
	saveRecording,
	storeChunk,
	type LocalRecording,
	type AudioChunk,
	type RecordingSource
} from './storage';

type RecorderState =
	'idle' | 'starting' | 'recording' | 'pausing' | 'paused' | 'saving' | 'interrupted' | 'complete';
type TranscriptTurn = { id: string; text: string; speaker?: string; final: boolean };

async function checked(response: Response) {
	if (!response.ok) {
		const data = await response.json().catch(() => null);
		throw new Error(data?.message ?? `Request failed (${response.status}). Please try again.`);
	}
	return response;
}

/** Recovery must finish before opening a new realtime segment. Polls never extend the session. */
export async function waitForRecoveryJob(
	jobId: string,
	onProgress: (message: string) => void,
	signal: AbortSignal
) {
	const deadline = Date.now() + 20 * 60 * 1000;
	while (!signal.aborted && Date.now() < deadline) {
		const response = await checked(
			await fetch(`/api/jobs/${encodeURIComponent(jobId)}`, {
				signal: AbortSignal.any([signal, AbortSignal.timeout(30000)])
			})
		);
		const { job }: { job: Job } = await response.json();
		if (job?.status === 'succeeded') return;
		if (job?.status === 'failed' || job?.status === 'cancelled') {
			throw new Error(job.error || `Audio recovery ${job.status}. Retry saving this recording.`);
		}
		if (!job || !['queued', 'running'].includes(job.status))
			throw new Error('The server returned an invalid audio recovery status.');
		onProgress(job.progress || 'Recovering the interrupted transcript…');
		await new Promise((resolve) => setTimeout(resolve, 1000));
	}
	throw new Error(
		signal.aborted
			? 'Audio recovery interrupted.'
			: 'Audio recovery is taking longer than expected. Your recording is saved; retry Resume later.'
	);
}

export class BrowserRecorder {
	state = $state<RecorderState>('idle');
	message = $state('');
	error = $state('');
	samples = $state(0);
	pending = $state(0);
	turns = $state.raw<TranscriptTurn[]>([]);
	unfinished = $state.raw<LocalRecording[]>([]);
	devices = $state.raw<MediaDeviceInfo[]>([]);
	private recording?: LocalRecording;
	private context?: AudioContext;
	private processor?: AudioWorkletNode;
	private streams: MediaStream[] = [];
	private socket?: WebSocket;
	private ready = false;
	private writing: Promise<void> = Promise.resolve();
	private storageFailure = false;
	private unsavedChunks: Array<{ metadata: LocalRecording; chunk: AudioChunk }> = [];
	private flushDone?: () => void;
	private endDone?: (type: string) => void;
	private rotation?: ReturnType<typeof setTimeout>;
	private disposed = false;
	private lifecycle = new AbortController();
	private turnSerial = 0;
	private currentTurn = '';
	get needsAttention() {
		return !['idle', 'complete'].includes(this.state) || this.pending > 0;
	}
	get duration() {
		const seconds = Math.floor(this.samples / 24000);
		return `${Math.floor(seconds / 60)
			.toString()
			.padStart(2, '0')}:${(seconds % 60).toString().padStart(2, '0')}`;
	}

	async initialize(projectId: string) {
		try {
			this.unfinished = await listRecordings(projectId);
			await this.refreshDevices();
		} catch (error) {
			this.error = this.explain(error);
		}
	}

	async refreshDevices() {
		if (navigator.mediaDevices?.enumerateDevices) {
			this.devices = (await navigator.mediaDevices.enumerateDevices()).filter(
				(device) => device.kind === 'audioinput'
			);
		}
	}

	async start(projectId: string, source: RecordingSource, deviceId = '') {
		if (!['idle', 'complete'].includes(this.state)) return;
		this.state = 'starting';
		this.error = '';
		this.message = 'Choose the audio to record.';
		this.samples = 0;
		this.pending = 0;
		this.turns = [];
		this.storageFailure = false;
		try {
			if (!navigator.mediaDevices || !window.isSecureContext)
				throw new Error('Recording requires HTTPS and a browser with audio capture support.');
			// Screen capture must be the first awaited action after the user's click.
			if (source !== 'microphone') {
				if (!navigator.mediaDevices.getDisplayMedia)
					throw new Error(
						'This browser cannot capture tab audio. Use a supported desktop browser or choose Microphone.'
					);
				const shared = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: true });
				this.streams.push(shared);
				if (!shared.getAudioTracks().length)
					throw new Error(
						'No shared audio was selected. Select a browser tab and enable Share tab audio.'
					);
			}
			if (source !== 'tab') {
				this.streams.push(
					await navigator.mediaDevices.getUserMedia({
						audio: {
							deviceId: deviceId ? { exact: deviceId } : undefined,
							echoCancellation: true,
							noiseSuppression: true
						}
					})
				);
			}
			if (this.disposed) {
				this.releaseAudio();
				return;
			}
			await this.refreshDevices();
			const name = `Recording ${new SvelteDate().toLocaleString()}`;
			const response = await checked(
				await fetch(`/api/projects/${projectId}/recordings`, {
					method: 'POST',
					headers: { 'content-type': 'application/json', 'x-studyloom-interaction': '1' },
					body: JSON.stringify({ name, source })
				})
			);
			const { materialId } = await response.json();
			if (typeof materialId !== 'string') throw new Error('The server did not create a recording.');
			this.recording = {
				id: materialId,
				projectId,
				name,
				source,
				createdAt: new SvelteDate().toISOString(),
				nextSequence: 0,
				samples: 0
			};
			await saveRecording(this.recording);
			this.context = new AudioContext();
			await this.context.audioWorklet.addModule('/audio-worklet.js');
			this.processor = new AudioWorkletNode(this.context, 'studyloom-pcm');
			this.processor.port.onmessage = ({ data }) => {
				if (data.type === 'flushed') this.flushDone?.();
				if (data.type === 'pcm' && data.pcm instanceof ArrayBuffer) this.enqueue(data.pcm);
			};
			const mixer = this.context.createGain();
			mixer.gain.value = 1 / this.streams.length;
			for (const stream of this.streams) {
				this.context
					.createMediaStreamSource(new MediaStream(stream.getAudioTracks()))
					.connect(mixer);
				for (const track of stream.getTracks())
					track.onended = () => {
						void this.sourceEnded();
					};
			}
			mixer.connect(this.processor);
			// Worklet outputs silence: connecting it keeps processing alive without feedback.
			this.processor.connect(this.context.destination);
			await this.openStream();
			await this.context.resume();
			this.beginCapture();
		} catch (error) {
			this.error = this.explain(error);
			this.closeSocket();
			this.releaseAudio();
			this.state = this.recording ? 'interrupted' : 'idle';
		}
	}

	private enqueue(pcm: ArrayBuffer) {
		if (!this.recording) return;
		const chunk = {
			recordingId: this.recording.id,
			sequence: this.recording.nextSequence,
			startSample: this.recording.samples,
			pcm
		};
		this.recording = {
			...this.recording,
			nextSequence: chunk.sequence + 1,
			samples: chunk.startSample + pcm.byteLength / 2
		};
		const metadata = this.recording;
		this.samples = metadata.samples;
		this.pending++;
		this.writing = this.writing
			.then(async () => {
				if (this.storageFailure) throw new Error('Local audio storage is unavailable.');
				await storeChunk(metadata, chunk);
				if (this.ready && this.socket?.readyState === WebSocket.OPEN) {
					if (this.socket.bufferedAmount > 480000) {
						this.socket.close();
						return;
					}
					const frame = new Uint8Array(pcm.byteLength + 4);
					new DataView(frame.buffer).setUint32(0, chunk.sequence, true);
					frame.set(new Uint8Array(pcm), 4);
					this.socket.send(frame);
				}
			})
			.catch((error) => {
				this.unsavedChunks.push({ metadata, chunk });
				this.storageFailure = true;
				this.error = `Recording paused because audio could not be saved locally: ${this.explain(error)}`;
				void this.interrupt();
			});
	}

	private openStream() {
		this.closeSocket();
		const recording = this.recording!;
		const socket = new WebSocket(
			`${location.protocol === 'https:' ? 'wss:' : 'ws:'}//${location.host}/api/recordings/${recording.id}/stream`
		);
		this.socket = socket;
		return new Promise<void>((resolve, reject) => {
			const timeout = setTimeout(() => {
				reject(new Error('The transcription connection timed out. Your audio is saved locally.'));
				socket.close();
			}, 20000);
			socket.onopen = () =>
				socket.send(
					JSON.stringify({
						type: 'start',
						segmentId: crypto.randomUUID(),
						startSample: recording.samples
					})
				);
			socket.onmessage = ({ data }) => {
				if (typeof data !== 'string') return;
				let event: Record<string, unknown>;
				try {
					event = JSON.parse(data);
				} catch {
					return;
				}
				if (event.type === 'ready') {
					clearTimeout(timeout);
					if (event.nextSequence !== recording.nextSequence) {
						reject(new Error('Audio synchronization is incomplete. Retry saving this recording.'));
						socket.close();
						return;
					}
					this.ready = true;
					resolve();
				}
				if (event.type === 'ack' && typeof event.sequence === 'number') {
					void acknowledgeChunk(recording.id, event.sequence)
						.then(async () => {
							this.pending = (await countPendingChunks(recording.id)) + this.unsavedChunks.length;
						})
						.catch((error) => {
							this.error = this.explain(error);
						});
				}
				if (event.type === 'transcript' && typeof event.text === 'string') {
					const id =
						typeof event.turnId === 'string'
							? event.turnId
							: this.currentTurn || `local-${++this.turnSerial}`;
					this.currentTurn = event.final ? '' : id;
					const turn: TranscriptTurn = {
						id,
						text: event.text,
						final: event.final === true,
						speaker: typeof event.speaker === 'string' ? event.speaker : undefined
					};
					this.turns = [...this.turns.filter((item) => item.id !== id), turn].slice(-100);
				}
				if (event.type === 'status' && typeof event.message === 'string')
					this.message = event.message;
				if (event.type === 'error') {
					this.error =
						typeof event.message === 'string'
							? event.message
							: 'Transcription failed. Your audio is saved.';
					clearTimeout(timeout);
					reject(new Error(this.error));
					socket.close();
				}
				if (event.type === 'paused' || event.type === 'stopped') this.endDone?.(event.type);
			};
			socket.onerror = () => {
				clearTimeout(timeout);
				reject(
					new Error('Unable to connect to transcription. Check your connection and try Resume.')
				);
			};
			socket.onclose = () => {
				clearTimeout(timeout);
				this.ready = false;
				reject(new Error('The transcription connection closed.'));
				if (this.state === 'recording') void this.interrupt();
			};
		});
	}

	private beginCapture() {
		this.streams
			.flatMap((stream) => stream.getAudioTracks())
			.forEach((track) => {
				track.enabled = true;
			});
		this.processor?.port.postMessage({ type: 'start' });
		this.state = 'recording';
		this.message = 'Recording and transcribing';
		this.rotation = setTimeout(
			() => {
				void this.rotate();
			},
			55 * 60 * 1000
		);
	}

	private async rotate() {
		if (this.state !== 'recording') return;
		await this.pause();
		await this.resume(false);
	}

	private async flush() {
		clearTimeout(this.rotation);
		if (this.processor) {
			await new Promise<void>((resolve) => {
				const timeout = setTimeout(resolve, 2000);
				this.flushDone = () => {
					clearTimeout(timeout);
					this.flushDone = undefined;
					resolve();
				};
				this.processor!.port.postMessage({ type: 'pause' });
			});
		}
		this.streams
			.flatMap((stream) => stream.getAudioTracks())
			.forEach((track) => {
				track.enabled = false;
			});
		await this.writing;
	}

	private async drain() {
		await this.writing;
		const deadline = Date.now() + 15000;
		while (this.pending > 0 && this.ready && Date.now() < deadline)
			await new Promise((resolve) => setTimeout(resolve, 100));
		if (this.pending)
			throw new Error(
				'Some audio is still saved only in this browser. Retry saving when connected.'
			);
	}

	private async endStream(type: 'pause' | 'stop') {
		if (!this.ready || this.socket?.readyState !== WebSocket.OPEN)
			throw new Error('The transcription connection is interrupted.');
		await new Promise<void>((resolve, reject) => {
			const timeout = setTimeout(() => {
				this.endDone = undefined;
				reject(new Error('Transcription did not finish in time. Retry saving your recording.'));
			}, 20000);
			this.endDone = (received) => {
				if (received !== (type === 'pause' ? 'paused' : 'stopped')) return;
				clearTimeout(timeout);
				this.endDone = undefined;
				resolve();
			};
			this.socket!.send(JSON.stringify({ type }));
		});
		this.closeSocket();
	}

	async pause() {
		if (this.state !== 'recording') return;
		this.state = 'pausing';
		this.message = 'Saving the last audio…';
		try {
			await this.flush();
			await this.drain();
			await this.endStream('pause');
			this.state = 'paused';
			this.message = 'Paused. No audio is being recorded.';
		} catch (error) {
			this.error = this.explain(error);
			this.closeSocket();
			this.state = 'interrupted';
		}
	}

	private async interrupt() {
		if (this.state === 'interrupted' || this.disposed) return;
		this.state = 'interrupted';
		this.ready = false;
		await this.flush();
		this.closeSocket();
		this.message = 'Recording paused. Saved audio can be recovered when you reconnect.';
	}

	private async sourceEnded() {
		if (this.state === 'recording') await this.pause();
		this.message =
			'The audio source stopped. Save this recording, then start another to capture a new source.';
	}

	private async recoverAudio(finalize: boolean, userInteraction: boolean) {
		if (!this.recording) return;
		await this.writing;
		while (this.unsavedChunks.length) {
			const { metadata, chunk } = this.unsavedChunks[0];
			await storeChunk(metadata, chunk);
			this.unsavedChunks.shift();
		}
		this.storageFailure = false;
		let chunk: AudioChunk | undefined;
		while ((chunk = await firstPendingChunk(this.recording.id))) {
			await checked(
				await fetch(`/api/recordings/${this.recording.id}/chunks/${chunk.sequence}`, {
					method: 'PUT',
					headers: {
						'content-type': 'application/octet-stream',
						'x-start-sample': String(chunk.startSample)
					},
					body: chunk.pcm
				})
			);
			await acknowledgeChunk(this.recording.id, chunk.sequence);
			this.pending = Math.max(0, this.pending - 1);
		}
		const response = await checked(
			await fetch(`/api/recordings/${this.recording.id}/recover`, {
				method: 'POST',
				headers: {
					'content-type': 'application/json',
					...(userInteraction ? { 'x-studyloom-interaction': '1' } : {})
				},
				body: JSON.stringify({ finalize })
			})
		);
		if (!finalize) {
			const { jobId } = await response.json();
			if (typeof jobId !== 'string' || !jobId)
				throw new Error('The server did not schedule audio recovery. Retry saving the recording.');
			await waitForRecoveryJob(
				jobId,
				(progress) => {
					this.message = progress;
				},
				this.lifecycle.signal
			);
		}
	}

	async resume(userInteraction = true) {
		if (!['paused', 'interrupted'].includes(this.state)) return;
		this.error = '';
		if (
			!this.processor ||
			this.streams.some((stream) =>
				stream.getAudioTracks().some((track) => track.readyState === 'ended')
			)
		) {
			this.error =
				'The audio source is no longer available. Save this recording and start a new one.';
			return;
		}
		if (this.storageFailure) {
			this.error =
				'Local storage failed. Save the captured audio before starting another recording.';
			return;
		}
		const interrupted = this.state === 'interrupted';
		this.state = 'starting';
		this.message = 'Reconnecting…';
		try {
			if (interrupted) await this.recoverAudio(false, userInteraction);
			await this.openStream();
			await this.context?.resume();
			this.beginCapture();
		} catch (error) {
			this.error = this.explain(error);
			this.state = 'interrupted';
			this.closeSocket();
		}
	}

	async stop(): Promise<string | undefined> {
		if (!this.recording || ['starting', 'pausing', 'saving'].includes(this.state)) return;
		const wasLive = this.state === 'recording';
		this.state = 'saving';
		this.error = '';
		this.message = 'Saving recording…';
		try {
			await this.flush();
			if (wasLive && this.ready) {
				await this.drain();
				await this.endStream('stop');
			} else {
				this.closeSocket();
				await this.recoverAudio(true, true);
			}
			const id = this.recording.id;
			await removeRecording(id);
			this.unfinished = this.unfinished.filter((item) => item.id !== id);
			this.recording = undefined;
			this.pending = 0;
			this.releaseAudio();
			this.state = 'complete';
			this.message = 'Recording saved.';
			return id;
		} catch (error) {
			this.error = this.explain(error);
			this.closeSocket();
			this.releaseAudio();
			this.state = 'interrupted';
		}
	}

	async recover(recording: LocalRecording): Promise<string | undefined> {
		if (!['idle', 'complete', 'interrupted'].includes(this.state) || this.streams.length) return;
		this.recording = recording;
		this.samples = recording.samples;
		this.pending = await countPendingChunks(recording.id);
		return this.stop();
	}

	private closeSocket() {
		this.ready = false;
		if (this.socket) {
			this.socket.onclose = null;
			this.socket.close();
			this.socket = undefined;
		}
	}

	private releaseAudio() {
		clearTimeout(this.rotation);
		for (const stream of this.streams)
			for (const track of stream.getTracks()) {
				track.onended = null;
				track.stop();
			}
		this.streams = [];
		this.processor?.disconnect();
		this.processor = undefined;
		if (this.context) {
			void this.context.close().catch(() => {});
			this.context = undefined;
		}
	}

	destroy() {
		this.disposed = true;
		this.lifecycle.abort();
		this.closeSocket();
		this.releaseAudio();
	}

	private explain(error: unknown) {
		if (error instanceof DOMException && error.name === 'NotAllowedError')
			return 'Audio access was not granted. Allow microphone or tab sharing, then try again.';
		if (error instanceof DOMException && error.name === 'NotFoundError')
			return 'No audio input was found. Connect a microphone or choose tab audio.';
		return error instanceof Error ? error.message : 'Recording failed. Please try again.';
	}
}
