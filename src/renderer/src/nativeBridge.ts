import type {
  ApiKeyStatus,
  ApiPricing,
  AudioChunk,
  ExitSaveState,
  MainToRendererEvent,
  MeetingAudioChunkSaveRequest,
  MeetingTranscriptionRequest,
  MeetingTranscriptionResult,
  TranslationCallStart,
  TranslatorApi,
  TranslatorConfig
} from "../../shared/types";

type BridgeResponse = {
  id: string;
  ok: boolean;
  result?: unknown;
  error?: string;
};

type PendingCall = {
  resolve(value: unknown): void;
  reject(error: Error): void;
};

const viteEnv = (import.meta as unknown as { env?: Record<string, string | undefined> }).env;
const bridgePort = viteEnv?.VITE_CO_TRANSLATOR_BRIDGE_PORT || "41873";
const bridgeBaseUrl = `ws://127.0.0.1:${bridgePort}/bridge`;
const devBridgeToken = viteEnv?.VITE_CO_TRANSLATOR_BRIDGE_TOKEN;
let bridgeToken = devBridgeToken || "";
let ensureBackendPromise: Promise<void> | null = null;

type BackendReady = {
  bridgeToken?: string;
};

function bridgeUrl() {
  if (!bridgeToken) {
    return bridgeBaseUrl;
  }
  return `${bridgeBaseUrl}?token=${encodeURIComponent(bridgeToken)}`;
}

function ensureNativeBackend(): Promise<void> {
  if (!window.zero?.invoke) {
    return Promise.resolve();
  }
  ensureBackendPromise ??= window.zero.invoke<BackendReady>("coTranslator.ensureBackend").then((result) => {
    if (result?.bridgeToken) {
      bridgeToken = result.bridgeToken;
    }
  }).finally(() => {
    ensureBackendPromise = null;
  });
  return ensureBackendPromise;
}

function stopNativeBackend(): Promise<void> {
  if (!window.zero?.invoke) {
    return Promise.resolve();
  }
  return window.zero.invoke("coTranslator.stopBackend").then(() => undefined);
}

function prewarmNativeBackend() {
  if (!window.zero?.invoke) {
    return;
  }
  void window.zero.invoke("coTranslator.prewarmBackend").catch(() => undefined);
}

class NativeBridge {
  private socket: WebSocket | null = null;
  private connectPromise: Promise<void> | null = null;
  private nextId = 1;
  private pending = new Map<string, PendingCall>();
  private listeners = new Set<(event: MainToRendererEvent) => void>();

  send(command: string, payload?: unknown) {
    void this.connect().then(() => {
      const socket = this.socket;
      if (!socket || socket.readyState !== WebSocket.OPEN) {
        return;
      }
      socket.send(JSON.stringify({ command, payload }));
    }).catch(() => undefined);
  }

  invoke<T>(command: string, payload?: unknown): Promise<T> {
    return this.connect().then(() => new Promise<T>((resolve, reject) => {
      const socket = this.socket;
      if (!socket || socket.readyState !== WebSocket.OPEN) {
        reject(new Error("Co Translator backend is not connected."));
        return;
      }
      const id = String(this.nextId++);
      this.pending.set(id, {
        resolve: (value) => resolve(value as T),
        reject
      });
      socket.send(JSON.stringify({ id, command, payload }));
    }));
  }

  invokeIfConnected<T>(command: string, payload?: unknown): Promise<T | undefined> {
    if (this.socket?.readyState !== WebSocket.OPEN) {
      return Promise.resolve(undefined);
    }
    return this.invoke<T>(command, payload);
  }

  onEvent(callback: (event: MainToRendererEvent) => void) {
    this.listeners.add(callback);
    return () => {
      this.listeners.delete(callback);
    };
  }

