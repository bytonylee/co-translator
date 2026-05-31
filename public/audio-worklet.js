class Pcm16Downsampler extends AudioWorkletProcessor {
  constructor(options) {
    super();
    this.targetSampleRate = options.processorOptions.targetSampleRate || 24000;
    this.chunkSamples = Math.max(48, Math.floor((this.targetSampleRate * (options.processorOptions.chunkMs || 20)) / 1000));
    this.inputSampleRate = sampleRate;
    this.ratio = this.inputSampleRate / this.targetSampleRate;
    this.pending = [];
    this.nextInputIndex = 0;
  }

  process(inputs) {
    const input = inputs[0]?.[0];
    if (!input) {
      return true;
    }

    let nextInputIndex = this.nextInputIndex;
    for (; nextInputIndex < input.length; nextInputIndex += this.ratio) {
      const sample = input[Math.floor(nextInputIndex)];
      const clipped = Math.max(-1, Math.min(1, sample));
      this.pending.push(clipped < 0 ? clipped * 0x8000 : clipped * 0x7fff);
    }
    this.nextInputIndex = nextInputIndex - input.length;

    while (this.pending.length >= this.chunkSamples) {
      const samples = this.pending.splice(0, this.chunkSamples);
      let sumSquares = 0;
      for (let index = 0; index < samples.length; index += 1) {
        const normalized = samples[index] / 0x8000;
        sumSquares += normalized * normalized;
      }
      const pcm = new Int16Array(samples);
      this.port.postMessage(
        {
          buffer: pcm.buffer,
          rms: Math.sqrt(sumSquares / samples.length)
        },
        [pcm.buffer]
      );
    }

    return true;
  }
}

registerProcessor("pcm16-downsampler", Pcm16Downsampler);
