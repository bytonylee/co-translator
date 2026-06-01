import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import WebSocket from "ws";

const rootDir = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const uiUrl = process.env.LATENCY_UI_URL || "http://127.0.0.1:5173";
const startDelayMs = Number(process.env.LATENCY_MOCK_START_DELAY_MS || 80);
const voiceDelayMs = Number(process.env.LATENCY_MOCK_VOICE_DELAY_MS || 120);
const streamDelayMs = Number(process.env.LATENCY_MOCK_STREAM_DELAY_MS || 90);
const targetText = process.env.LATENCY_MOCK_TARGET_TEXT || "Hello from the latency probe";
const timeoutMs = Number(process.env.LATENCY_TIMEOUT_MS || 8000);
const startToTextTargetMs = Number(process.env.LATENCY_START_TO_TEXT_TARGET_MS || 1000);
const voiceToTextTargetMs = Number(process.env.LATENCY_VOICE_TO_TEXT_TARGET_MS || 500);
const headless = process.env.LATENCY_HEADLESS !== "0";

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function request(url, options = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request(url, options, (res) => {
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (chunk) => { body += chunk; });
      res.on("end", () => resolve({ statusCode: res.statusCode, body }));
    });
    req.on("error", reject);
    req.end();
  });
}

async function waitForHttp(url, timeout = timeoutMs) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeout) {
    try {
      const response = await request(url);
      if (response.statusCode && response.statusCode < 500) {
        return true;
      }
    } catch {
      // Keep polling until the dev server is ready.
    }
    await sleep(100);
  }
  return false;
}

async function findOpenPort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  await new Promise((resolve) => server.close(resolve));
  if (!address || typeof address === "string") {
    throw new Error("Could not allocate a local Chrome debugging port.");
  }
  return address.port;
}

function startViteIfNeeded() {
  if (process.env.LATENCY_UI_URL) {
    return null;
  }
  return spawn("npm", ["run", "dev:frontend", "--", "--host", "127.0.0.1", "--port", "5173", "--strictPort"], {
    cwd: rootDir,
    env: process.env,
    stdio: ["ignore", "pipe", "pipe"]
  });
}

function chromeExecutable() {
  if (process.env.CHROME_PATH) {
    return process.env.CHROME_PATH;
  }
  if (process.platform === "darwin") {
    return "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
  }
  return process.platform === "win32"
    ? "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe"
    : "google-chrome";
}

function startChrome(debugPort, userDataDir) {
  const args = [
    `--remote-debugging-port=${debugPort}`,
    `--user-data-dir=${userDataDir}`,
    "--no-first-run",
    "--no-default-browser-check",
    "--autoplay-policy=no-user-gesture-required",
    "--disable-background-timer-throttling",
    "--disable-renderer-backgrounding",
    "about:blank"
  ];
  if (headless) {
    args.unshift("--headless=new");
  }
  return spawn(chromeExecutable(), args, {
    stdio: ["ignore", "ignore", "pipe"]
  });
}

class CdpClient {
  constructor(socket) {
    this.socket = socket;
    this.nextId = 1;
    this.pending = new Map();
    this.events = [];
    socket.on("message", (raw) => this.handleMessage(raw.toString()));
  }

  static connect(url) {
    return new Promise((resolve, reject) => {
      const socket = new WebSocket(url);
      socket.once("open", () => resolve(new CdpClient(socket)));
      socket.once("error", reject);
    });
  }

  send(method, params = {}, sessionId) {
    const id = this.nextId++;
    const message = { id, method, params };
    if (sessionId) {
      message.sessionId = sessionId;
    }
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.socket.send(JSON.stringify(message));
    });
  }

  handleMessage(raw) {
    const message = JSON.parse(raw);
    if (message.id) {
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      if (message.error) {
        pending.reject(new Error(message.error.message || "CDP command failed."));
      } else {
        pending.resolve(message.result || {});
      }
      return;
    }
    this.events.push(message);
  }

  close() {
    this.socket.close();
  }
}

async function connectToChrome(debugPort) {
  const versionUrl = `http://127.0.0.1:${debugPort}/json/version`;
  const ready = await waitForHttp(versionUrl);
  if (!ready) {
    throw new Error("Chrome remote debugging endpoint did not become ready.");
  }
  const version = JSON.parse((await request(versionUrl)).body);
  return CdpClient.connect(version.webSocketDebuggerUrl);
}

