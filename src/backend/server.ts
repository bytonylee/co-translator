import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { fileURLToPath } from "node:url";
import { languageCode, languageOptions, targetLanguageOptions, transcriptionLanguageCode } from "../shared/languages.js";
import {
  type ApiKeyStatus,
  type ApiPricing,
  type AudioChunk,
  type ExitSaveState,
  type LatencyMode,
  type LatencySnapshot,
  type MainToRendererEvent,
  type MeetingAudioChunkSaveRequest,
  type MeetingTranscriptionRequest,
  type MeetingTranscriptionResult,
  type MeetingTranscriptSegment,
  type TranslationCallStart,
  type TranslatorConfig
} from "../shared/types.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, "../..");
const packagedBackend = __dirname.includes(".app/Contents/Resources/");
const logDir = process.env.CO_TRANSLATOR_LOG_DIR || path.join(packagedBackend ? userDataDir() : rootDir, "logs");
const latencyLogPath = path.join(logDir, "latency.ndjson");
const apiKeyPageUrl = "https://platform.openai.com/settings/organization/api-keys";
const apiKeyStoreFile = "openai-api-key.json";
const REALTIME_TRANSLATE_USD_PER_MINUTE = 0.034;
const REALTIME_TRANSLATE_USD_PER_SECOND = 0.00057;
const REALTIME_WHISPER_USD_PER_MINUTE = 0.017;
const REALTIME_WHISPER_USD_PER_SECOND = 0.00028;
const MEETING_DIARIZE_USD_PER_MINUTE = 0.006;
const MEETING_DIARIZE_USD_PER_SECOND = MEETING_DIARIZE_USD_PER_MINUTE / 60;
const MEETING_TRANSLATION_MAX_OUTPUT_TOKENS = 4000;
const TRANSCRIPTION_SPEECH_RMS_THRESHOLD = 0.006;
const DEFAULT_TRANSCRIPTION_SILENCE_HOLD_MS = 600;
const KOREAN_TRANSCRIPTION_SILENCE_HOLD_MS = 1000;
const MIN_TRANSCRIPTION_COMMIT_MS = 100;
const LOW_LATENCY_TRANSCRIPTION_COMMIT_MS = 480;
const TRANSCRIPTION_LONG_BREAK_MS = 1800;
const STOP_TRANSCRIPT_SETTLE_QUIET_MS = 350;
const STOP_TRANSCRIPT_SETTLE_MAX_MS = 4000;
const DEFAULT_WARM_IDLE_TIMEOUT_MS = 300_000;
const bridgePort = Number(process.env.CO_TRANSLATOR_BRIDGE_PORT || 41873);
const defaultOpenAiApiBaseUrl = "https://api.openai.com";
const defaultOpenAiRealtimeWsBaseUrl = "wss://api.openai.com";
const allowOpenAiBaseUrlOverrideFlag = "CO_TRANSLATOR_ALLOW_OPENAI_BASE_URL_OVERRIDE";
const maxApiKeyLength = 4096;
const maxAudioBase64Length = 64 * 1024;
const maxMeetingAudioChunkBase64Length = 6 * 1024 * 1024;
const maxMeetingAudioBase64Length = 36 * 1024 * 1024;
const maxExitSaveTextLength = 2 * 1024 * 1024;
const maxBridgeMessageBytes = 40 * 1024 * 1024;
const validLatencyModes = new Set<LatencyMode>(["fast", "webrtc", "balanced", "stable"]);
const validSourceLanguages = new Set<string>(languageOptions);
const validTargetLanguages = new Set<string>(targetLanguageOptions);
const websocketConnecting = 0;
const websocketOpen = 1;

type RealtimeSocket = {
  readyState: number;
  bufferedAmount: number;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  on?: (event: string, callback: (...args: any[]) => void) => void;
  addEventListener?: (event: string, callback: (event: any) => void) => void;
};

type BridgeSocket = {
  readyState?: number;
  send(data: string): void;
  on?: (event: string, callback: (...args: any[]) => void) => void;
};

const bridgeClients = new Set<BridgeSocket>();
let bridgeTokenValue: string | null = null;
let runtimeApiKey: string | null = null;
let realtimeSocket: RealtimeSocket | null = null;
let realtimeSockets: RealtimeSocket[] = [];
let realtimeWinnerLane: number | undefined;
let transcriptionSocket: RealtimeSocket | null = null;
let sessionId = "";
let finalizedSourceText = "";
let finalizedTargetText = "";
let sourceSegmentText = "";
let targetSegmentText = "";
let pendingAudioChunks: AudioChunk[] = [];
let pendingTranscriptionAudioChunks: AudioChunk[] = [];
let latencyConfig = getLatencyConfig("balanced");
let latencySnapshot = createLatencySnapshot();
let activeConfig: TranslatorConfig | null = null;
let transcriptionConfig: TranslatorConfig | null = null;
let isStreaming = false;
let warmCloseTimer: NodeJS.Timeout | undefined;
let warmConnectPromise: Promise<void> | null = null;
let transcriptionConnectPromise: Promise<void> | null = null;
let translationClientSecretRefreshTimer: NodeJS.Timeout | undefined;
let firstSpeechAt: number | undefined;
let firstAudioSentAt: number | undefined;
let seenRealtimeEventTypes = new Set<string>();
let lastLatencyPublishAt = 0;
let lastRealtimeTranscriptAt = 0;
let realtimeTranscriptWaiters: Array<() => void> = [];
let sessionStartedAt = 0;
let preSpeechChunksSent = 0;
let transcriptionItemOrder: string[] = [];
let transcriptionItemText = new Map<string, string>();
let transcriptionItemSeparator = new Map<string, string>();
let pendingTranscriptionItemSeparators: string[] = [];
let transcriptionBufferHasAudio = false;
let transcriptionBufferHasSpeech = false;
let transcriptionBufferedAudioMs = 0;
let transcriptionCommittedItemCount = 0;
let nextTranscriptionItemSeparator = " ";
let transcriptionSpeechActive = false;
let transcriptionSilentMs = 0;
let transcriptionSilenceHoldMs = DEFAULT_TRANSCRIPTION_SILENCE_HOLD_MS;
let transcriptionLastSpeechEndedAt: number | undefined;
let lastTranscriptionTranscriptAt = 0;
let transcriptionTranscriptWaiters: Array<() => void> = [];
let exitSaveState: ExitSaveState = { sourceText: "", targetText: "" };
let cachedTranslationClientSecret: {
  config: TranslatorConfig;
  value: string;
  expiresAtMs: number;
} | null = null;

type StoredApiKey = {
  encoding: "local" | "plaintext-v1";
  value: string;
};

function getLatencyConfig(mode: LatencyMode) {
  if (mode === "fast") {
    return {
      maxQueuedAudioChunks: 25,
      maxWebSocketBufferBytes: 256 * 1024
    };
  }
  if (mode === "stable") {
    return {
      maxQueuedAudioChunks: 12,
      maxWebSocketBufferBytes: 1024 * 1024
    };
  }
  return {
    maxQueuedAudioChunks: 12,
    maxWebSocketBufferBytes: 512 * 1024
  };
}

function sendEvent(event: MainToRendererEvent) {
  broadcast({ type: "event", event });
}

function isBunRuntime() {
  return typeof (globalThis as { Bun?: unknown }).Bun !== "undefined";
}

async function createRealtimeSocket(url: string, headers: Record<string, string>): Promise<RealtimeSocket> {
  if (isBunRuntime()) {
    const SocketCtor = globalThis.WebSocket as unknown as new (
      url: string,
      options: { headers: Record<string, string> }
    ) => RealtimeSocket;
    return new SocketCtor(url, { headers });
  }

  const { default: NodeWebSocket } = await import("ws");
  return new NodeWebSocket(url, { headers }) as unknown as RealtimeSocket;
}

function onSocketOpen(socket: RealtimeSocket, callback: () => void) {
  if (socket.addEventListener) {
    socket.addEventListener("open", callback);
    return;
  }
  socket.on?.("open", callback);
}

function onSocketMessage(socket: RealtimeSocket, callback: (data: string) => void) {
  if (socket.addEventListener) {
    socket.addEventListener("message", (event) => {
      callback(String(event.data));
    });
    return;
  }
  socket.on?.("message", (data) => {
    callback(data.toString());
  });
}

function onSocketError(socket: RealtimeSocket, callback: (error: Error) => void) {
  if (socket.addEventListener) {
    socket.addEventListener("error", (event) => {
      const message = typeof event.message === "string" ? event.message : "WebSocket error";
      callback(new Error(message));
    });
    return;
  }
  socket.on?.("error", callback);
}

function onSocketClose(socket: RealtimeSocket, callback: (code: number, reason: string) => void) {
  if (socket.addEventListener) {
    socket.addEventListener("close", (event) => {
      callback(Number(event.code), String(event.reason || ""));
    });
    return;
  }
  socket.on?.("close", (code, reason) => {
    callback(Number(code), reason?.toString() || "");
  });
}

function startLogSession() {
  sessionId = `session-${Date.now()}`;
  sessionStartedAt = Date.now();
  fs.mkdirSync(logDir, { recursive: true });
  logLatency("session_log_start", {
    pid: process.pid,
    logPath: latencyLogPath
  });
}

function logLatency(event: string, data: Record<string, unknown> = {}) {
  const now = Date.now();
  const line = {
    ts: new Date(now).toISOString(),
    tMs: sessionStartedAt ? now - sessionStartedAt : 0,
    sessionId,
    event,
    ...data
  };
  const serialized = JSON.stringify(line);
  console.log(`[latency] ${serialized}`);
  try {
    fs.mkdirSync(logDir, { recursive: true });
    fs.appendFileSync(latencyLogPath, `${serialized}\n`, "utf8");
  } catch (error) {
    console.error("[latency] failed to write latency log", error);
  }
}

function createLatencySnapshot(): LatencySnapshot {
  return {
    websocketBufferedBytes: 0,
    queuedAudioChunks: 0,
    audioChunksSent: 0,
    droppedAudioChunks: 0,
    rootCause: "Waiting for speech"
  };
}

function sameSessionConfig(left: TranslatorConfig | null, right: TranslatorConfig) {
  return (
    left?.targetLanguage === right.targetLanguage &&
    left?.latencyMode === right.latencyMode
  );
}

function sameTranscriptionConfig(left: TranslatorConfig | null, right: TranslatorConfig) {
  return (
    left !== null &&
    left?.sourceLanguage === right.sourceLanguage &&
    shouldTranscribeUserVoice(left) === shouldTranscribeUserVoice(right)
  );
}

function shouldTranscribeUserVoice(config: TranslatorConfig) {
  return config.transcribeUserVoice !== false;
}

function shouldOpenSeparateTranscriptionSocket(config: TranslatorConfig) {
  return shouldTranscribeUserVoice(config);
}

function transcriptionSilenceHoldMsFor(config: TranslatorConfig) {
  return config.sourceLanguage === "Korean" ? KOREAN_TRANSCRIPTION_SILENCE_HOLD_MS : DEFAULT_TRANSCRIPTION_SILENCE_HOLD_MS;
}

