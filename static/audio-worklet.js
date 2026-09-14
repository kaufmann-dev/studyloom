/* global AudioWorkletProcessor, sampleRate, registerProcessor */
// Integrate the source waveform across output intervals to resample to 24 kHz.
// Output frames are exactly one second, except the explicitly flushed final frame.
class StudyloomPCMProcessor extends AudioWorkletProcessor {
	constructor() {
		super();
		this.active = false;
		this.ratio = sampleRate / 24000;
		this.remaining = this.ratio;
		this.integral = 0;
		this.frame = new ArrayBuffer(48000);
		this.view = new DataView(this.frame);
		this.position = 0;
		this.port.onmessage = ({ data }) => {
			if (data.type === 'start') this.active = true;
			if (data.type === 'pause') {
				this.active = false;
				this.flush();
				this.integral = 0;
				this.remaining = this.ratio;
				this.port.postMessage({ type: 'flushed' });
			}
		};
	}
	flush() {
		if (!this.position) return;
		const pcm = this.frame.slice(0, this.position * 2);
		this.port.postMessage({ type: 'pcm', pcm }, [pcm]);
		this.position = 0;
	}
	process(inputs) {
		if (!this.active || !inputs[0]?.length) return true;
		const channels = inputs[0];
		for (let i = 0; i < channels[0].length; i++) {
			let mono = 0;
			for (const channel of channels) mono += channel[i] / channels.length;
			let width = 1;
			while (width > 1e-9) {
				const contribution = Math.min(width, this.remaining);
				this.integral += mono * contribution;
				this.remaining -= contribution;
				width -= contribution;
				if (this.remaining < 1e-9) {
					const sample = Math.max(-1, Math.min(1, this.integral / this.ratio));
					this.view.setInt16(this.position++ * 2, Math.round(sample * (sample < 0 ? 32768 : 32767)), true);
					this.integral = 0;
					this.remaining = this.ratio;
					if (this.position === 24000) this.flush();
				}
			}
		}
		return true;
	}
}

registerProcessor('studyloom-pcm', StudyloomPCMProcessor);
