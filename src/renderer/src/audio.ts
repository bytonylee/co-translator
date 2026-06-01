import type { AudioChunk, LatencyMode } from "../../shared/types";

export type AudioStreamer = {
  stop(): Promise<void>;
};

const TARGET_SAMPLE_RATE = 24000;
const SPEECH_RMS_THRESHOLD = 0.006;
const PRE_ROLL_MS = 120;
const SILENCE_HOLD_MS = 500;

function chunkMsForLatency(mode: LatencyMode) {
  if (mode === "fast") {
    return 2.5;
  }
  if (mode === "stable") {
    return 40;
  }
  return 20;
}

export async function createAudioStreamer(
  deviceId: string,
  latencyMode: LatencyMode,
  onAudio: (chunk: AudioChunk) => void
): Promise<AudioStreamer> {
  const stream = await createAudioInputStream(deviceId, latencyMode);
  return createAudioStreamerFromStream(stream, latencyMode, onAudio, true);
}

export async function createAudioInputStream(deviceId: string, latencyMode: LatencyMode): Promise<MediaStream> {
  return navigator.mediaDevices.getUserMedia({
    audio: {
      deviceId: deviceId ? { exact: deviceId } : undefined,
      echoCancellation: latencyMode !== "fast",
      noiseSuppression: latencyMode !== "fast",
      autoGainControl: latencyMode !== "fast",
      channelCount: 1,
      sampleRate: TARGET_SAMPLE_RATE
    }
  });
}

export async function createAudioStreamerFromStream(
  stream: MediaStream,
  latencyMode: LatencyMode,
  onAudio: (chunk: AudioChunk) => void,
  stopTracks = false
): Promise<AudioStreamer> {
  const chunkMs = chunkMsForLatency(latencyMode);
  const preRollLimit = Math.max(1, Math.ceil(PRE_ROLL_MS / chunkMs));
  const silenceHoldLimit = Math.max(1, Math.ceil(SILENCE_HOLD_MS / chunkMs));
  let speechStartedAt: number | undefined;
  let speaking = false;
  let silentChunks = 0;
  const preRoll: AudioChunk[] = [];

  const audioContext = new AudioContext({
    latencyHint: "interactive",
    sampleRate: TARGET_SAMPLE_RATE
  });
  await audioContext.audioWorklet.addModule(new URL("audio-worklet.js", window.location.href).href);
  const source = audioContext.createMediaStreamSource(stream);
  const processor = new AudioWorkletNode(audioContext, "pcm16-downsampler", {
    processorOptions: {
      targetSampleRate: TARGET_SAMPLE_RATE,
      chunkMs
    }
  });
  const mutedOutput = audioContext.createGain();
  mutedOutput.gain.value = 0;

  processor.port.onmessage = (event: MessageEvent<{ buffer: ArrayBuffer; rms: number }>) => {
    const capturedAt = Date.now();
    const isSpeech = event.data.rms >= SPEECH_RMS_THRESHOLD;
    if (speechStartedAt === undefined && isSpeech) {
      speechStartedAt = capturedAt;
    }
    const chunk = {
      base64Pcm16: arrayBufferToBase64(event.data.buffer),
      capturedAt,
      speechStartedAt,
      chunkMs,
      rms: event.data.rms
    };

    if (latencyMode === "fast") {
      onAudio(chunk);
      return;
    }

    if (isSpeech) {
      silentChunks = 0;
      if (!speaking) {
        speaking = true;
        for (const queuedChunk of preRoll) {
          onAudio({
            ...queuedChunk,
            speechStartedAt
          });
        }
        preRoll.length = 0;
      }
      onAudio({
        ...chunk,
        speechStartedAt
      });
      return;
    }

    if (speaking) {
      silentChunks += 1;
      onAudio({
        ...chunk,
        speechStartedAt
      });
      if (silentChunks >= silenceHoldLimit) {
        speaking = false;
        speechStartedAt = undefined;
        silentChunks = 0;
      }
      return;
    }

    preRoll.push(chunk);
    if (preRoll.length > preRollLimit) {
      preRoll.shift();
    }
  };

  source.connect(processor);
  processor.connect(mutedOutput);
  mutedOutput.connect(audioContext.destination);

  return {
    async stop() {
      processor.disconnect();
      mutedOutput.disconnect();
      source.disconnect();
      if (stopTracks) {
        stream.getTracks().forEach((track) => track.stop());
      }
      await audioContext.close();
    }
  };
}

function arrayBufferToBase64(buffer: ArrayBuffer) {
  const bytes = new Uint8Array(buffer);
  let binary = "";
  for (let i = 0; i < bytes.byteLength; i += 1) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}