function socketIsOpen() {
  return realtimeSockets.length > 0 && realtimeSockets.every((socket) => socket.readyState === websocketOpen);
}

function openRealtimeSockets() {
  return realtimeSockets.filter((socket) => socket.readyState === websocketOpen);
}

function transcriptionSocketIsOpen() {
  return transcriptionSocket?.readyState === websocketOpen;
}

function warmResourceIsOpen() {
  return socketIsOpen() || transcriptionSocketIsOpen();
}

function closeRealtimeSockets(code = 1000, reason = "closing realtime sockets") {
  for (const socket of realtimeSockets) {
    if (socket.readyState === websocketOpen || socket.readyState === websocketConnecting) {
      socket.close(code, reason);
    }
  }
  realtimeSockets = [];
  realtimeSocket = null;
  realtimeWinnerLane = undefined;
}

function closeTranscriptionSocket(code = 1000, reason = "closing transcription socket") {
  if (transcriptionSocket?.readyState === websocketOpen || transcriptionSocket?.readyState === websocketConnecting) {
    transcriptionSocket.close(code, reason);
  }
  transcriptionSocket = null;
  transcriptionConfig = null;
  resetTranscriptionState();
}

function realtimeRaceSocketCount(config: TranslatorConfig) {
  if (config.latencyMode !== "fast") {
    return 1;
  }
  return configuredRealtimeRaceSocketCount();
}

function configuredRealtimeRaceSocketCount() {
  return Math.max(1, Number(process.env.OPENAI_REALTIME_RACE_SOCKETS || 3));
}

function getApiPricing(): ApiPricing {
  return {
    realtimeTranslateUsdPerMinute: REALTIME_TRANSLATE_USD_PER_MINUTE,
    realtimeTranslateUsdPerSecond: REALTIME_TRANSLATE_USD_PER_SECOND,
    realtimeWhisperUsdPerMinute: REALTIME_WHISPER_USD_PER_MINUTE,
    realtimeWhisperUsdPerSecond: REALTIME_WHISPER_USD_PER_SECOND,
    realtimeRaceSockets: configuredRealtimeRaceSocketCount(),
    meetingDiarizeUsdPerMinute: MEETING_DIARIZE_USD_PER_MINUTE,
    meetingDiarizeUsdPerSecond: MEETING_DIARIZE_USD_PER_SECOND,
    realtimeSourceTranscriptMode: "separate"
  };
}

function clearWarmCloseTimer() {
  if (warmCloseTimer) {
    clearTimeout(warmCloseTimer);
    warmCloseTimer = undefined;
  }
}

function clearTranslationClientSecretRefreshTimer() {
  if (translationClientSecretRefreshTimer) {
    clearTimeout(translationClientSecretRefreshTimer);
    translationClientSecretRefreshTimer = undefined;
  }
}

function scheduleTranslationClientSecretRefresh(config: TranslatorConfig) {
  clearTranslationClientSecretRefreshTimer();
  if (isStreaming || !translationClientSecretIsFresh(config)) {
    return;
  }

  const refreshInMs = Math.max(1000, cachedTranslationClientSecret!.expiresAtMs - Date.now() - 10_000);
  logLatency("translation_client_secret_refresh_scheduled", {
    refreshInMs,
    targetLanguage: config.targetLanguage
  });
  translationClientSecretRefreshTimer = setTimeout(() => {
    if (isStreaming) {
      return;
    }
    void getTranslationClientSecret(config)
      .then(() => scheduleTranslationClientSecretRefresh(config))
      .catch((error: unknown) => {
        logLatency("translation_client_secret_refresh_error", {
          message: error instanceof Error ? error.message : "Could not refresh translation client secret."
        });
      });
  }, refreshInMs);
}

function scheduleWarmClose(reason: string) {
  const warmIdleTimeoutMs = Number(process.env.OPENAI_WARM_IDLE_TIMEOUT_MS || DEFAULT_WARM_IDLE_TIMEOUT_MS);
  clearWarmCloseTimer();
  if (isStreaming || (!realtimeSockets.length && !transcriptionSocket)) {
    return;
  }
  logLatency("warm_close_scheduled", {
    reason,
    idleTimeoutMs: warmIdleTimeoutMs
  });
  warmCloseTimer = setTimeout(() => {
    if (!isStreaming && (realtimeSockets.length || transcriptionSocket)) {
      logLatency("warm_close_idle_timeout", {
        idleTimeoutMs: warmIdleTimeoutMs
      });
      closeRealtimeSockets(1000, "warm idle timeout");
      closeTranscriptionSocket(1000, "warm idle timeout");
      activeConfig = null;
      sendEvent({ type: "state", state: "idle", message: "Warm socket closed" });
    }
  }, warmIdleTimeoutMs);
}

function publishLatency(partial: Partial<LatencySnapshot> = {}, force = false) {
  latencySnapshot = {
    ...latencySnapshot,
    ...partial,
    websocketBufferedBytes: maxRealtimeBufferedAmount(),
    queuedAudioChunks: pendingAudioChunks.length
  };
  const now = Date.now();
  if (!force && now - lastLatencyPublishAt < 500) {
    return;
  }
  lastLatencyPublishAt = now;
  logLatency("latency_snapshot", latencySnapshot);
  sendEvent({ type: "latency", snapshot: latencySnapshot });
}

function maxRealtimeBufferedAmount() {
  return realtimeSockets.reduce((maxBuffered, socket) => Math.max(maxBuffered, socket.bufferedAmount), 0);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function getBridgeToken() {
  bridgeTokenValue ??= process.env.CO_TRANSLATOR_BRIDGE_TOKEN?.trim() || randomBytes(32).toString("hex");
  return bridgeTokenValue;
}

function secureTokenEquals(actual: string, expected: string) {
  const actualBuffer = Buffer.from(actual);
  const expectedBuffer = Buffer.from(expected);
  return actualBuffer.length === expectedBuffer.length && timingSafeEqual(actualBuffer, expectedBuffer);
}

function bridgeRequestIsAuthorized(rawUrl: string | undefined, origin: string | undefined | null) {
  const url = new URL(rawUrl || "/bridge", "http://127.0.0.1");
  const token = url.searchParams.get("token") || "";
  if (!secureTokenEquals(token, getBridgeToken())) {
    return false;
  }
  if (!origin) {
    return true;
  }
  return new Set([
    "zero://app",
    "zero://inline",
    "file://local",
    "file://",
    "http://127.0.0.1:5173",
    "http://localhost:5173"
  ]).has(origin);
}

function validateConfig(value: unknown): TranslatorConfig {
  if (!isRecord(value)) {
    throw new Error("Translator config must be an object.");
  }
  if (typeof value.sourceLanguage !== "string" || !validSourceLanguages.has(value.sourceLanguage)) {
    throw new Error("Unsupported source language.");
  }
  if (typeof value.targetLanguage !== "string" || !validTargetLanguages.has(value.targetLanguage)) {
    throw new Error("Unsupported target language.");
  }
  if (typeof value.latencyMode !== "string" || !validLatencyModes.has(value.latencyMode as LatencyMode)) {
    throw new Error("Unsupported latency mode.");
  }
  if (value.transcribeUserVoice !== undefined && typeof value.transcribeUserVoice !== "boolean") {
    throw new Error("transcribeUserVoice must be a boolean.");
  }
  return {
    sourceLanguage: value.sourceLanguage,
    targetLanguage: value.targetLanguage,
    latencyMode: value.latencyMode as LatencyMode,
    transcribeUserVoice: value.transcribeUserVoice
  };
}

function validateApiKey(value: unknown) {
  if (typeof value !== "string") {
    throw new Error("API key must be text.");
  }
  const trimmed = value.trim();
  if (!trimmed.startsWith("sk-") || trimmed.length > maxApiKeyLength) {
    throw new Error("API key must start with sk- and fit the expected length.");
  }
  return trimmed;
}

function validateAudioChunk(value: unknown): AudioChunk | null {
  if (!isRecord(value)) {
    return null;
  }
  const { base64Pcm16, capturedAt, speechStartedAt, chunkMs, rms } = value;
  if (
    typeof base64Pcm16 !== "string" ||
    base64Pcm16.length === 0 ||
    base64Pcm16.length > maxAudioBase64Length ||
    !/^[A-Za-z0-9+/]+={0,2}$/.test(base64Pcm16)
  ) {
    return null;
  }
  if (typeof capturedAt !== "number" || !Number.isFinite(capturedAt) || capturedAt <= 0) {
    return null;
  }
  if (speechStartedAt !== undefined && (typeof speechStartedAt !== "number" || !Number.isFinite(speechStartedAt) || speechStartedAt <= 0)) {
    return null;
  }
  if (typeof chunkMs !== "number" || !Number.isFinite(chunkMs) || chunkMs <= 0 || chunkMs > 1000) {
    return null;
  }
  if (typeof rms !== "number" || !Number.isFinite(rms) || rms < 0 || rms > 10) {
    return null;
  }
  return {
    base64Pcm16,
    capturedAt,
    speechStartedAt,
    chunkMs,
    rms
  } as AudioChunk;
}

function validateMeetingTranscriptionRequest(value: unknown): MeetingTranscriptionRequest {
  if (!isRecord(value)) {
    throw new Error("Meeting transcription request must be an object.");
  }
  const { base64Audio, mimeType, sourceLanguage, targetLanguage } = value;
  if (
    typeof base64Audio !== "string" ||
    base64Audio.length === 0 ||
    base64Audio.length > maxMeetingAudioBase64Length ||
    !/^[A-Za-z0-9+/]+={0,2}$/.test(base64Audio)
  ) {
    throw new Error("Meeting audio must be a base64 audio file under 25 MB.");
  }
  if (typeof mimeType !== "string" || !mimeType.startsWith("audio/") || mimeType.length > 120) {
    throw new Error("Meeting audio must include an audio MIME type.");
  }
  if (typeof sourceLanguage !== "string" || !validSourceLanguages.has(sourceLanguage)) {
    throw new Error("Unsupported meeting source language.");
  }
  if (typeof targetLanguage !== "string" || !validTargetLanguages.has(targetLanguage)) {
    throw new Error("Unsupported meeting target language.");
  }
  return {
    base64Audio,
    mimeType,
    sourceLanguage,
    targetLanguage
  };
}

function validateMeetingAudioChunkSaveRequest(value: unknown): MeetingAudioChunkSaveRequest {
  if (!isRecord(value)) {
    throw new Error("Meeting audio chunk request must be an object.");
  }
  const { sessionId, sequence, base64Audio, mimeType, capturedAt } = value;
  if (typeof sessionId !== "string" || !/^[A-Za-z0-9._-]{1,80}$/.test(sessionId)) {
    throw new Error("Meeting audio chunk session id is invalid.");
  }
  if (typeof sequence !== "number" || !Number.isInteger(sequence) || sequence < 0 || sequence > 999_999) {
    throw new Error("Meeting audio chunk sequence is invalid.");
  }
  if (
    typeof base64Audio !== "string" ||
    base64Audio.length === 0 ||
    base64Audio.length > maxMeetingAudioChunkBase64Length ||
    !/^[A-Za-z0-9+/]+={0,2}$/.test(base64Audio)
  ) {
    throw new Error("Meeting audio chunk must be a base64 audio file under 6 MB.");
  }
  if (typeof mimeType !== "string" || !mimeType.startsWith("audio/") || mimeType.length > 120) {
    throw new Error("Meeting audio chunk must include an audio MIME type.");
  }
  if (typeof capturedAt !== "number" || !Number.isFinite(capturedAt) || capturedAt <= 0) {
    throw new Error("Meeting audio chunk capture time is invalid.");
  }
  return {
    sessionId,
    sequence,
    base64Audio,
    mimeType,
    capturedAt
  };
}

function validateExitSaveState(value: unknown): ExitSaveState | null {
  if (!isRecord(value)) {
    return null;
  }
  if (typeof value.sourceText !== "string" || typeof value.targetText !== "string") {
    return null;
  }
  return {
    sourceText: value.sourceText.slice(0, maxExitSaveTextLength),
    targetText: value.targetText.slice(0, maxExitSaveTextLength)
  };
}

function sanitizeLogData(value: unknown) {
  if (!isRecord(value)) {
    return {};
  }
  const sanitized: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value).slice(0, 32)) {
    if (key.length > 80) {
      continue;
    }
    if (typeof item === "string") {
      sanitized[key] = item.slice(0, 500);
    } else if (typeof item === "number" || typeof item === "boolean" || item === null) {
      sanitized[key] = item;
    }
  }
  return sanitized;
}

