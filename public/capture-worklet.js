// Runs on the audio thread of the host's browser. Collects the shared tab's
// audio into fixed-size chunks of 16-bit stereo PCM and hands them to the page.
class CaptureProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();
    const opts = (options && options.processorOptions) || {};
    this.chunk = opts.chunk || 2048;
    this.channels = opts.channels || 2;
    this.buf = new Int16Array(this.chunk * this.channels);
    this.n = 0;
  }

  process(inputs) {
    const input = inputs[0] || [];
    const frames = input.length ? input[0].length : 128;
    const ch = this.channels;
    for (let i = 0; i < frames; i++) {
      for (let c = 0; c < ch; c++) {
        const data = input[c] || input[0];
        let s = data ? data[i] : 0;
        s = s < -1 ? -1 : s > 1 ? 1 : s;
        this.buf[this.n * ch + c] = s < 0 ? s * 0x8000 : s * 0x7fff;
      }
      if (++this.n === this.chunk) {
        this.port.postMessage(this.buf.buffer, [this.buf.buffer]);
        this.buf = new Int16Array(this.chunk * ch);
        this.n = 0;
      }
    }
    return true;
  }
}

registerProcessor('capture-processor', CaptureProcessor);