function injectedProbeScript() {
  return `
(() => {
  const startDelayMs = ${JSON.stringify(startDelayMs)};
  const voiceDelayMs = ${JSON.stringify(voiceDelayMs)};
  const streamDelayMs = ${JSON.stringify(streamDelayMs)};
  const targetText = ${JSON.stringify(targetText)};
  const probe = {
    logs: [],
    audioContexts: [],
    streams: [],
    clickAt: null,
    startSessionCalledAt: null,
    connectedAt: null,
    voiceStartedAt: null,
    lastVoiceStartedAt: null,
    audioVoiceStartedAt: null,
    firstAudioChunkAt: null,
    firstSpeechChunkAt: null,
    targetEventSentAt: null,
    renderedTargetAt: null
  };
  const listeners = new Set();
  const now = () => performance.now();
  const push = (event, data = {}) => {
    probe.logs.push({ event, at: now(), ...data });
  };
  const emit = (event) => {
    for (const listener of listeners) listener(event);
  };
  const makeAudioStream = () => {
    const AudioContextCtor = window.AudioContext || window.webkitAudioContext;
    const streamId = probe.streams.length + 1;
    const context = new AudioContextCtor({ latencyHint: "interactive", sampleRate: 24000 });
    const destination = context.createMediaStreamDestination();
    const oscillator = context.createOscillator();
    const gain = context.createGain();
    oscillator.frequency.value = 440;
    gain.gain.value = 0;
    oscillator.connect(gain);
    gain.connect(destination);
    oscillator.start();
    window.setTimeout(() => {
      if (context.state === "suspended") void context.resume();
      const startedAt = now();
      probe.voiceStartedAt = probe.voiceStartedAt ?? startedAt;
      probe.lastVoiceStartedAt = startedAt;
      gain.gain.setValueAtTime(0.25, context.currentTime);
      push("synthetic_voice_started", { streamId });
    }, voiceDelayMs);
    probe.audioContexts.push(context);
    probe.streams.push(destination.stream);
    return destination.stream;
  };

  Object.defineProperty(navigator, "mediaDevices", {
    configurable: true,
    value: {
      async getUserMedia() {
        return makeAudioStream();
      },
      async enumerateDevices() {
        return [{ deviceId: "latency-probe-mic", groupId: "latency-probe", kind: "audioinput", label: "Latency probe microphone" }];
      }
    }
  });

  window.MediaRecorder = class MockMediaRecorder extends EventTarget {
    constructor(stream) {
      super();
      this.stream = stream;
      this.state = "inactive";
      this.mimeType = "audio/webm";
      this.ondataavailable = null;
      this.onstop = null;
    }
    start() {
      this.state = "recording";
    }
    stop() {
      this.state = "inactive";
      const event = { data: new Blob([], { type: this.mimeType }) };
      this.ondataavailable?.(event);
      this.dispatchEvent(new Event("dataavailable"));
      this.onstop?.(new Event("stop"));
      this.dispatchEvent(new Event("stop"));
    }
    static isTypeSupported() {
      return true;
    }
  };

  window.translator = {
    async warmSession() {},
    async startSession(config) {
      probe.startSessionCalledAt = now();
      push("mock_start_session", { config });
      await new Promise((resolve) => window.setTimeout(resolve, startDelayMs));
      probe.connectedAt = now();
      emit({ type: "state", state: "connected", message: "Latency probe connected" });
    },
    async startTranslationCall() {
      return { clientSecret: "latency-probe-client-secret" };
    },
    async stopSession() {
      emit({ type: "state", state: "idle", message: "Latency probe stopped" });
    },
    async getApiKeyStatus() {
      return { configured: true, storage: "environment" };
    },
    async getApiPricing() {
      return {
        realtimeTranslateUsdPerMinute: 0.034,
        realtimeTranslateUsdPerSecond: 0.00057,
        realtimeWhisperUsdPerMinute: 0.017,
        realtimeWhisperUsdPerSecond: 0.00028,
        realtimeRaceSockets: 1,
        meetingDiarizeUsdPerMinute: 0.006,
        meetingDiarizeUsdPerSecond: 0.0001,
        realtimeSourceTranscriptMode: "separate"
      };
    },
    async setApiKey() {
      return { configured: true, storage: "local" };
    },
    async openApiKeyPage() {},
    async transcribeMeetingAudio() {
      return { segments: [], text: "" };
    },
    async saveMeetingAudioChunk() {},
    updateExitSaveState() {},
    sendAudio(chunk) {
      probe.firstAudioChunkAt = probe.firstAudioChunkAt ?? now();
      if (chunk?.speechStartedAt && probe.firstSpeechChunkAt === null) {
        probe.firstSpeechChunkAt = now();
        probe.audioVoiceStartedAt = probe.lastVoiceStartedAt ?? probe.voiceStartedAt ?? probe.firstSpeechChunkAt;
        push("mock_first_speech_chunk", { rms: chunk.rms, chunkMs: chunk.chunkMs });
        emit({ type: "speechActivity", speechStartedAt: chunk.speechStartedAt, rms: chunk.rms || 0.25 });
        window.setTimeout(() => {
          probe.targetEventSentAt = now();
          push("mock_target_translation_sent");
          emit({ type: "sourceTranscript", text: "안녕하세요", final: false });
          emit({ type: "targetTranslation", text: targetText, final: false });
        }, streamDelayMs);
      }
    },
    logUiEvent(event, data = {}) {
      push(event, data);
    },
    onEvent(callback) {
      listeners.add(callback);
      return () => listeners.delete(callback);
    }
  };
  window.__latencyProbe = probe;
})();
`;
}