function loadEnv() {
  for (const filename of [".env", ".env.local"]) {
    const filePath = path.join(rootDir, filename);
    if (!fs.existsSync(filePath)) {
      continue;
    }

    for (const [key, value] of Object.entries(parseEnvFile(fs.readFileSync(filePath, "utf8")))) {
      if (value.trim()) {
        process.env[key] = value;
      }
    }
  }
}

function openAiApiBaseUrl() {
  return validatedOpenAiBaseUrl("OPENAI_API_BASE_URL", defaultOpenAiApiBaseUrl, "https:");
}

function openAiRealtimeWsBaseUrl() {
  return validatedOpenAiBaseUrl("OPENAI_REALTIME_WS_BASE_URL", defaultOpenAiRealtimeWsBaseUrl, "wss:");
}

function validatedOpenAiBaseUrl(envName: string, fallback: string, requiredProtocol: "https:" | "wss:") {
  const rawValue = process.env[envName]?.trim() || fallback;
  const url = new URL(rawValue);
  const overrideAllowed = process.env[allowOpenAiBaseUrlOverrideFlag] === "1";
  const developmentProtocolAllowed = overrideAllowed && (
    (requiredProtocol === "https:" && url.protocol === "http:") ||
    (requiredProtocol === "wss:" && url.protocol === "ws:")
  );
  if (url.protocol !== requiredProtocol && !developmentProtocolAllowed) {
    throw new Error(`${envName} must use ${requiredProtocol.replace(":", "")}.`);
  }
  const normalized = url.toString().replace(/\/$/, "");
  const defaultUrl = new URL(fallback);
  if (url.hostname !== defaultUrl.hostname && !overrideAllowed) {
    throw new Error(`${envName} can only target ${defaultUrl.hostname} unless ${allowOpenAiBaseUrlOverrideFlag}=1.`);
  }
  return normalized;
}

function parseEnvFile(contents: string) {
  const parsed: Record<string, string> = {};
  for (const rawLine of contents.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) {
      continue;
    }
    const match = line.match(/^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (!match) {
      continue;
    }
    parsed[match[1]] = parseEnvValue(match[2]);
  }
  return parsed;
}

function parseEnvValue(value: string) {
  const trimmed = value.trim();
  const quote = trimmed[0];
  if ((quote === "\"" || quote === "'") && trimmed.endsWith(quote)) {
    const inner = trimmed.slice(1, -1);
    return quote === "\"" ? inner.replace(/\\n/g, "\n").replace(/\\"/g, "\"").replace(/\\\\/g, "\\") : inner.replace(/\\'/g, "'");
  }
  return trimmed.replace(/\s+#.*$/, "");
}

function apiKeyStorePath() {
  return path.join(userDataDir(), apiKeyStoreFile);
}

function userDataDir() {
  if (process.env.CO_TRANSLATOR_USER_DATA_DIR) {
    return process.env.CO_TRANSLATOR_USER_DATA_DIR;
  }
  if (process.platform === "darwin") {
    return path.join(os.homedir(), "Library", "Application Support", "Co Translator");
  }
  if (process.platform === "win32") {
    return path.join(process.env.APPDATA || os.homedir(), "Co Translator");
  }
  return path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config"), "co-translator");
}

function readStoredApiKey(): { apiKey: string; storage: ApiKeyStatus["storage"] } | null {
  const storePath = apiKeyStorePath();
  if (!fs.existsSync(storePath)) {
    return null;
  }

  try {
    const stored = JSON.parse(fs.readFileSync(storePath, "utf8")) as Partial<StoredApiKey>;
    if (!stored.value) {
      return null;
    }
    if ((stored.encoding === "local" || stored.encoding === "plaintext-v1") && typeof stored.value === "string") {
      return {
        apiKey: validateApiKey(stored.value),
        storage: "local"
      };
    }
  } catch (error) {
    logLatency("api_key_store_read_error", {
      message: error instanceof Error ? error.message : "Could not read API key store."
    });
  }
  return null;
}

function writeStoredApiKey(apiKey: string): ApiKeyStatus {
  const trimmedApiKey = validateApiKey(apiKey);
  const stored: StoredApiKey = {
    encoding: "plaintext-v1",
    value: trimmedApiKey
  };

  fs.mkdirSync(userDataDir(), { recursive: true, mode: 0o700 });
  fs.writeFileSync(apiKeyStorePath(), JSON.stringify(stored, null, 2), { encoding: "utf8", mode: 0o600 });
  runtimeApiKey = trimmedApiKey;
  cachedTranslationClientSecret = null;
  clearTranslationClientSecretRefreshTimer();
  if (!isStreaming) {
    closeRealtimeSockets(1000, "api key updated");
    closeTranscriptionSocket(1000, "api key updated");
    activeConfig = null;
  }
  return {
    configured: true,
    storage: "local"
  };
}

function getApiKeyStatus(): ApiKeyStatus {
  if (runtimeApiKey) {
    return {
      configured: true,
      storage: "local"
    };
  }
  const stored = readStoredApiKey();
  if (stored?.apiKey) {
    return {
      configured: true,
      storage: stored.storage
    };
  }
  if (process.env.OPENAI_API_KEY) {
    try {
      validateApiKey(process.env.OPENAI_API_KEY);
      return {
        configured: true,
        storage: "environment"
      };
    } catch {
      return {
        configured: false,
        storage: "none"
      };
    }
  }
  return {
    configured: false,
    storage: "none"
  };
}

function getApiKey() {
  const apiKey = runtimeApiKey || readStoredApiKey()?.apiKey || (process.env.OPENAI_API_KEY ? validateApiKey(process.env.OPENAI_API_KEY) : "");
  if (!apiKey) {
    logLatency("missing_api_key");
    throw new Error("OPENAI_API_KEY is missing. Add it in API key settings.");
  }
  return apiKey;
}

function translationClientSecretIsFresh(config: TranslatorConfig) {
  return (
    cachedTranslationClientSecret !== null &&
    sameSessionConfig(cachedTranslationClientSecret.config, config) &&
    cachedTranslationClientSecret.expiresAtMs - Date.now() > 10_000
  );
}

async function getTranslationClientSecret(config: TranslatorConfig) {
  if (translationClientSecretIsFresh(config)) {
    logLatency("translation_client_secret_reused", {
      targetLanguage: config.targetLanguage,
      expiresInMs: cachedTranslationClientSecret!.expiresAtMs - Date.now()
    });
    return cachedTranslationClientSecret!.value;
  }

  const model = process.env.OPENAI_REALTIME_MODEL || "gpt-realtime-translate";
  const startedAt = Date.now();
  logLatency("translation_client_secret_start", {
    model,
    targetLanguage: config.targetLanguage,
    targetLanguageCode: languageCode(config.targetLanguage)
  });

  const response = await fetch(`${openAiApiBaseUrl()}/v1/realtime/translations/client_secrets`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${getApiKey()}`,
      "Content-Type": "application/json",
      "OpenAI-Safety-Identifier": "co-translator-local-desktop"
    },
    body: JSON.stringify({
      session: {
        model,
        audio: {
          output: {
            language: languageCode(config.targetLanguage)
          }
        }
      }
    })
  });

  const payload = await response.json().catch(() => null) as {
    value?: string;
    client_secret?: { value?: string; expires_at?: number };
    expires_at?: number;
    error?: { message?: string };
  } | null;

  if (!response.ok) {
    throw new Error(payload?.error?.message || `Could not create translation client secret (${response.status}).`);
  }

  const value = payload?.value || payload?.client_secret?.value;
  if (!value) {
    throw new Error("Translation client secret response did not include a value.");
  }

  const expiresAtSeconds = payload?.expires_at || payload?.client_secret?.expires_at;
  cachedTranslationClientSecret = {
    config,
    value,
    expiresAtMs: expiresAtSeconds ? expiresAtSeconds * 1000 : Date.now() + 45_000
  };
  logLatency("translation_client_secret_ready", {
    createMs: Date.now() - startedAt,
    expiresInMs: cachedTranslationClientSecret.expiresAtMs - Date.now()
  });
  return value;
}

async function transcribeMeetingAudio(request: MeetingTranscriptionRequest): Promise<MeetingTranscriptionResult> {
  const model = process.env.OPENAI_MEETING_TRANSCRIPTION_MODEL || "gpt-4o-transcribe-diarize";
  const language = transcriptionLanguageCode(request.sourceLanguage);
  const audio = Buffer.from(request.base64Audio, "base64");
  if (audio.length < 512) {
    throw new Error("Meeting audio is too short to transcribe.");
  }

  const startedAt = Date.now();
  logLatency("meeting_transcription_start", {
    model,
    sourceLanguage: request.sourceLanguage,
    sourceLanguageCode: language,
    bytes: audio.length,
    mimeType: request.mimeType
  });

  const form = new FormData();
  form.append("file", new Blob([audio], { type: request.mimeType }), meetingAudioFilename(request.mimeType));
  form.append("model", model);
  form.append("response_format", "diarized_json");
  form.append("chunking_strategy", "auto");
  if (language) {
    form.append("language", language);
  }

  const response = await fetch(`${openAiApiBaseUrl()}/v1/audio/transcriptions`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${getApiKey()}`,
      "OpenAI-Safety-Identifier": "co-translator-local-desktop"
    },
    body: form
  });

  const payload = await response.json().catch(() => null) as unknown;
  if (!response.ok) {
    const message = isRecord(payload) && isRecord(payload.error) && typeof payload.error.message === "string"
      ? payload.error.message
      : `Could not diarize meeting audio (${response.status}).`;
    throw new Error(message);
  }

  const result = await translateMeetingSegments(normalizeMeetingTranscription(payload), request);
  logLatency("meeting_transcription_ready", {
    model,
    readyMs: Date.now() - startedAt,
    segments: result.segments.length,
    speakers: new Set(result.segments.map((segment) => segment.speaker)).size,
    targetLanguage: request.targetLanguage
  });
  return result;
}

