export type TranslatorConfig = {
  sourceLanguage: string;
  targetLanguage: string;
  latencyMode: LatencyMode;
  transcribeUserVoice?: boolean;
};

export type SessionState = "idle" | "warming" | "warm" | "connecting" | "connected" | "stopping" | "error";
export type LatencyMode = "fast" | "webrtc" | "balanced" | "stable";

export type AudioChunk = {
  base64Pcm16: string;
  capturedAt: number;
  speechStartedAt?: number;
  chunkMs: number;
  rms: number;
};

export type MeetingTranscriptionRequest = {
  base64Audio: string;
  mimeType: string;
  sourceLanguage: string;
  targetLanguage: string;
};

export type MeetingAudioChunkSaveRequest = {
  sessionId: string;
  sequence: number;
  base64Audio: string;
  mimeType: string;
  capturedAt: number;
};

export type MeetingTranscriptSegment = {
  speaker: string;
  text: string;
  start?: number;
  end?: number;
};

export type MeetingTranscriptionResult = {
  segments: MeetingTranscriptSegment[];
  text: string;
};

export type TranslationCallStart = {
  clientSecret: string;
};

export type ApiKeyStatus = {
  configured: boolean;
  storage: "encrypted" | "local" | "environment" | "none";
};

export type ApiPricing = {
  realtimeTranslateUsdPerMinute: number;
  realtimeTranslateUsdPerSecond: number;
  realtimeWhisperUsdPerMinute: number;
  realtimeWhisperUsdPerSecond: number;
  realtimeRaceSockets: number;
  meetingDiarizeUsdPerMinute: number;
  meetingDiarizeUsdPerSecond: number;
  realtimeSourceTranscriptMode: "included" | "separate";
};

export type ExitSaveState = {
  sourceText: string;
  targetText: string;
};

export type LatencySnapshot = {
  localCaptureToSendMs?: number;
  speechToInputTranscriptMs?: number;
  speechToTargetMs?: number;
  speechEndToTargetMs?: number;
  speechToSpeculativeTargetMs?: number;
  firstAudioToTargetMs?: number;
  websocketBufferedBytes: number;
  queuedAudioChunks: number;
  audioChunksSent: number;
  preSpeechChunksSent?: number;
  droppedAudioChunks: number;
  rootCause: string;
};

export type MainToRendererEvent =
  | { type: "state"; state: SessionState; message?: string }
  | { type: "speechActivity"; speechStartedAt: number; rms: number }
  | { type: "sourceTranscript"; text: string; final: boolean }
  | { type: "targetTranslation"; text: string; final: boolean }
  | { type: "latency"; snapshot: LatencySnapshot }
  | { type: "error"; message: string };

export type TranslatorApi = {
  warmSession(config: TranslatorConfig): Promise<void>;
  startSession(config: TranslatorConfig): Promise<void>;
  startTranslationCall(config: TranslatorConfig): Promise<TranslationCallStart>;
  stopSession(): Promise<void>;
  getApiKeyStatus(): Promise<ApiKeyStatus>;
  getApiPricing(): Promise<ApiPricing>;
  setApiKey(apiKey: string): Promise<ApiKeyStatus>;
  openApiKeyPage(): Promise<void>;
  transcribeMeetingAudio(request: MeetingTranscriptionRequest): Promise<MeetingTranscriptionResult>;
  saveMeetingAudioChunk(request: MeetingAudioChunkSaveRequest): Promise<void>;
  updateExitSaveState(state: ExitSaveState): void;
  sendAudio(chunk: AudioChunk): void;
  logUiEvent(event: string, data?: Record<string, unknown>): void;
  onEvent(callback: (event: MainToRendererEvent) => void): () => void;
};
