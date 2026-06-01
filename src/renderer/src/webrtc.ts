import type { LatencySnapshot } from "../../shared/types";

export type WebRtcTranslator = {
  stop(): Promise<void>;
};

type WebRtcTranslatorOptions = {
  clientSecret: string;
  deviceId: string;
  sourceStream?: MediaStream;
  onConnected: () => void;
  onSpeechActivity: (speechStartedAt: number, rms: number) => void;
  onSourceTranscript: (text: string, final: boolean) => void;
  onTargetTranslation: (text: string, final: boolean) => void;
  onLatency: (snapshot: LatencySnapshot) => void;
  onError: (message: string) => void;
  log: (event: string, data?: Record<string, unknown>) => void;
};

const SPEECH_RMS_THRESHOLD = 0.006;
const SPEECH_END_RMS_THRESHOLD = 0.003;
const SPEECH_END_HOLD_MS = 240;

export async function getWebRtcSourceStream(deviceId: string) {
  return navigator.mediaDevices.getUserMedia({
    audio: {
      deviceId: deviceId ? { exact: deviceId } : undefined,
      echoCancellation: false,
      noiseSuppression: false,
      autoGainControl: false,
      channelCount: 1
    }
  });
}

export async function createWebRtcTranslator(options: WebRtcTranslatorOptions): Promise<WebRtcTranslator> {
  const connectStartedAt = Date.now();
  let stopped = false;
  let finalizedSourceText = "";
  let finalizedTargetText = "";
  let sourceSegmentText = "";
  let targetSegmentText = "";
  let firstSpeechAt: number | undefined;
  let lastSpeechAt: number | undefined;
  let speechEndedAt: number | undefined;
  let firstTargetTranscriptAt: number | undefined;
  let localAnimationFrame = 0;
  let localAudioContext: AudioContext | undefined;
  const seenEventTypes = new Set<string>();
  let latencySnapshot = createLatencySnapshot({});

  const stream = options.sourceStream || await getWebRtcSourceStream(options.deviceId);

  startLocalSpeechDetector(stream);

  const pc = new RTCPeerConnection();
  for (const track of stream.getAudioTracks()) {
    pc.addTrack(track, stream);
  }

  pc.onconnectionstatechange = () => {
    options.log("webrtc_connection_state", {
      state: pc.connectionState
    });
    if (pc.connectionState === "failed" || pc.connectionState === "disconnected") {
      options.onError(`WebRTC ${pc.connectionState}`);
    }
  };

  const events = pc.createDataChannel("oai-events");
  events.onopen = () => {
    options.log("webrtc_data_channel_open", {
      connectMs: Date.now() - connectStartedAt
    });
  };
  events.onmessage = ({ data }) => {
    if (typeof data !== "string") {
      return;
    }
    handleRealtimeEvent(data);
  };
  events.onerror = () => {
    options.log("webrtc_data_channel_error");
  };

  const offer = await pc.createOffer();
  await pc.setLocalDescription(offer);
  const sdpResponse = await fetch("https://api.openai.com/v1/realtime/translations/calls", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${options.clientSecret}`,
      "Content-Type": "application/sdp"
    },
    body: offer.sdp
  });

  if (!sdpResponse.ok) {
    const message = await sdpResponse.text();
    pc.close();
    stream.getTracks().forEach((track) => track.stop());
    await localAudioContext?.close().catch(() => undefined);
    throw new Error(message);
  }

  await pc.setRemoteDescription({
    type: "answer",
    sdp: await sdpResponse.text()
  });

  options.log("webrtc_remote_description_set", {
    connectMs: Date.now() - connectStartedAt
  });
  options.onConnected();

  return {
    async stop() {
      stopped = true;
      if (localAnimationFrame) {
        cancelAnimationFrame(localAnimationFrame);
      }
      events.close();
      pc.close();
      stream.getTracks().forEach((track) => track.stop());
      await localAudioContext?.close().catch(() => undefined);
    }
  };

  function handleRealtimeEvent(raw: string) {
    let event: Record<string, unknown>;
    try {
      event = JSON.parse(raw) as Record<string, unknown>;
    } catch {
      return;
    }

    if (typeof event.type === "string" && !seenEventTypes.has(event.type)) {
      seenEventTypes.add(event.type);
      options.log("webrtc_event_type_seen", {
        type: event.type
      });
    }

    if (event.type === "error") {
      const error = event.error as { message?: string } | undefined;
      options.onError(error?.message || "Realtime API error");
      return;
    }

    if (event.type === "session.input_transcript.delta") {
      const delta = typeof event.delta === "string" ? event.delta : "";
      if (delta) {
        sourceSegmentText += delta;
        options.onSourceTranscript(joinTranscript(finalizedSourceText, sourceSegmentText), false);
      }
      return;
    }

    if (event.type === "session.input_transcript.done") {
      const transcript = typeof event.transcript === "string" ? event.transcript : sourceSegmentText;
      if (transcript) {
        finalizedSourceText = joinTranscript(finalizedSourceText, transcript);
        sourceSegmentText = "";
        options.onSourceTranscript(finalizedSourceText, true);
      }
      return;
    }

    if (event.type === "session.output_transcript.delta") {
      const delta = typeof event.delta === "string" ? event.delta : "";
      if (delta) {
        targetSegmentText += delta;
        if (firstSpeechAt !== undefined && firstTargetTranscriptAt === undefined) {
          const now = Date.now();
          firstTargetTranscriptAt = now;
          options.log("first_target_transcript_delta", {
            speechToTargetMs: firstTargetTranscriptAt - firstSpeechAt,
            speechEndToTargetMs: speechEndedAt === undefined ? undefined : firstTargetTranscriptAt - speechEndedAt,
            deltaChars: delta.length,
            transport: "webrtc"
          });
          publishLatency({
            speechToTargetMs: firstTargetTranscriptAt - firstSpeechAt,
            speechEndToTargetMs: speechEndedAt === undefined ? undefined : firstTargetTranscriptAt - speechEndedAt,
            rootCause: "Streaming translated text"
          });
        }
        options.onTargetTranslation(joinTranscript(finalizedTargetText, targetSegmentText), false);
      }
      return;
    }

    if (event.type === "session.output_transcript.done") {
      const transcript = typeof event.transcript === "string" ? event.transcript : targetSegmentText;
      if (transcript) {
        finalizedTargetText = joinTranscript(finalizedTargetText, transcript);
        targetSegmentText = "";
        options.onTargetTranslation(finalizedTargetText, true);
      }
    }
  }

  function startLocalSpeechDetector(sourceStream: MediaStream) {
    localAudioContext = new AudioContext({ latencyHint: "interactive" });
    void localAudioContext.resume().catch(() => undefined);
    const analyser = localAudioContext.createAnalyser();
    analyser.fftSize = 512;
    localAudioContext.createMediaStreamSource(sourceStream).connect(analyser);
    const samples = new Float32Array(analyser.fftSize);

    const tick = () => {
      if (stopped) {
        return;
      }
      analyser.getFloatTimeDomainData(samples);
      const rms = calculateRms(samples);
      const now = Date.now();
      if (firstSpeechAt === undefined && rms >= SPEECH_RMS_THRESHOLD) {
        firstSpeechAt = now;
        options.log("local_speech_detected", {
          rms,
          transport: "webrtc"
        });
        options.onSpeechActivity(firstSpeechAt, rms);
        publishLatency({
          rootCause: "Speech detected locally"
        });
      }
      if (firstSpeechAt !== undefined) {
        if (rms >= SPEECH_END_RMS_THRESHOLD) {
          lastSpeechAt = now;
          speechEndedAt = undefined;
        } else if (lastSpeechAt !== undefined && speechEndedAt === undefined && now - lastSpeechAt >= SPEECH_END_HOLD_MS) {
          speechEndedAt = lastSpeechAt;
          options.log("local_speech_ended", {
            speechDurationMs: speechEndedAt - firstSpeechAt,
            transport: "webrtc"
          });
        }
      }
      localAnimationFrame = requestAnimationFrame(tick);
    };
    tick();
  }

  function publishLatency(partial: Partial<LatencySnapshot>) {
    latencySnapshot = {
      ...latencySnapshot,
      ...partial
    };
    options.onLatency(latencySnapshot);
  }
}

function calculateRms(samples: Float32Array) {
  let sumSquares = 0;
  for (let index = 0; index < samples.length; index += 1) {
    sumSquares += samples[index] * samples[index];
  }
  return Math.sqrt(sumSquares / samples.length);
}

function joinTranscript(previous: string, next: string) {
  const trimmedPrevious = normalizeTranscriptWhitespace(previous);
  const trimmedNext = normalizeTranscriptWhitespace(next);
  if (!trimmedPrevious) {
    return trimmedNext;
  }
  if (!trimmedNext) {
    return trimmedPrevious;
  }
  return `${trimmedPrevious}${needsJoinSpace(trimmedPrevious, trimmedNext) ? "\n" : ""}${trimmedNext}`;
}

function normalizeTranscriptWhitespace(text: string) {
  return text
    .trim()
    .replace(/\r\n?/g, "\n")
    .replace(/[ \t]*\n[ \t]*/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/[ \t]{2,}/g, " ");
}

function needsJoinSpace(previous: string, next: string) {
  return !/[\s([{“‘"']$/.test(previous) && !/^[\s,.;:!?)}\]。？！、，；：）]/.test(next);
}

function createLatencySnapshot(partial: Partial<LatencySnapshot>): LatencySnapshot {
  return {
    websocketBufferedBytes: 0,
    queuedAudioChunks: 0,
    audioChunksSent: 0,
    droppedAudioChunks: 0,
    ...partial,
    rootCause: partial.rootCause || "WebRTC translation"
  };
}
