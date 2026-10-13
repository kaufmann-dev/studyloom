/** Rate of every clip the study session streams: signed 16-bit mono PCM. */
const SAMPLE_RATE = 24_000;
const LEAD_SECONDS = 0.05;

/**
 * Plays streamed PCM clips gaplessly: each frame is scheduled right after the previous one,
 * and a clip counts as played once its last frame has finished sounding.
 */
export class PcmPlayer {
	private next = 0;
	private sources = new Set<AudioBufferSourceNode>();
	private clip: string | undefined;
	private ending: string | undefined;
	constructor(
		private readonly context: BaseAudioContext,
		private readonly onDrained: (clip: string) => void
	) {}
	begin(clip: string) {
		this.clip = clip;
		this.ending = undefined;
	}
	push(bytes: ArrayBuffer) {
		if (!this.clip || bytes.byteLength < 2) return;
		const samples = new Int16Array(bytes, 0, Math.floor(bytes.byteLength / 2));
		const buffer = this.context.createBuffer(1, samples.length, SAMPLE_RATE);
		const channel = buffer.getChannelData(0);
		for (let i = 0; i < samples.length; i++) channel[i] = samples[i] / 32768;
		const source = this.context.createBufferSource();
		source.buffer = buffer;
		source.connect(this.context.destination);
		const at = Math.max(this.next, this.context.currentTime + LEAD_SECONDS);
		source.start(at);
		this.next = at + buffer.duration;
		this.sources.add(source);
		source.onended = () => {
			this.sources.delete(source);
			this.settle();
		};
	}
	/** No more audio follows for this clip; `onDrained` fires once it has played out. */
	finish(clip: string) {
		if (clip !== this.clip) return;
		this.ending = clip;
		this.settle();
	}
	/** Silences everything at once and ignores the rest of the current clip. */
	stop() {
		for (const source of this.sources) {
			source.onended = null;
			source.stop();
		}
		this.sources.clear();
		this.clip = this.ending = undefined;
		this.next = 0;
	}
	/** A short cue that the tutor is listening now. */
	beep() {
		const oscillator = this.context.createOscillator();
		const gain = this.context.createGain();
		oscillator.frequency.value = 880;
		gain.gain.setValueAtTime(0.15, this.context.currentTime);
		gain.gain.exponentialRampToValueAtTime(0.001, this.context.currentTime + 0.15);
		oscillator.connect(gain).connect(this.context.destination);
		oscillator.start();
		oscillator.stop(this.context.currentTime + 0.15);
	}
	private settle() {
		if (!this.ending || this.sources.size) return;
		const clip = this.ending;
		this.clip = this.ending = undefined;
		this.onDrained(clip);
	}
}
