import type { StudyVerdict } from '#lib/domain.js';
import { PcmPlayer } from './pcm-player.js';

export type StudyPhase =
	'connecting' | 'presenting' | 'listening' | 'thinking' | 'feedback' | 'complete' | 'stopped';
/** 0.1 s microphone frames keep the end of an answer from waiting on a full second. */
const FRAME_SAMPLES = 2400;
const BEEP_MS = 200;

/**
 * The browser side of a spoken study session: plays what the tutor says, and streams the
 * microphone only while the tutor listens, so its own voice is never transcribed.
 */
export class TutorSession {
	phase = $state<StudyPhase>('connecting');
	segment = $state(0);
	segments = $state(0);
	attempt = $state(1);
	title = $state('');
	/** What the tutor is saying now. */
	caption = $state('');
	/** The learner's answer as it is being transcribed. */
	partial = $state('');
	verdict = $state<StudyVerdict | null>(null);
	speaking = $state(false);
	error = $state('');
	private context: AudioContext | undefined;
	private player: PcmPlayer | undefined;
	private processor: AudioWorkletNode | undefined;
	private microphone: MediaStream | undefined;
	private socket: WebSocket | undefined;
	private gateOpen = false;
	private gateTimer: ReturnType<typeof setTimeout> | undefined;
	/** Called once the connection has closed, finished or not. */
	constructor(private readonly onClosed: () => void = () => {}) {}

	/**
	 * Must run inside the click that starts the session, so the browser allows audio; `openRun`
	 * creates or continues the run once audio is unlocked.
	 */
	async start(outputId: string, openRun: () => Promise<string>) {
		this.error = '';
		this.phase = 'connecting';
		try {
			if (!navigator.mediaDevices || !window.isSecureContext)
				throw new Error('Study sessions need HTTPS and a browser with microphone support.');
			this.context = new AudioContext();
			const resumed = this.context.resume();
			this.microphone = await navigator.mediaDevices.getUserMedia({
				audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true }
			});
			await resumed;
			await this.context.audioWorklet.addModule('/audio-worklet.js');
			this.processor = new AudioWorkletNode(this.context, 'studyloom-pcm', {
				processorOptions: { frameSamples: FRAME_SAMPLES }
			});
			this.processor.port.onmessage = ({ data }) => {
				if (data.type === 'pcm' && this.gateOpen && this.socket?.readyState === WebSocket.OPEN)
					this.socket.send(data.pcm);
			};
			this.context.createMediaStreamSource(this.microphone).connect(this.processor);
			// Worklet outputs silence: connecting it keeps processing alive without feedback.
			this.processor.connect(this.context.destination);
			this.player = new PcmPlayer(this.context, (clip) => {
				this.speaking = false;
				this.sendJson({ type: 'played', clip });
			});
			this.connect(outputId, await openRun());
		} catch (cause) {
			this.error =
				cause instanceof DOMException && cause.name === 'NotAllowedError'
					? 'Allow microphone access to answer out loud.'
					: cause instanceof Error
						? cause.message
						: 'The study session could not start.';
			this.phase = 'stopped';
			this.release();
			this.onClosed();
		}
	}
	/** Space or the big button: skip what the tutor is saying, or finish the answer now. */
	primary() {
		if (this.speaking) this.skip();
		else if (this.phase === 'listening') this.sendJson({ type: 'done' });
	}
	skip() {
		this.player?.stop();
		this.speaking = false;
		this.sendJson({ type: 'skip' });
	}
	end() {
		this.player?.stop();
		this.closeGate();
		this.sendJson({ type: 'end' });
	}
	dispose() {
		this.socket?.close();
		this.release();
	}

	private connect(outputId: string, runId: string) {
		const scheme = location.protocol === 'https:' ? 'wss:' : 'ws:';
		const socket = new WebSocket(
			`${scheme}//${location.host}/api/outputs/${outputId}/runs/${runId}/stream`
		);
		socket.binaryType = 'arraybuffer';
		this.socket = socket;
		socket.onmessage = ({ data }) => {
			if (data instanceof ArrayBuffer) return this.player?.push(data);
			this.handle(JSON.parse(data));
		};
		socket.onclose = () => {
			if (this.socket !== socket) return;
			if (this.phase !== 'complete') {
				this.error ||= 'The connection was lost. Resume to continue where you stopped.';
				this.phase = 'stopped';
			}
			this.release();
			this.onClosed();
		};
	}
	private handle(event: Record<string, unknown>) {
		switch (event.type) {
			case 'state':
				this.segment = Number(event.segment);
				this.segments = Number(event.segments);
				this.attempt = Number(event.attempt);
				this.title = String(event.title ?? '');
				this.phase = event.phase as StudyPhase;
				if (this.phase === 'presenting') this.verdict = null;
				break;
			case 'clip':
				this.closeGate();
				this.speaking = true;
				this.caption = String(event.text ?? '');
				if (event.kind === 'feedback' || event.kind === 'wrapup') this.phase = 'feedback';
				this.player?.begin(String(event.clip));
				break;
			case 'caption':
				this.caption = this.caption ? `${this.caption} ${event.text}` : String(event.text);
				break;
			case 'clipEnd':
				this.player?.finish(String(event.clip));
				break;
			case 'listen':
				this.partial = '';
				this.caption = '';
				this.phase = 'listening';
				this.player?.beep();
				// Open the microphone after the cue, so it does not land in the answer.
				this.gateTimer = setTimeout(() => this.openGate(), BEEP_MS);
				break;
			case 'partial':
				this.partial = String(event.text ?? '');
				break;
			case 'heard':
				this.closeGate();
				this.partial = String(event.text ?? '');
				break;
			case 'result':
				this.verdict = event.verdict as StudyVerdict;
				break;
			case 'complete':
				this.phase = 'complete';
				this.caption = '';
				break;
			case 'error':
				this.error = String(event.message ?? 'The study session stopped.');
				break;
		}
	}
	private openGate() {
		this.gateOpen = true;
		this.processor?.port.postMessage({ type: 'start' });
	}
	private closeGate() {
		clearTimeout(this.gateTimer);
		if (!this.gateOpen) return;
		this.gateOpen = false;
		this.processor?.port.postMessage({ type: 'pause' });
	}
	private sendJson(value: unknown) {
		if (this.socket?.readyState === WebSocket.OPEN) this.socket.send(JSON.stringify(value));
	}
	private release() {
		this.closeGate();
		this.player?.stop();
		for (const track of this.microphone?.getTracks() ?? []) track.stop();
		void this.context?.close().catch(() => {});
		this.context = this.processor = this.player = this.microphone = undefined;
		this.speaking = false;
	}
}