  private connect(): Promise<void> {
    if (this.socket?.readyState === WebSocket.OPEN) {
      return Promise.resolve();
    }
    if (this.connectPromise) {
      return this.connectPromise;
    }

    this.connectPromise = ensureNativeBackend().then(() => new Promise((resolve, reject) => {
      const url = bridgeUrl();
      const socket = new WebSocket(url);
      this.socket = socket;
      socket.onopen = () => {
        this.connectPromise = null;
        resolve();
      };
      socket.onerror = () => {
        this.connectPromise = null;
        reject(new Error(`Could not connect to Co Translator backend at ${bridgeBaseUrl}.`));
      };
      socket.onclose = () => {
        this.socket = null;
        this.connectPromise = null;
        for (const pending of this.pending.values()) {
          pending.reject(new Error("Co Translator backend disconnected."));
        }
        this.pending.clear();
      };
      socket.onmessage = (event) => this.handleMessage(event.data);
    }));
    return this.connectPromise;
  }

  private handleMessage(raw: unknown) {
    if (typeof raw !== "string") {
      return;
    }
    const message = JSON.parse(raw) as BridgeResponse | { type?: string; event?: MainToRendererEvent };
    if ("type" in message && message.type === "event" && message.event) {
      for (const listener of this.listeners) {
        listener(message.event);
      }
      return;
    }
    if (!("id" in message)) {
      return;
    }
    const pending = this.pending.get(message.id);
    if (!pending) {
      return;
    }
    this.pending.delete(message.id);
    if (message.ok) {
      pending.resolve(message.result);
    } else {
      pending.reject(new Error(message.error || "Co Translator backend command failed."));
    }
  }
}

export function installNativeBridge() {
  if (window.translator) {
    return;
  }
  const bridge = new NativeBridge();
  const api: TranslatorApi = {
    warmSession(config: TranslatorConfig) {
      return bridge.invoke<void>("translator:warm", config);
    },
    startSession(config: TranslatorConfig) {
      return bridge.invoke<void>("translator:start", config);
    },
    startTranslationCall(config: TranslatorConfig) {
      return bridge.invoke<TranslationCallStart>("translator:start-translation-call", config);
    },
    stopSession() {
      return bridge.invoke<void>("translator:stop").finally(() => {
        void stopNativeBackend().catch(() => undefined);
      });
    },
    getApiKeyStatus(): Promise<ApiKeyStatus> {
      return bridge.invoke<ApiKeyStatus>("translator:get-api-key-status");
    },
    getApiPricing(): Promise<ApiPricing> {
      return bridge.invoke<ApiPricing>("translator:get-api-pricing");
    },
    setApiKey(apiKey: string): Promise<ApiKeyStatus> {
      return bridge.invoke<ApiKeyStatus>("translator:set-api-key", apiKey);
    },
    openApiKeyPage() {
      return bridge.invoke<void>("translator:open-api-key-page");
    },
    transcribeMeetingAudio(request: MeetingTranscriptionRequest): Promise<MeetingTranscriptionResult> {
      return bridge.invoke<MeetingTranscriptionResult>("translator:meeting-transcribe", request);
    },
    saveMeetingAudioChunk(request: MeetingAudioChunkSaveRequest): Promise<void> {
      return bridge.invoke<void>("translator:save-meeting-audio-chunk", request);
    },
    updateExitSaveState(state: ExitSaveState) {
      void bridge.invokeIfConnected<void>("translator:exit-save-state", state).catch(() => undefined);
    },
    sendAudio(chunk: AudioChunk) {
      bridge.send("translator:audio", chunk);
    },
    logUiEvent(event: string, data: Record<string, unknown> = {}) {
      void bridge.invokeIfConnected<void>("translator:ui-log", { event, data }).catch(() => undefined);
    },
    onEvent(callback: (event: MainToRendererEvent) => void) {
      return bridge.onEvent(callback);
    }
  };
  window.translator = api;

  const scheduler = window as Window & {
    requestIdleCallback?: (callback: () => void, options?: { timeout?: number }) => number;
  };
  if (scheduler.requestIdleCallback) {
    scheduler.requestIdleCallback(() => prewarmNativeBackend(), { timeout: 1500 });
  } else {
    globalThis.setTimeout(prewarmNativeBackend, 500);
  }
}
