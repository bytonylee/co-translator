import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import WebSocket, { WebSocketServer } from "ws";

const bridgePort = 41875;
const mockPort = 41876;
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "co-translator-smoke-"));
const mockHttpBase = `http://127.0.0.1:${mockPort}`;
const mockWsBase = `ws://127.0.0.1:${mockPort}`;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function startMockOpenAi() {
  const server = http.createServer((request, response) => {
    if (request.method === "POST" && request.url === "/v1/realtime/translations/client_secrets") {
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ value: "mock-client-secret", expires_at: Math.floor(Date.now() / 1000) + 60 }));
      return;
    }
    if (request.method === "POST" && request.url === "/v1/audio/transcriptions") {
      request.resume();
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(JSON.stringify({
        segments: [
          { speaker: "speaker_a", text: "안녕", start: 0, end: 1 },
          { speaker: "speaker_b", text: "세계", start: 1, end: 2 }
        ]
      }));
      return;
    }
    if (request.method === "POST" && request.url === "/v1/responses") {
      let body = "";
      request.on("data", (chunk) => { body += chunk.toString(); });
      request.on("end", () => {
        const payload = JSON.parse(body);
        if (!payload.input?.includes('"targetLanguage":"English"')) {
          response.writeHead(400, { "Content-Type": "application/json" });
          response.end(JSON.stringify({ error: { message: "target language was not sent" } }));
          return;
        }
        response.writeHead(200, { "Content-Type": "application/json" });
        response.end(JSON.stringify({
          output_text: JSON.stringify({
            segments: [
              { index: 0, text: "Hello" },
              { index: 1, text: "World" }
            ]
          })
        }));
      });
      return;
    }
    response.writeHead(404);
    response.end();
  });

  const wss = new WebSocketServer({ server });
  wss.on("connection", (socket, request) => {
    const isTranscription = request.url?.includes("intent=transcription");
    let transcriptionAppendCount = 0;
    socket.on("message", (raw) => {
      const message = JSON.parse(raw.toString());
      if (message.type === "session.update") {
        if (isTranscription && message.session?.audio?.input?.turn_detection !== null) {
          socket.send(JSON.stringify({
            type: "error",
            error: { message: "manual transcription commits must disable turn_detection" }
          }));
          return;
        }
        socket.send(JSON.stringify({ type: "session.updated" }));
        return;
      }
      if (message.type === "session.input_audio_buffer.append") {
        socket.send(JSON.stringify({ type: "session.input_transcript.delta", delta: "안녕" }));
        socket.send(JSON.stringify({ type: "session.output_transcript.delta", delta: "Hello" }));
        socket.send(JSON.stringify({ type: "session.input_transcript.done", transcript: "안녕" }));
        socket.send(JSON.stringify({ type: "session.output_transcript.done", transcript: "Hello" }));
        return;
      }
      if (isTranscription && message.type === "input_audio_buffer.append") {
        transcriptionAppendCount += 1;
        return;
      }
      if (isTranscription && message.type === "input_audio_buffer.clear") {
        transcriptionAppendCount = 0;
        socket.send(JSON.stringify({ type: "input_audio_buffer.cleared" }));
        return;
      }
      if (isTranscription && message.type === "input_audio_buffer.commit") {
        if (transcriptionAppendCount < 20) {
          socket.send(JSON.stringify({
            type: "error",
            error: { message: "Error committing input audio buffer: buffer too small." }
          }));
          return;
        }
        transcriptionAppendCount = 0;
        socket.send(JSON.stringify({
          type: "conversation.item.input_audio_transcription.delta",
          item_id: "mock-item",
          delta: "안"
        }));
        socket.send(JSON.stringify({
          type: "conversation.item.input_audio_transcription.completed",
          item_id: "mock-item",
          transcript: "안녕"
        }));
      }
    });
  });

  return new Promise((resolve) => {
    server.listen(mockPort, "127.0.0.1", () => resolve({ server, wss }));
  });
}

function startBackend() {
  if (process.env.CO_TRANSLATOR_BACKEND_COMMAND) {
    return spawn(process.env.CO_TRANSLATOR_BACKEND_COMMAND, process.env.CO_TRANSLATOR_BACKEND_ARGS?.split(" ").filter(Boolean) || [], {
      stdio: ["ignore", "pipe", "pipe"],
      env: backendEnv()
    });
  }
  const runtime = process.env.CO_TRANSLATOR_BACKEND_RUNTIME || "node";
  const entry = process.env.CO_TRANSLATOR_BACKEND_ENTRY || "dist/backend/server.js";
  const args = runtime === "node"
    ? ["--max-old-space-size=32", "--max-semi-space-size=1", entry]
    : ["--no-install", entry];
  return spawn(runtime, args, {
    stdio: ["ignore", "pipe", "pipe"],
    env: backendEnv()
  });
}

function backendEnv() {
  return {
    ...process.env,
    CO_TRANSLATOR_BRIDGE_PORT: String(bridgePort),
    CO_TRANSLATOR_USER_DATA_DIR: tempDir,
    CO_TRANSLATOR_LOG_DIR: path.join(tempDir, "logs"),
    OPENAI_API_KEY: "sk-test-integration",
    OPENAI_API_BASE_URL: mockHttpBase,
    OPENAI_REALTIME_WS_BASE_URL: mockWsBase,
    OPENAI_REALTIME_RACE_SOCKETS: "1"
  };
}