async function waitForExpression(cdp, sessionId, expression, timeout = timeoutMs) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeout) {
    const result = await cdp.send("Runtime.evaluate", {
      expression,
      returnByValue: true,
      awaitPromise: true
    }, sessionId);
    if (result.result?.value?.done) {
      return result.result.value;
    }
    await sleep(25);
  }
  throw new Error(`Timed out waiting for expression after ${timeout} ms.`);
}

async function main() {
  const vite = startViteIfNeeded();
  let viteOutput = "";
  vite?.stdout.on("data", (chunk) => { viteOutput += chunk.toString(); });
  vite?.stderr.on("data", (chunk) => { viteOutput += chunk.toString(); });

  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "co-translator-latency-chrome-"));
  const debugPort = await findOpenPort();
  const chrome = startChrome(debugPort, userDataDir);
  let chromeOutput = "";
  chrome.stderr.on("data", (chunk) => { chromeOutput += chunk.toString(); });

  try {
    if (!await waitForHttp(uiUrl)) {
      throw new Error(`Vite UI did not become ready at ${uiUrl}.\n${viteOutput}`);
    }

    const cdp = await connectToChrome(debugPort);
    const { targetId } = await cdp.send("Target.createTarget", { url: "about:blank" });
    const attached = await cdp.send("Target.attachToTarget", { targetId, flatten: true });
    const sessionId = attached.sessionId;
    await cdp.send("Page.enable", {}, sessionId);
    await cdp.send("Runtime.enable", {}, sessionId);
    await cdp.send("Page.addScriptToEvaluateOnNewDocument", { source: injectedProbeScript() }, sessionId);
    await cdp.send("Page.navigate", { url: uiUrl }, sessionId);

    await waitForExpression(cdp, sessionId, `(() => {
      const button = [...document.querySelectorAll("button")].find((candidate) => candidate.textContent.trim() === "Play");
      return { done: Boolean(button), text: document.body.innerText };
    })()`);

    await cdp.send("Runtime.evaluate", {
      expression: `(() => {
        const button = [...document.querySelectorAll("button")].find((candidate) => candidate.textContent.trim() === "Play");
        if (!button) throw new Error("Play button not found.");
        window.__latencyProbe.clickAt = performance.now();
        button.click();
        const watchTarget = () => {
          const target = [...document.querySelectorAll("textarea")][1]?.value || "";
          if (target.includes(${JSON.stringify(targetText)})) {
            window.__latencyProbe.renderedTargetAt = performance.now();
            return;
          }
          requestAnimationFrame(watchTarget);
        };
        requestAnimationFrame(watchTarget);
      })()`
    }, sessionId);

    const result = await waitForExpression(cdp, sessionId, `(() => {
      const textareas = [...document.querySelectorAll("textarea")];
      const target = textareas[1]?.value || "";
      const probe = window.__latencyProbe;
      const renderedAt = probe.renderedTargetAt;
      return {
        done: Boolean(renderedAt),
        renderedAt,
        target,
        probe
      };
    })()`);

    await cdp.send("Runtime.evaluate", {
      expression: `(() => {
        const button = [...document.querySelectorAll("button")].find((candidate) => candidate.textContent.trim() === "Stop");
        button?.click();
      })()`
    }, sessionId).catch(() => undefined);

    cdp.close();

    const probe = result.probe;
    const voiceStartedAt = probe.audioVoiceStartedAt ?? probe.voiceStartedAt;
    const metrics = {
      clickToConnectedMs: deltaMs(probe.connectedAt, probe.clickAt),
      clickToVoiceStartMs: deltaMs(voiceStartedAt, probe.clickAt),
      voiceStartToFirstSpeechChunkMs: deltaMs(probe.firstSpeechChunkAt, voiceStartedAt),
      voiceStartToTargetEventMs: deltaMs(probe.targetEventSentAt, voiceStartedAt),
      voiceStartToRenderedTextMs: deltaMs(result.renderedAt, voiceStartedAt),
      clickToRenderedTextMs: deltaMs(result.renderedAt, probe.clickAt),
      targetText: result.target
    };

    console.table([metrics]);
    console.log(JSON.stringify({ ok: true, metrics, logs: probe.logs }, null, 2));

    if (metrics.clickToRenderedTextMs > startToTextTargetMs) {
      throw new Error(`click-to-rendered-text ${metrics.clickToRenderedTextMs.toFixed(1)} ms exceeded ${startToTextTargetMs} ms.`);
    }
    if (metrics.voiceStartToRenderedTextMs > voiceToTextTargetMs) {
      throw new Error(`voice-start-to-rendered-text ${metrics.voiceStartToRenderedTextMs.toFixed(1)} ms exceeded ${voiceToTextTargetMs} ms.`);
    }
  } catch (error) {
    if (chromeOutput) {
      console.error(chromeOutput);
    }
    throw error;
  } finally {
    chrome.kill("SIGTERM");
    vite?.kill("SIGTERM");
    await sleep(200);
    fs.rmSync(userDataDir, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});

function deltaMs(later, earlier) {
  if (typeof later !== "number" || typeof earlier !== "number") {
    return undefined;
  }
  return later - earlier;
}