async function translateMeetingSegments(result: MeetingTranscriptionResult, request: MeetingTranscriptionRequest): Promise<MeetingTranscriptionResult> {
  if (!result.segments.length || (request.sourceLanguage !== "Auto" && request.sourceLanguage === request.targetLanguage)) {
    return result;
  }

  const model = process.env.OPENAI_MEETING_TRANSLATION_MODEL || "gpt-4.1-mini";
  const startedAt = Date.now();
  logLatency("meeting_segment_translation_start", {
    model,
    sourceLanguage: request.sourceLanguage,
    targetLanguage: request.targetLanguage,
    segments: result.segments.length
  });

  const response = await fetch(`${openAiApiBaseUrl()}/v1/responses`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${getApiKey()}`,
      "Content-Type": "application/json",
      "OpenAI-Safety-Identifier": "co-translator-local-desktop"
    },
    body: JSON.stringify({
      model,
      store: false,
      instructions: [
        `Translate each meeting segment into ${request.targetLanguage}.`,
        "Preserve meaning, speaker order, punctuation, and line breaks where natural.",
        "Return only the requested JSON shape. Do not include source-language text unless it is a name or untranslatable term."
      ].join(" "),
      input: JSON.stringify({
        sourceLanguage: request.sourceLanguage,
        targetLanguage: request.targetLanguage,
        segments: result.segments.map((segment, index) => ({
          index,
          speaker: segment.speaker,
          text: segment.text
        }))
      }),
      max_output_tokens: MEETING_TRANSLATION_MAX_OUTPUT_TOKENS,
      text: {
        format: {
          type: "json_schema",
          name: "meeting_segment_translations",
          strict: true,
          schema: {
            type: "object",
            additionalProperties: false,
            required: ["segments"],
            properties: {
              segments: {
                type: "array",
                items: {
                  type: "object",
                  additionalProperties: false,
                  required: ["index", "text"],
                  properties: {
                    index: { type: "integer" },
                    text: { type: "string" }
                  }
                }
              }
            }
          }
        }
      }
    })
  });

  const payload = await response.json().catch(() => null) as unknown;
  if (!response.ok) {
    const message = isRecord(payload) && isRecord(payload.error) && typeof payload.error.message === "string"
      ? payload.error.message
      : `Could not translate diarized meeting text (${response.status}).`;
    throw new Error(message);
  }

  const translatedText = extractResponseOutputText(payload);
  const translatedSegments = normalizeMeetingSegmentTranslations(translatedText, result.segments);
  logLatency("meeting_segment_translation_ready", {
    model,
    readyMs: Date.now() - startedAt,
    segments: translatedSegments.length
  });
  return {
    segments: translatedSegments,
    text: translatedSegments.map((segment) => `${segment.speaker}: ${segment.text}`).join("\n\n")
  };
}

function normalizeMeetingSegmentTranslations(rawText: string, sourceSegments: MeetingTranscriptSegment[]) {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawText);
  } catch {
    throw new Error("Meeting translation response was not valid JSON.");
  }
  if (!isRecord(parsed) || !Array.isArray(parsed.segments)) {
    throw new Error("Meeting translation response did not include segments.");
  }

  const translations = new Map<number, string>();
  for (const rawSegment of parsed.segments) {
    if (!isRecord(rawSegment) || typeof rawSegment.index !== "number" || !Number.isInteger(rawSegment.index) || typeof rawSegment.text !== "string") {
      continue;
    }
    const text = rawSegment.text.trim();
    if (text) {
      translations.set(rawSegment.index, text);
    }
  }

  return sourceSegments.map((segment, index) => {
    const translatedText = translations.get(index);
    if (!translatedText) {
      throw new Error("Meeting translation response was missing a segment.");
    }
    return {
      ...segment,
      text: translatedText
    };
  });
}

function extractResponseOutputText(payload: unknown) {
  if (!isRecord(payload)) {
    throw new Error("Meeting translation response was not valid JSON.");
  }
  if (typeof payload.output_text === "string" && payload.output_text.trim()) {
    return payload.output_text.trim();
  }
  const output = Array.isArray(payload.output) ? payload.output : [];
  for (const item of output) {
    if (!isRecord(item) || !Array.isArray(item.content)) {
      continue;
    }
    for (const content of item.content) {
      if (isRecord(content) && typeof content.text === "string" && content.text.trim()) {
        return content.text.trim();
      }
    }
  }
  throw new Error("Meeting translation response did not include output text.");
}

async function saveMeetingAudioChunk(request: MeetingAudioChunkSaveRequest) {
  const audio = Buffer.from(request.base64Audio, "base64");
  if (!audio.length) {
    throw new Error("Meeting audio chunk was empty.");
  }
  const directory = path.join(userDataDir(), "meeting-audio", request.sessionId);
  const filename = meetingAudioChunkFilename(request.mimeType, request.sequence);
  await fs.promises.mkdir(directory, { recursive: true });
  await fs.promises.writeFile(path.join(directory, filename), audio, { mode: 0o600 });
  logLatency("meeting_audio_chunk_saved", {
    sessionId: request.sessionId,
    sequence: request.sequence,
    bytes: audio.length,
    capturedAt: request.capturedAt
  });
}

function meetingAudioChunkFilename(mimeType: string, sequence: number) {
  const ext = path.extname(meetingAudioFilename(mimeType)) || ".webm";
  return `chunk-${String(sequence).padStart(4, "0")}${ext}`;
}

function meetingAudioFilename(mimeType: string) {
  if (mimeType.includes("wav")) {
    return "meeting.wav";
  }
  if (mimeType.includes("mpeg") || mimeType.includes("mp3")) {
    return "meeting.mp3";
  }
  if (mimeType.includes("mp4") || mimeType.includes("m4a")) {
    return "meeting.m4a";
  }
  if (mimeType.includes("ogg")) {
    return "meeting.ogg";
  }
  return "meeting.webm";
}

function normalizeMeetingTranscription(payload: unknown): MeetingTranscriptionResult {
  if (!isRecord(payload)) {
    throw new Error("Meeting transcription response was not valid JSON.");
  }

  const speakerMap = new Map<string, string>();
  const segments: MeetingTranscriptSegment[] = [];
  const rawSegments = Array.isArray(payload.segments) ? payload.segments : [];
  for (const rawSegment of rawSegments) {
    if (!isRecord(rawSegment) || typeof rawSegment.text !== "string") {
      continue;
    }
    const text = rawSegment.text.trim();
    if (!text) {
      continue;
    }
    const rawSpeaker = typeof rawSegment.speaker === "string" && rawSegment.speaker.trim()
      ? rawSegment.speaker.trim()
      : "speaker";
    if (!speakerMap.has(rawSpeaker)) {
      speakerMap.set(rawSpeaker, `User ${speakerMap.size + 1}`);
    }
    const segment: MeetingTranscriptSegment = {
      speaker: speakerMap.get(rawSpeaker)!,
      text
    };
    if (typeof rawSegment.start === "number" && Number.isFinite(rawSegment.start)) {
      segment.start = rawSegment.start;
    }
    if (typeof rawSegment.end === "number" && Number.isFinite(rawSegment.end)) {
      segment.end = rawSegment.end;
    }
    segments.push(segment);
  }

  if (!segments.length && typeof payload.text === "string" && payload.text.trim()) {
    segments.push({
      speaker: "User 1",
      text: payload.text.trim()
    });
  }

  const groupedSegments = mergeConsecutiveMeetingSegments(segments);
  return {
    segments: groupedSegments,
    text: groupedSegments.map((segment) => `${segment.speaker}: ${segment.text}`).join("\n\n")
  };
}

function mergeConsecutiveMeetingSegments(segments: MeetingTranscriptSegment[]) {
  const grouped: MeetingTranscriptSegment[] = [];
  for (const segment of segments) {
    const previous = grouped[grouped.length - 1];
    if (previous && previous.speaker === segment.speaker) {
      previous.text = `${previous.text}\n\n${segment.text}`;
      previous.end = segment.end ?? previous.end;
      continue;
    }
    grouped.push({ ...segment });
  }
  return grouped;
}

async function saveExitTexts(directory: string) {
  if (!path.isAbsolute(directory)) {
    throw new Error("Transcript save directory must be an absolute path.");
  }
  await fs.promises.mkdir(directory, { recursive: true });
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const sourcePath = path.join(directory, `${timestamp}-user-transcription.md`);
  const targetPath = path.join(directory, `${timestamp}-translated-text.md`);
  await Promise.all([
    fs.promises.writeFile(sourcePath, markdownDocument("User voice transcription", exitSaveState.sourceText), "utf8"),
    fs.promises.writeFile(targetPath, markdownDocument("Translated text", exitSaveState.targetText), "utf8")
  ]);
  return true;
}

function markdownDocument(title: string, text: string) {
  return `# ${title}\n\n${text.trim()}\n`;
}

function hasExitSaveText() {
  return Boolean(exitSaveState.sourceText.trim() || exitSaveState.targetText.trim());
}

function connectRealtime(config: TranslatorConfig, readyState: "connected" | "warm" = "connected") {
  const apiKey = getApiKey();

  return new Promise<void>((resolve, reject) => {
    const model = process.env.OPENAI_REALTIME_MODEL || "gpt-realtime-translate";
    const url = `${openAiRealtimeWsBaseUrl()}/v1/realtime/translations?model=${encodeURIComponent(model)}`;
    const raceCount = realtimeRaceSocketCount(config);
    let settled = false;
    let sessionReadyTimeout: NodeJS.Timeout | undefined;
    const readyLanes = new Set<number>();
    const connectStartedAt = Date.now();
    resetRealtimeState();
    latencyConfig = getLatencyConfig(config.latencyMode);
    activeConfig = config;
    logLatency("ws_connect_start", {
      model,
      targetLanguage: config.targetLanguage,
      targetLanguageCode: languageCode(config.targetLanguage),
      latencyMode: config.latencyMode,
      raceSockets: raceCount
    });
    closeRealtimeSockets(1000, "replacing realtime sockets");

    const markSessionReady = (reason: string) => {
      if (settled) {
        return;
      }
      clearSessionReadyTimeout();
      settled = true;
      logLatency("session_ready", {
        reason,
        readyMs: Date.now() - connectStartedAt,
        readySockets: readyLanes.size,
        raceSockets: raceCount
      });
      publishLatency({ rootCause: "WebSocket ready; waiting for speech" }, true);
      flushPendingAudio();
      resolve();
    };

    const markLaneReady = (lane: number, reason: string) => {
      readyLanes.add(lane);
      if (readyLanes.size >= raceCount) {
        markSessionReady(reason);
      }
    };

    const clearSessionReadyTimeout = () => {
      if (sessionReadyTimeout) {
        clearTimeout(sessionReadyTimeout);
        sessionReadyTimeout = undefined;
      }
    };

    sessionReadyTimeout = setTimeout(() => {
      logLatency("session_update_ack_timeout", {
        timeoutMs: 3000,
        readySockets: readyLanes.size,
        raceSockets: raceCount
      });
      if (readyLanes.size > 0) {
        markSessionReady("session_update_ack_timeout");
      }
    }, 3000);

    void (async () => {
      const sockets: RealtimeSocket[] = [];
      realtimeSockets = sockets;
      realtimeSocket = null;

      for (let lane = 0; lane < raceCount; lane += 1) {
        const socket = await createRealtimeSocket(url, {
          Authorization: `Bearer ${apiKey}`,
          "OpenAI-Safety-Identifier": "co-translator-local-desktop"
        });
        sockets.push(socket);
        realtimeSocket = sockets[0] || null;

        onSocketOpen(socket, () => {
        logLatency("ws_open", {
          connectMs: Date.now() - connectStartedAt,
          lane,
          raceSockets: raceCount
        });
        sendEvent({
          type: "state",
          state: readyState,
          message: readyState === "warm" ? "Warm socket ready" : `Connected to ${model}`
        });
        socket.send(
          JSON.stringify({
            type: "session.update",
            session: {
              audio: {
                output: {
                  language: languageCode(config.targetLanguage)
                }
              }
            }
          })
        );
        logLatency("session_update_sent", {
          targetLanguageCode: languageCode(config.targetLanguage),
          lane
        });
      });

        onSocketMessage(socket, (data) => {
        const event = parseRealtimeEvent(data);
        if (!event) {
          return;
        }
        if (event.type === "session.updated") {
          logLatency("session_updated", {
            readyMs: Date.now() - connectStartedAt,
            lane,
            raceSockets: raceCount
          });
          markLaneReady(lane, "session_updated");
          return;
        }
        handleRealtimeEvent(event, lane, raceCount);
      });

        onSocketError(socket, (error) => {
        logLatency("ws_error", {
          message: error.message,
          lane,
          raceSockets: raceCount
        });
        if (!settled && readyLanes.size === 0) {
          sendEvent({ type: "error", message: error.message });
          sendEvent({ type: "state", state: "error", message: error.message });
          clearSessionReadyTimeout();
          settled = true;
          reject(error);
        }
      });

        onSocketClose(socket, (code, reason) => {
        const isCurrentSocket = realtimeSockets.includes(socket);
        logLatency("ws_close", {
          code,
          reason,
          isCurrentSocket,
          lane,
          raceSockets: raceCount
        });
        if (isCurrentSocket) {
          realtimeSockets = realtimeSockets.filter((candidate) => candidate !== socket);
          realtimeSocket = realtimeSockets[0] || null;
        }
        if (code !== 1000 && code !== 1005) {
          const detail = reason.toString() || `WebSocket closed with code ${code}`;
          if (!settled && !realtimeSockets.length) {
            sendEvent({ type: "error", message: detail });
            clearSessionReadyTimeout();
            settled = true;
            reject(new Error(detail));
          }
        }
        if (isCurrentSocket && !realtimeSockets.length) {
          activeConfig = null;
          sendEvent({ type: "state", state: "idle" });
        }
      });
      }
    })().catch((error: unknown) => {
      clearSessionReadyTimeout();
      settled = true;
      reject(error instanceof Error ? error : new Error("Could not create Realtime WebSocket."));
    });
  });
}

function connectTranscription(config: TranslatorConfig) {
  const apiKey = getApiKey();

  return new Promise<void>((resolve, reject) => {
    const model = process.env.OPENAI_REALTIME_TRANSCRIPTION_MODEL || "gpt-realtime-whisper";
    const url = `${openAiRealtimeWsBaseUrl()}/v1/realtime?intent=transcription`;
    const language = transcriptionLanguageCode(config.sourceLanguage);
    const connectStartedAt = Date.now();
    let settled = false;
    let readyTimeout: NodeJS.Timeout | undefined;

    closeTranscriptionSocket(1000, "replacing transcription socket");
    resetTranscriptionState();
    transcriptionConfig = config;
    transcriptionSilenceHoldMs = transcriptionSilenceHoldMsFor(config);

    logLatency("transcription_connect_start", {
      model,
      sourceLanguage: config.sourceLanguage,
      sourceLanguageCode: language,
      silenceHoldMs: transcriptionSilenceHoldMs
    });

    void (async () => {
      const socket = await createRealtimeSocket(url, {
        Authorization: `Bearer ${apiKey}`,
        "OpenAI-Safety-Identifier": "co-translator-local-desktop"
      });
      transcriptionSocket = socket;

      const markReady = (reason: string) => {
      if (settled) {
        return;
      }
      if (readyTimeout) {
        clearTimeout(readyTimeout);
        readyTimeout = undefined;
      }
      settled = true;
      logLatency("transcription_session_ready", {
        reason,
        readyMs: Date.now() - connectStartedAt
      });
      flushPendingTranscriptionAudio();
      resolve();
    };

      readyTimeout = setTimeout(() => {
      markReady("transcription_session_update_ack_timeout");
    }, 3000);

      onSocketOpen(socket, () => {
      logLatency("transcription_ws_open", {
        connectMs: Date.now() - connectStartedAt
      });
      const transcription: Record<string, string> = { model };
      if (language) {
        transcription.language = language;
      }
      socket.send(
        JSON.stringify({
          type: "session.update",
          session: {
            type: "transcription",
            audio: {
              input: {
                format: {
                  type: "audio/pcm",
                  rate: 24000
                },
                transcription,
                turn_detection: null
              }
            }
          }
        })
      );
      logLatency("transcription_session_update_sent", {
        sourceLanguageCode: language,
        silenceHoldMs: transcriptionSilenceHoldMs
      });
    });

      onSocketMessage(socket, (data) => {
      const event = parseRealtimeEvent(data);
      if (!event) {
        return;
      }
      if (event.type === "session.updated") {
        markReady("session_updated");
        return;
      }
      handleTranscriptionEvent(event);
    });

      onSocketError(socket, (error) => {
      logLatency("transcription_ws_error", {
        message: error.message
      });
      if (!settled) {
        if (readyTimeout) {
          clearTimeout(readyTimeout);
          readyTimeout = undefined;
        }
        settled = true;
        reject(error);
      } else {
        sendEvent({ type: "error", message: error.message });
      }
    });

      onSocketClose(socket, (code, reason) => {
      const isCurrentSocket = transcriptionSocket === socket;
      logLatency("transcription_ws_close", {
        code,
        reason,
        isCurrentSocket
      });
      if (isCurrentSocket) {
        transcriptionSocket = null;
        transcriptionConfig = null;
      }
      if (!settled && code !== 1000 && code !== 1005) {
        if (readyTimeout) {
          clearTimeout(readyTimeout);
          readyTimeout = undefined;
        }
        settled = true;
        reject(new Error(reason || `Transcription WebSocket closed with code ${code}`));
      }
    });
    })().catch((error: unknown) => {
      if (readyTimeout) {
        clearTimeout(readyTimeout);
        readyTimeout = undefined;
      }
      settled = true;
      reject(error instanceof Error ? error : new Error("Could not create transcription WebSocket."));
    });
  });
}

async function ensureTranscriptionConnected(config: TranslatorConfig) {
  transcriptionSilenceHoldMs = transcriptionSilenceHoldMsFor(config);
  if (transcriptionSocketIsOpen() && sameTranscriptionConfig(transcriptionConfig, config)) {
    logLatency("transcription_warm_reused", {
      sourceLanguage: config.sourceLanguage,
      sourceLanguageCode: transcriptionLanguageCode(config.sourceLanguage)
    });
    flushPendingTranscriptionAudio();
    return;
  }

  if (transcriptionConnectPromise && sameTranscriptionConfig(transcriptionConfig, config)) {
    logLatency("transcription_wait_for_warm_socket", {
      sourceLanguage: config.sourceLanguage,
      sourceLanguageCode: transcriptionLanguageCode(config.sourceLanguage)
    });
    await transcriptionConnectPromise;
    return;
  }

  transcriptionConnectPromise = connectTranscription(config).finally(() => {
    transcriptionConnectPromise = null;
  });
  await transcriptionConnectPromise;
}

function parseRealtimeEvent(raw: string) {
  try {
    return JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function handleRealtimeEvent(event: Record<string, unknown>, lane = 0, raceCount = 1) {
  if (typeof event.type === "string" && !seenRealtimeEventTypes.has(event.type)) {
    seenRealtimeEventTypes.add(event.type);
    logLatency("realtime_event_type_seen", {
      type: event.type,
      lane,
      raceSockets: raceCount
    });
  }

  if (isRealtimeTranscriptEvent(event.type) && !isStreaming) {
    logLatency("realtime_transcript_ignored_while_idle", {
      type: event.type,
      lane,
      raceSockets: raceCount
    });
    return;
  }

  if (event.type === "error") {
    const error = event.error as { message?: string } | undefined;
    logLatency("api_error", {
      message: error?.message || "Realtime API error",
      lane,
      raceSockets: raceCount
    });
    if (raceCount === 1 || realtimeWinnerLane === undefined) {
      sendEvent({ type: "error", message: error?.message || "Realtime API error" });
    }
    return;
  }

  if (
    raceCount > 1 &&
    realtimeWinnerLane === undefined &&
    (event.type === "session.input_transcript.delta" || event.type === "session.input_transcript.done") &&
    lane !== 0
  ) {
    return;
  }

  if (
    raceCount > 1 &&
    realtimeWinnerLane === undefined &&
    event.type !== "session.input_transcript.delta" &&
    event.type !== "session.input_transcript.done"
  ) {
    const transcriptDelta = typeof event.delta === "string" ? event.delta : "";
    const transcriptDone = typeof event.transcript === "string" ? event.transcript : "";
    if (
      (event.type === "session.output_transcript.delta" && transcriptDelta) ||
      (event.type === "session.output_transcript.done" && transcriptDone)
    ) {
      realtimeWinnerLane = lane;
      logLatency("realtime_text_winner_lane", {
        lane,
        raceSockets: raceCount
      });
    } else {
      return;
    }
  }
  if (
    raceCount > 1 &&
    realtimeWinnerLane !== undefined &&
    event.type !== "session.input_transcript.delta" &&
    event.type !== "session.input_transcript.done" &&
    lane !== realtimeWinnerLane
  ) {
    return;
  }

  if (event.type === "session.input_transcript.delta") {
    if (transcriptionSocket && currentTranscriptionText()) {
      return;
    }
    const delta = typeof event.delta === "string" ? event.delta : "";
    if (delta) {
      sourceSegmentText += delta;
      if (latencySnapshot.speechToInputTranscriptMs === undefined && firstSpeechAt !== undefined) {
        logLatency("first_source_transcript_delta", {
          speechToInputTranscriptMs: Date.now() - firstSpeechAt,
          deltaChars: delta.length
        });
        publishLatency({
          speechToInputTranscriptMs: Date.now() - firstSpeechAt,
          rootCause: "API has started source transcription"
        }, true);
      }
      markRealtimeTranscriptUpdated();
      sendEvent({ type: "sourceTranscript", text: joinTranscript(finalizedSourceText, sourceSegmentText), final: false });
    }
    return;
  }

  if (event.type === "session.input_transcript.done") {
    if (transcriptionSocket && currentTranscriptionText()) {
      return;
    }
    const transcript = typeof event.transcript === "string" ? event.transcript : sourceSegmentText;
    if (transcript) {
      logLatency("source_transcript_done", {
        chars: transcript.length
      });
      finalizedSourceText = joinTranscript(finalizedSourceText, transcript.trim());
      sourceSegmentText = "";
      markRealtimeTranscriptUpdated();
      sendEvent({ type: "sourceTranscript", text: finalizedSourceText, final: true });
    }
    return;
  }

  if (event.type === "session.output_transcript.delta") {
    const delta = typeof event.delta === "string" ? event.delta : "";
    if (delta) {
      targetSegmentText += delta;
      if (latencySnapshot.speechToTargetMs === undefined && firstSpeechAt !== undefined) {
        const now = Date.now();
        logLatency("first_target_transcript_delta", {
          speechToTargetMs: now - firstSpeechAt,
          firstAudioToTargetMs: firstAudioSentAt === undefined ? undefined : now - firstAudioSentAt,
          deltaChars: delta.length
        });
        publishLatency({
          speechToTargetMs: now - firstSpeechAt,
          firstAudioToTargetMs: firstAudioSentAt === undefined ? undefined : now - firstAudioSentAt,
          rootCause: "Streaming translated text"
        }, true);
      }
      markRealtimeTranscriptUpdated();
      sendEvent({ type: "targetTranslation", text: joinTranscript(finalizedTargetText, targetSegmentText), final: false });
    }
    return;
  }

  if (event.type === "session.output_transcript.done") {
    const transcript = typeof event.transcript === "string" ? event.transcript : targetSegmentText;
    if (transcript) {
      logLatency("target_transcript_done", {
        chars: transcript.length
      });
      finalizedTargetText = joinTranscript(finalizedTargetText, transcript.trim());
      targetSegmentText = "";
      markRealtimeTranscriptUpdated();
      sendEvent({ type: "targetTranslation", text: finalizedTargetText, final: true });
    }
  }
}

function isRealtimeTranscriptEvent(type: unknown) {
  return (
    type === "session.input_transcript.delta" ||
    type === "session.input_transcript.done" ||
    type === "session.output_transcript.delta" ||
    type === "session.output_transcript.done"
  );
}

function markRealtimeTranscriptUpdated() {
  lastRealtimeTranscriptAt = Date.now();
  const waiters = realtimeTranscriptWaiters;
  realtimeTranscriptWaiters = [];
  for (const wake of waiters) {
    wake();
  }
}

function handleTranscriptionEvent(event: Record<string, unknown>) {
  if (event.type === "error") {
    const error = event.error as { message?: string } | undefined;
    logLatency("transcription_api_error", {
      message: error?.message || "Realtime transcription API error"
    });
    sendEvent({ type: "error", message: error?.message || "Realtime transcription API error" });
    return;
  }

  if (event.type !== "conversation.item.input_audio_transcription.delta" && event.type !== "conversation.item.input_audio_transcription.completed") {
    return;
  }

  const itemId = typeof event.item_id === "string" ? event.item_id : "default";
  if (!transcriptionItemText.has(itemId)) {
    transcriptionItemOrder.push(itemId);
    transcriptionItemText.set(itemId, "");
    transcriptionItemSeparator.set(itemId, transcriptionItemOrder.length === 1 ? "" : pendingTranscriptionItemSeparators.shift() ?? "\n");
  }

  if (event.type === "conversation.item.input_audio_transcription.delta") {
    const delta = typeof event.delta === "string" ? event.delta : "";
    if (!delta) {
      return;
    }
    transcriptionItemText.set(itemId, `${transcriptionItemText.get(itemId) || ""}${delta}`);
    logLatency("transcription_delta", {
      itemId,
      deltaChars: delta.length
    });
    markTranscriptionTranscriptUpdated();
    sendEvent({ type: "sourceTranscript", text: currentTranscriptionText(), final: false });
    return;
  }

  const transcript = typeof event.transcript === "string" ? event.transcript.trim() : "";
  if (!transcript) {
    return;
  }
  transcriptionItemText.set(itemId, transcript);
  logLatency("transcription_completed", {
    itemId,
    chars: transcript.length
  });
  markTranscriptionTranscriptUpdated();
  sendEvent({ type: "sourceTranscript", text: currentTranscriptionText(), final: true });
}

function markTranscriptionTranscriptUpdated() {
  lastTranscriptionTranscriptAt = Date.now();
  const waiters = transcriptionTranscriptWaiters;
  transcriptionTranscriptWaiters = [];
  for (const wake of waiters) {
    wake();
  }
}

function currentTranscriptionText() {
  let text = "";
  for (const itemId of transcriptionItemOrder) {
    const itemText = transcriptionItemText.get(itemId)?.trim();
    if (itemText) {
      const separator = text ? transcriptionItemSeparator.get(itemId) ?? "\n" : "";
      text = `${text}${separator}${normalizeTranscriptWhitespace(itemText)}`;
    }
  }
  return text;
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

async function startSession(rawConfig: unknown) {
  const config = validateConfig(rawConfig);
  clearWarmCloseTimer();
  clearTranslationClientSecretRefreshTimer();
  isStreaming = true;
  startLogSession();
  logLatency("translator_start", {
    sourceLanguage: config.sourceLanguage,
    targetLanguage: config.targetLanguage,
    latencyMode: config.latencyMode,
    reusedWarmSocket: socketIsOpen() && sameSessionConfig(activeConfig, config)
  });

  if (!socketIsOpen() && warmConnectPromise && sameSessionConfig(activeConfig, config)) {
    logLatency("translator_wait_for_warm_socket");
    await warmConnectPromise;
  }

  if (socketIsOpen() && sameSessionConfig(activeConfig, config)) {
    latencyConfig = getLatencyConfig(config.latencyMode);
    resetStreamingState();
    if (shouldOpenSeparateTranscriptionSocket(config)) {
      await ensureTranscriptionConnected(config);
    } else {
      closeTranscriptionSocket(1000, "transcription disabled");
    }
    sendEvent({ type: "state", state: "connected", message: "Using warm Realtime socket" });
    publishLatency({ rootCause: "Warm WebSocket reused; waiting for speech" }, true);
    return;
  }

  closeRealtimeSockets(1000, "starting new realtime session");
  sendEvent({ type: "state", state: "connecting", message: "Connecting to OpenAI Realtime" });
  if (shouldOpenSeparateTranscriptionSocket(config)) {
    await Promise.all([connectRealtime(config), ensureTranscriptionConnected(config)]);
  } else {
    closeTranscriptionSocket(1000, "transcription disabled");
    await connectRealtime(config);
  }
}

async function startTranslationCall(rawConfig: unknown): Promise<TranslationCallStart> {
  const config = validateConfig(rawConfig);
  clearWarmCloseTimer();
  clearTranslationClientSecretRefreshTimer();
  isStreaming = true;
  startLogSession();
  resetStreamingState();
  latencyConfig = getLatencyConfig(config.latencyMode);
  activeConfig = config;
  logLatency("translator_start", {
    sourceLanguage: config.sourceLanguage,
    targetLanguage: config.targetLanguage,
    latencyMode: config.latencyMode,
    transport: "webrtc",
    reusedTranslationClientSecret: translationClientSecretIsFresh(config)
  });
  sendEvent({ type: "state", state: "connecting", message: "Connecting WebRTC translation" });
  const [clientSecret] = await Promise.all([
    getTranslationClientSecret(config),
    shouldOpenSeparateTranscriptionSocket(config)
      ? ensureTranscriptionConnected(config)
      : Promise.resolve(closeTranscriptionSocket(1000, "transcription disabled"))
  ]);
  return { clientSecret };
}

async function stopSession() {
  logLatency("translator_stop", latencySnapshot);
  sendEvent({ type: "state", state: "stopping", message: "Stopping" });
  await stopTranscriptionSocket();
  await waitForRealtimeTranscriptSettled("translator_stop");
  flushRealtimeTranscriptSnapshot("translator_stop");
  isStreaming = false;
  scheduleWarmClose("translator stop");
  pendingAudioChunks = [];
  pendingTranscriptionAudioChunks = [];
  firstSpeechAt = undefined;
  firstAudioSentAt = undefined;
  sendEvent({ type: "state", state: warmResourceIsOpen() ? "warm" : "idle", message: warmResourceIsOpen() ? "Warm socket ready" : "idle" });
}

async function apiKeyStatusCommand(): Promise<ApiKeyStatus> {
  return getApiKeyStatus();
}

async function apiPricingCommand(): Promise<ApiPricing> {
  return getApiPricing();
}

async function setApiKeyCommand(apiKey: unknown): Promise<ApiKeyStatus> {
  return writeStoredApiKey(validateApiKey(apiKey));
}

async function openApiKeyPageCommand() {
  await openExternal(apiKeyPageUrl);
}

async function meetingTranscribeCommand(rawRequest: unknown): Promise<MeetingTranscriptionResult> {
  return transcribeMeetingAudio(validateMeetingTranscriptionRequest(rawRequest));
}

async function saveMeetingAudioChunkCommand(rawRequest: unknown): Promise<void> {
  await saveMeetingAudioChunk(validateMeetingAudioChunkSaveRequest(rawRequest));
}

async function warmSession(rawConfig: unknown) {
  const config = validateConfig(rawConfig);
  if (isStreaming) {
    return;
  }

  if (!sessionId) {
    startLogSession();
  }

  if (config.latencyMode === "webrtc") {
    if (realtimeSockets.length) {
      logLatency("warm_close_websocket_for_webrtc");
      closeRealtimeSockets(1000, "switching to WebRTC translation");
      activeConfig = null;
    }
    await Promise.all([
      getTranslationClientSecret(config),
      shouldOpenSeparateTranscriptionSocket(config)
        ? ensureTranscriptionConnected(config)
        : Promise.resolve(closeTranscriptionSocket(1000, "transcription disabled"))
    ]);
    scheduleTranslationClientSecretRefresh(config);
    scheduleWarmClose("webrtc warm connected");
    sendEvent({ type: "state", state: "warm", message: "Warm translation token ready" });
    return;
  }

  clearTranslationClientSecretRefreshTimer();

  if (socketIsOpen() && sameSessionConfig(activeConfig, config)) {
    logLatency("warm_reuse_existing_socket", {
      targetLanguage: config.targetLanguage,
      latencyMode: config.latencyMode
    });
    if (shouldOpenSeparateTranscriptionSocket(config)) {
      await ensureTranscriptionConnected(config);
    } else {
      closeTranscriptionSocket(1000, "transcription disabled");
    }
    scheduleWarmClose("warm refresh");
    sendEvent({ type: "state", state: "warm", message: "Warm socket ready" });
    return;
  }

  if (warmConnectPromise && sameSessionConfig(activeConfig, config)) {
    logLatency("warm_already_connecting", {
      targetLanguage: config.targetLanguage,
      latencyMode: config.latencyMode
    });
    await warmConnectPromise;
    if (shouldOpenSeparateTranscriptionSocket(config)) {
      await ensureTranscriptionConnected(config);
    } else {
      closeTranscriptionSocket(1000, "transcription disabled");
    }
    scheduleWarmClose("warm connected");
    sendEvent({ type: "state", state: "warm", message: "Warm socket ready" });
    return;
  }

  if (realtimeSockets.length) {
    logLatency("warm_reconnect_for_config", {
      targetLanguage: config.targetLanguage,
      latencyMode: config.latencyMode
    });
    closeRealtimeSockets(1000, "warm reconnect");
  }

  warmConnectPromise = connectRealtime(config, "warm").finally(() => {
    warmConnectPromise = null;
  });
  await Promise.all([
    warmConnectPromise,
    shouldOpenSeparateTranscriptionSocket(config)
      ? ensureTranscriptionConnected(config)
      : Promise.resolve(closeTranscriptionSocket(1000, "transcription disabled"))
  ]);
  scheduleWarmClose("warm connected");
  sendEvent({ type: "state", state: "warm", message: "Warm socket ready" });
}

function resetStreamingState() {
  resetRealtimeState();
  resetTranscriptionState();
}

function resetRealtimeState() {
  finalizedSourceText = "";
  finalizedTargetText = "";
  sourceSegmentText = "";
  targetSegmentText = "";
  pendingAudioChunks = [];
  latencySnapshot = createLatencySnapshot();
  firstSpeechAt = undefined;
  firstAudioSentAt = undefined;
  seenRealtimeEventTypes = new Set<string>();
  lastLatencyPublishAt = 0;
  lastRealtimeTranscriptAt = 0;
  realtimeTranscriptWaiters = [];
  preSpeechChunksSent = 0;
  realtimeWinnerLane = undefined;
}

function resetTranscriptionState() {
  pendingTranscriptionAudioChunks = [];
  transcriptionItemOrder = [];
  transcriptionItemText = new Map<string, string>();
  transcriptionItemSeparator = new Map<string, string>();
  pendingTranscriptionItemSeparators = [];
  transcriptionBufferHasAudio = false;
  transcriptionBufferHasSpeech = false;
  transcriptionBufferedAudioMs = 0;
  transcriptionCommittedItemCount = 0;
  nextTranscriptionItemSeparator = " ";
  transcriptionSpeechActive = false;
  transcriptionSilentMs = 0;
  transcriptionSilenceHoldMs = DEFAULT_TRANSCRIPTION_SILENCE_HOLD_MS;
  transcriptionLastSpeechEndedAt = undefined;
  lastTranscriptionTranscriptAt = 0;
  transcriptionTranscriptWaiters = [];
}

function receiveAudio(rawChunk: unknown) {
  const chunk = validateAudioChunk(rawChunk);
  if (!chunk) {
    return;
  }

  if (chunk.speechStartedAt !== undefined && firstSpeechAt === undefined) {
    firstSpeechAt = chunk.speechStartedAt;
    logLatency("local_speech_detected", {
      chunkMs: chunk.chunkMs,
      rms: chunk.rms
    });
    sendEvent({
      type: "speechActivity",
      speechStartedAt: firstSpeechAt,
      rms: chunk.rms
    });
    publishLatency({ rootCause: "Speech detected locally" }, true);
  }

  if (!openRealtimeSockets().length) {
    routeTranscriptionAudioChunk(chunk);
    if (activeConfig?.latencyMode === "webrtc" && transcriptionSocket) {
      return;
    }
    pendingAudioChunks.push(chunk);
    if (pendingAudioChunks.length > latencyConfig.maxQueuedAudioChunks) {
      pendingAudioChunks = pendingAudioChunks.slice(-latencyConfig.maxQueuedAudioChunks);
    }
    logLatency("audio_queued_waiting_for_ws", {
      queuedAudioChunks: pendingAudioChunks.length,
      chunkMs: chunk.chunkMs
    });
    publishLatency({ rootCause: "Audio waiting for WebSocket" });
    return;
  }

  sendAudioChunk(chunk);
}

function updateExitSaveState(rawState: unknown) {
  const state = validateExitSaveState(rawState);
  if (!state) {
    return;
  }
  exitSaveState = state;
}

function logUiEvent(payload: { event?: unknown; data?: unknown }) {
  if (typeof payload?.event !== "string") {
    return;
  }
  if (payload.event.length > 128) {
    return;
  }
  const data = sanitizeLogData(payload.data);
  logLatency(payload.event, data);
}

function sendAudioChunk(chunk: AudioChunk) {
  const sockets = openRealtimeSockets();
  if (!sockets.length) {
    routeTranscriptionAudioChunk(chunk);
    return;
  }

  routeTranscriptionAudioChunk(chunk);

  if (maxRealtimeBufferedAmount() > latencyConfig.maxWebSocketBufferBytes) {
    publishLatency({
      droppedAudioChunks: latencySnapshot.droppedAudioChunks + 1,
      rootCause: "Network/WebSocket backpressure"
    }, true);
    sendEvent({ type: "state", state: "connected", message: "Live, catching up" });
    return;
  }

  const now = Date.now();
  if (firstAudioSentAt === undefined) {
    firstAudioSentAt = now;
    logLatency("first_audio_sent", {
      localCaptureToSendMs: Math.max(0, now - chunk.capturedAt),
      chunkMs: chunk.chunkMs,
      rms: chunk.rms,
      afterSpeechDetected: firstSpeechAt === undefined ? undefined : now - firstSpeechAt,
      websocketBufferedBytes: maxRealtimeBufferedAmount(),
      raceSockets: sockets.length
    });
  }
  if (firstSpeechAt !== undefined && chunk.capturedAt < firstSpeechAt) {
    preSpeechChunksSent += 1;
  }
  publishLatency({
    audioChunksSent: latencySnapshot.audioChunksSent + 1,
    localCaptureToSendMs: Math.max(0, now - chunk.capturedAt),
    preSpeechChunksSent,
    rootCause: "Audio is streaming to OpenAI"
  });
  const message = JSON.stringify({
    type: "session.input_audio_buffer.append",
    audio: chunk.base64Pcm16
  });
  for (const socket of sockets) {
    socket.send(message);
  }
}

function routeTranscriptionAudioChunk(chunk: AudioChunk) {
  if (!transcriptionSocket && !pendingTranscriptionAudioChunks.length) {
    return;
  }
  sendTranscriptionAudioChunk(chunk);
}

function sendTranscriptionAudioChunk(chunk: AudioChunk) {
  if (!transcriptionSocket || transcriptionSocket.readyState !== websocketOpen) {
    pendingTranscriptionAudioChunks.push(chunk);
    if (pendingTranscriptionAudioChunks.length > latencyConfig.maxQueuedAudioChunks) {
      pendingTranscriptionAudioChunks = pendingTranscriptionAudioChunks.slice(-latencyConfig.maxQueuedAudioChunks);
    }
    return;
  }

  if (transcriptionSocket.bufferedAmount > latencyConfig.maxWebSocketBufferBytes) {
    logLatency("transcription_audio_dropped_backpressure", {
      bufferedBytes: transcriptionSocket.bufferedAmount,
      chunkMs: chunk.chunkMs
    });
    return;
  }

  transcriptionSocket.send(
    JSON.stringify({
      type: "input_audio_buffer.append",
      audio: chunk.base64Pcm16
    })
  );
  transcriptionBufferHasAudio = true;
  transcriptionBufferedAudioMs += chunk.chunkMs;
  updateTranscriptionCommitState(chunk);
}

function updateTranscriptionCommitState(chunk: AudioChunk) {
  if (chunk.rms >= TRANSCRIPTION_SPEECH_RMS_THRESHOLD) {
    transcriptionBufferHasSpeech = true;
    if (!transcriptionSpeechActive && transcriptionLastSpeechEndedAt !== undefined) {
      const silentGapMs = Math.max(0, chunk.capturedAt - transcriptionLastSpeechEndedAt);
      nextTranscriptionItemSeparator = silentGapMs >= TRANSCRIPTION_LONG_BREAK_MS ? "\n\n" : "\n";
    }
    transcriptionSpeechActive = true;
    transcriptionSilentMs = 0;
    maybeCommitTranscriptionAudioBuffer("low_latency_audio_window");
    return;
  }

  if (!transcriptionSpeechActive) {
    maybeCommitTranscriptionAudioBuffer("low_latency_audio_window");
    return;
  }

  transcriptionSilentMs += chunk.chunkMs;
  if (transcriptionSilentMs >= transcriptionSilenceHoldMs) {
    transcriptionLastSpeechEndedAt = Math.max(0, chunk.capturedAt - transcriptionSilentMs);
    commitTranscriptionAudioBuffer("local_silence");
    transcriptionSpeechActive = false;
    transcriptionSilentMs = 0;
    return;
  }

  maybeCommitTranscriptionAudioBuffer("low_latency_audio_window");
}

function maybeCommitTranscriptionAudioBuffer(reason: string) {
  if (transcriptionBufferedAudioMs >= LOW_LATENCY_TRANSCRIPTION_COMMIT_MS) {
    commitTranscriptionAudioBuffer(reason);
  }
}

function commitTranscriptionAudioBuffer(reason: string) {
  if (!transcriptionSocket || transcriptionSocket.readyState !== websocketOpen || !transcriptionBufferHasAudio) {
    return;
  }
  if (transcriptionBufferedAudioMs < MIN_TRANSCRIPTION_COMMIT_MS) {
    logLatency("transcription_audio_commit_skipped_short_buffer", {
      reason,
      bufferedAudioMs: transcriptionBufferedAudioMs
    });
    return;
  }

  if (transcriptionCommittedItemCount > 0) {
    pendingTranscriptionItemSeparators.push(nextTranscriptionItemSeparator);
  }
  const hadSpeech = transcriptionBufferHasSpeech;
  transcriptionSocket.send(JSON.stringify({ type: "input_audio_buffer.commit" }));
  transcriptionBufferHasAudio = false;
  transcriptionBufferHasSpeech = false;
  transcriptionBufferedAudioMs = 0;
  transcriptionCommittedItemCount += 1;
  nextTranscriptionItemSeparator = " ";
  logLatency("transcription_audio_committed", {
    reason,
    committedItems: transcriptionCommittedItemCount,
    hadSpeech
  });
}

async function stopTranscriptionSocket() {
  if (!transcriptionSocket) {
    return;
  }
  const hadBufferedAudio = transcriptionBufferHasAudio && transcriptionBufferedAudioMs >= MIN_TRANSCRIPTION_COMMIT_MS;
  commitTranscriptionAudioBuffer("translator_stop");
  await waitForTranscriptionTranscriptSettled("translator_stop", hadBufferedAudio);
  flushTranscriptionTranscriptSnapshot("translator_stop");
  if (!transcriptionSocketIsOpen()) {
    closeTranscriptionSocket(1000, "translator stop");
  }
}

async function waitForRealtimeTranscriptSettled(reason: string) {
  if (!openRealtimeSockets().length || (firstSpeechAt === undefined && !sourceSegmentText && !targetSegmentText && !lastRealtimeTranscriptAt)) {
    return;
  }

  const startedAt = Date.now();
  while (Date.now() - startedAt < STOP_TRANSCRIPT_SETTLE_MAX_MS) {
    const pendingSegment = Boolean(sourceSegmentText || targetSegmentText);
    const quietForMs = lastRealtimeTranscriptAt ? Date.now() - lastRealtimeTranscriptAt : 0;
    if (!pendingSegment && quietForMs >= STOP_TRANSCRIPT_SETTLE_QUIET_MS) {
      logLatency("realtime_stop_transcript_settled", {
        reason,
        settleMs: Date.now() - startedAt,
        quietForMs
      });
      return;
    }
    await waitForRealtimeTranscriptUpdate(Math.min(120, STOP_TRANSCRIPT_SETTLE_MAX_MS - (Date.now() - startedAt)));
  }

  logLatency("realtime_stop_transcript_settle_timeout", {
    reason,
    maxMs: STOP_TRANSCRIPT_SETTLE_MAX_MS,
    sourceSegmentChars: sourceSegmentText.length,
    targetSegmentChars: targetSegmentText.length
  });
}

function flushRealtimeTranscriptSnapshot(reason: string) {
  if ((!transcriptionSocket || !currentTranscriptionText()) && sourceSegmentText) {
    finalizedSourceText = joinTranscript(finalizedSourceText, sourceSegmentText);
    sourceSegmentText = "";
    sendEvent({ type: "sourceTranscript", text: finalizedSourceText, final: true });
  }
  if (targetSegmentText) {
    finalizedTargetText = joinTranscript(finalizedTargetText, targetSegmentText);
    targetSegmentText = "";
    sendEvent({ type: "targetTranslation", text: finalizedTargetText, final: true });
  } else if (finalizedTargetText) {
    sendEvent({ type: "targetTranslation", text: finalizedTargetText, final: true });
  }
  logLatency("realtime_stop_transcript_flushed", {
    reason,
    sourceChars: finalizedSourceText.length,
    targetChars: finalizedTargetText.length
  });
}

function waitForRealtimeTranscriptUpdate(timeoutMs: number) {
  if (timeoutMs <= 0) {
    return Promise.resolve();
  }
  return new Promise<void>((resolve) => {
    const wake = () => {
      clearTimeout(timer);
      realtimeTranscriptWaiters = realtimeTranscriptWaiters.filter((candidate) => candidate !== wake);
      resolve();
    };
    const timer = setTimeout(wake, timeoutMs);
    realtimeTranscriptWaiters.push(wake);
  });
}

async function waitForTranscriptionTranscriptSettled(reason: string, hadBufferedAudio: boolean) {
  if (!hadBufferedAudio && !transcriptionItemOrder.length && !lastTranscriptionTranscriptAt) {
    return;
  }

  const startedAt = Date.now();
  while (Date.now() - startedAt < STOP_TRANSCRIPT_SETTLE_MAX_MS) {
    const quietForMs = lastTranscriptionTranscriptAt ? Date.now() - lastTranscriptionTranscriptAt : 0;
    if (lastTranscriptionTranscriptAt && quietForMs >= STOP_TRANSCRIPT_SETTLE_QUIET_MS) {
      logLatency("transcription_stop_transcript_settled", {
        reason,
        settleMs: Date.now() - startedAt,
        quietForMs
      });
      return;
    }
    if (!hadBufferedAudio && !lastTranscriptionTranscriptAt) {
      return;
    }
    await waitForTranscriptionTranscriptUpdate(Math.min(120, STOP_TRANSCRIPT_SETTLE_MAX_MS - (Date.now() - startedAt)));
  }

  logLatency("transcription_stop_transcript_settle_timeout", {
    reason,
    maxMs: STOP_TRANSCRIPT_SETTLE_MAX_MS,
    items: transcriptionItemOrder.length
  });
}

function flushTranscriptionTranscriptSnapshot(reason: string) {
  const text = currentTranscriptionText();
  if (text) {
    sendEvent({ type: "sourceTranscript", text, final: true });
  }
  logLatency("transcription_stop_transcript_flushed", {
    reason,
    chars: text.length
  });
}

function waitForTranscriptionTranscriptUpdate(timeoutMs: number) {
  if (timeoutMs <= 0) {
    return Promise.resolve();
  }
  return new Promise<void>((resolve) => {
    const wake = () => {
      clearTimeout(timer);
      transcriptionTranscriptWaiters = transcriptionTranscriptWaiters.filter((candidate) => candidate !== wake);
      resolve();
    };
    const timer = setTimeout(wake, timeoutMs);
    transcriptionTranscriptWaiters.push(wake);
  });
}

function flushPendingAudio() {
  const chunks = pendingAudioChunks;
  pendingAudioChunks = [];
  if (chunks.length) {
    logLatency("flush_pending_audio", {
      chunks: chunks.length
    });
  }
  for (const chunk of chunks) {
    sendAudioChunk(chunk);
  }
}

function flushPendingTranscriptionAudio() {
  const chunks = pendingTranscriptionAudioChunks;
  pendingTranscriptionAudioChunks = [];
  if (chunks.length) {
    logLatency("flush_pending_transcription_audio", {
      chunks: chunks.length
    });
  }
  for (const chunk of chunks) {
    sendTranscriptionAudioChunk(chunk);
  }
}

loadEnv();

void startBridgeServer().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});

process.on("SIGINT", () => {
  shutdown();
  process.exit(0);
});

process.on("SIGTERM", () => {
  shutdown();
  process.exit(0);
});

function shutdown() {
  clearWarmCloseTimer();
  clearTranslationClientSecretRefreshTimer();
  closeRealtimeSockets(1000, "backend shutdown");
  closeTranscriptionSocket(1000, "backend shutdown");
}

async function startBridgeServer() {
  if (isBunRuntime()) {
    const bun = (globalThis as {
      Bun?: {
        serve: (options: {
          hostname: string;
          port: number;
          fetch: (request: Request, server: { upgrade: (request: Request) => boolean }) => Response | undefined;
          websocket: {
            open: (socket: BridgeSocket) => void;
            message: (socket: BridgeSocket, data: string | Buffer) => void;
            close: (socket: BridgeSocket) => void;
          };
        }) => { port: number };
      };
    }).Bun;
    if (!bun) {
      throw new Error("Bun runtime is unavailable.");
    }
    const server = bun.serve({
      hostname: "127.0.0.1",
      port: bridgePort,
      fetch(request, server) {
        const url = new URL(request.url);
        if (url.pathname === "/health") {
          return new Response(JSON.stringify({ ok: true }), {
            headers: {
              "Content-Type": "application/json",
              "Access-Control-Allow-Origin": "*"
            }
          });
        }
        if (url.pathname === "/bridge") {
          if (!bridgeRequestIsAuthorized(request.url, request.headers.get("Origin"))) {
            return new Response("Forbidden", { status: 403 });
          }
          if (server.upgrade(request)) {
            return undefined;
          }
        }
        return new Response("Not found", { status: 404 });
      },
      websocket: {
        open(socket) {
          bridgeClients.add(socket);
        },
        message(socket, data) {
          void handleBridgeMessage(socket, data.toString());
        },
        close(socket) {
          bridgeClients.delete(socket);
        }
      }
    });
    logLatency("bridge_server_listening", {
      port: server.port,
      userDataDir: userDataDir(),
      runtime: "bun"
    });
    return;
  }

  const server = http.createServer((request, response) => {
    if (request.url === "/health") {
      response.writeHead(200, {
        "Content-Type": "application/json",
        "Access-Control-Allow-Origin": "*"
      });
      response.end(JSON.stringify({ ok: true }));
      return;
    }
    response.writeHead(404);
    response.end();
  });
  const { WebSocketServer } = await import("ws");
  const wss = new WebSocketServer({
    server,
    path: "/bridge",
    maxPayload: maxBridgeMessageBytes,
    verifyClient(info, done) {
      done(bridgeRequestIsAuthorized(info.req.url, info.origin));
    }
  });

  wss.on("connection", (socket) => {
    bridgeClients.add(socket);
    socket.on("message", (data) => {
      void handleBridgeMessage(socket, data.toString());
    });
    socket.on("close", () => {
      bridgeClients.delete(socket);
    });
  });

  server.listen(bridgePort, "127.0.0.1", () => {
    logLatency("bridge_server_listening", {
      port: bridgePort,
      userDataDir: userDataDir(),
      runtime: "node"
    });
  });
}

async function handleBridgeMessage(socket: BridgeSocket, raw: string) {
  let message: unknown;
  try {
    message = JSON.parse(raw);
  } catch {
    return;
  }
  if (!isRecord(message) || typeof message.command !== "string") {
    return;
  }
  const command = message.command;
  const payload = message.payload;

  if (message.id === undefined) {
    void runBridgeCommand(command, payload).catch((error: unknown) => {
      logLatency("bridge_fire_and_forget_error", {
        command,
        message: error instanceof Error ? error.message : "Bridge command failed."
      });
    });
    return;
  }

  if (typeof message.id !== "string") {
    return;
  }

  try {
    const result = await runBridgeCommand(command, payload);
    socket.send(JSON.stringify({ id: message.id, ok: true, result }));
  } catch (error) {
    const bridgeError = error instanceof Error ? error.message : "Bridge command failed.";
    socket.send(JSON.stringify({ id: message.id, ok: false, error: bridgeError }));
  }
}

async function runBridgeCommand(command: string, payload: unknown) {
  switch (command) {
    case "translator:warm":
      return warmSession(payload);
    case "translator:start":
      return startSession(payload);
    case "translator:start-translation-call":
      return startTranslationCall(payload);
    case "translator:stop":
      return stopSession();
    case "translator:get-api-key-status":
      return apiKeyStatusCommand();
    case "translator:get-api-pricing":
      return apiPricingCommand();
    case "translator:set-api-key":
      return setApiKeyCommand(payload);
    case "translator:open-api-key-page":
      return openApiKeyPageCommand();
    case "translator:meeting-transcribe":
      return meetingTranscribeCommand(payload);
    case "translator:save-meeting-audio-chunk":
      return saveMeetingAudioChunkCommand(payload);
    case "translator:exit-save-state":
      updateExitSaveState(payload);
      return undefined;
    case "translator:audio":
      receiveAudio(payload);
      return undefined;
    case "translator:ui-log":
      logUiEvent(payload as { event?: unknown; data?: unknown });
      return undefined;
    case "translator:save-exit-texts":
      if (!isRecord(payload) || typeof payload.directory !== "string") {
        throw new Error("Save directory is required.");
      }
      return saveExitTexts(payload.directory);
    default:
      throw new Error(`Unknown bridge command: ${command}`);
  }
}

function broadcast(payload: unknown) {
  const serialized = JSON.stringify(payload);
  for (const client of bridgeClients) {
    if (client.readyState === undefined || client.readyState === websocketOpen) {
      client.send(serialized);
    }
  }
}

function openExternal(url: string) {
  const opener = process.platform === "darwin" ? "open" : process.platform === "win32" ? "cmd" : "xdg-open";
  const args = process.platform === "win32" ? ["/c", "start", "", url] : [url];
  return new Promise<void>((resolve, reject) => {
    const child = spawn(opener, args, { stdio: "ignore", detached: true });
    child.on("error", reject);
    child.on("spawn", () => {
      child.unref();
      resolve();
    });
  });
}