async function waitForBackend() {
  for (let index = 0; index < 50; index += 1) {
    try {
      const response = await fetch(`http://127.0.0.1:${bridgePort}/health`);
      if (response.ok) return;
    } catch {
      // Poll until backend is listening.
    }
    await sleep(100);
  }
  throw new Error("Backend did not become healthy.");
}

async function connectBridge() {
  const socket = new WebSocket(`ws://127.0.0.1:${bridgePort}/bridge`);
  await new Promise((resolve, reject) => {
    socket.once("open", resolve);
    socket.once("error", reject);
  });
  let id = 0;
  const events = [];
  socket.on("message", (raw) => {
    const message = JSON.parse(raw.toString());
    if (message.type === "event") {
      events.push(message.event);
    }
  });
  const call = (command, payload) => new Promise((resolve, reject) => {
    const currentId = String(++id);
    const onMessage = (raw) => {
      const message = JSON.parse(raw.toString());
      if (message.id !== currentId) return;
      socket.off("message", onMessage);
      message.ok ? resolve(message.result) : reject(new Error(message.error));
    };
    socket.on("message", onMessage);
    socket.send(JSON.stringify({ id: currentId, command, payload }));
  });
  const send = (command, payload) => {
    socket.send(JSON.stringify({ command, payload }));
  };
  return { socket, call, send, events };
}

async function main() {
  const mock = await startMockOpenAi();
  const backend = startBackend();
  let backendOutput = "";
  backend.stdout.on("data", (chunk) => { backendOutput += chunk.toString(); });
  backend.stderr.on("data", (chunk) => { backendOutput += chunk.toString(); });
  try {
    await waitForBackend();
    const bridge = await connectBridge();
    const config = {
      sourceLanguage: "Korean",
      targetLanguage: "English",
      latencyMode: "balanced",
      transcribeUserVoice: true
    };

    const status = await bridge.call("translator:get-api-key-status");
    if (!status?.configured) throw new Error("API key status did not use environment key.");

    const secret = await bridge.call("translator:start-translation-call", { ...config, latencyMode: "webrtc" });
    if (secret?.clientSecret !== "mock-client-secret") throw new Error("Client secret response was not bridged.");
    const webRtcCapturedAt = Date.now();
    for (let index = 0; index < 25; index += 1) {
      bridge.send("translator:audio", {
        base64Pcm16: Buffer.from(`webrtc-pcm-${index}`).toString("base64"),
        capturedAt: webRtcCapturedAt + index * 20,
        chunkMs: 20,
        rms: 0
      });
    }
    await sleep(250);
    if (!bridge.events.some((event) => event.type === "sourceTranscript" && event.text === "안")) {
      throw new Error("WebRTC presentation mode did not stream Realtime Whisper from the shared voice input.");
    }
    await bridge.call("translator:stop");

    await bridge.call("translator:warm", config);
    await bridge.call("translator:start", config);
    const speechStartedAt = Date.now();
    for (let index = 0; index < 25; index += 1) {
      bridge.send("translator:audio", {
        base64Pcm16: Buffer.from(`pcm-${index}`).toString("base64"),
        capturedAt: speechStartedAt + index * 20,
        speechStartedAt,
        chunkMs: 20,
        rms: 0.2
      });
    }
    await sleep(250);
    if (!backendOutput.includes("\"event\":\"transcription_warm_reused\"")) {
      throw new Error("Warm start did not reuse the Realtime Whisper socket.");
    }
    if (!bridge.events.some((event) => event.type === "sourceTranscript" && event.text === "안")) {
      throw new Error("Realtime Whisper transcription did not stream from the shared audio input before stop.");
    }
    if (!bridge.events.some((event) => event.type === "targetTranslation" && event.text === "Hello")) {
      throw new Error("Realtime translation did not stream from the shared audio input before stop.");
    }
    await bridge.call("translator:stop");

    const eventTypes = new Set(bridge.events.map((event) => event.type));
    for (const type of ["state", "speechActivity", "sourceTranscript", "targetTranslation"]) {
      if (!eventTypes.has(type)) throw new Error(`Missing bridged event type: ${type}`);
    }

    const diarized = await bridge.call("translator:meeting-transcribe", {
      base64Audio: Buffer.alloc(1024, 1).toString("base64"),
      mimeType: "audio/webm",
      sourceLanguage: "Korean",
      targetLanguage: "English"
    });
    if (diarized?.segments?.length !== 2) throw new Error("Meeting diarization result was not normalized.");
    if (diarized.segments[0]?.text !== "Hello" || diarized.segments[1]?.text !== "World") {
      throw new Error("Meeting diarization did not translate speaker turns into the target language.");
    }

    await bridge.call("translator:save-meeting-audio-chunk", {
      sessionId: "integration",
      sequence: 0,
      base64Audio: Buffer.from("audio").toString("base64"),
      mimeType: "audio/webm",
      capturedAt: Date.now()
    });
    const chunkPath = path.join(tempDir, "meeting-audio", "integration", "chunk-0000.webm");
    if (!fs.existsSync(chunkPath)) throw new Error("Meeting audio chunk was not persisted.");

    bridge.socket.close();
    console.log(JSON.stringify({
      ok: true,
      eventTypes: [...eventTypes].sort(),
      diarizedSegments: diarized.segments.length,
      chunkSaved: true
    }));
  } catch (error) {
    console.error(backendOutput);
    throw error;
  } finally {
    backend.kill("SIGTERM");
    mock.wss.close();
    mock.server.close();
    fs.rmSync(tempDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
