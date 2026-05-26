[English](./README.md) | [한국어](./README.ko.md)
![Version](https://img.shields.io/badge/version-0.0.1-333333?style=flat-square) [![License: Apache 2.0](https://img.shields.io/badge/License-Apache%202.0-yellow.svg)](./LICENSE)

# Co Translator

Native desktop realtime translator for macOS and Windows. The app uses Electron, React, TypeScript, and OpenAI Realtime translation. The renderer handles microphone capture and UI. The Electron main process keeps the OpenAI API key out of the renderer.

> [!WARNING]
> Windows OS has not been tested by the maintainer yet. Please check it on Windows and contribute fixes or notes to make the Windows build work well.

## Install From Terminal

Requirements:

- Node.js 20 or newer
- npm
- An OpenAI API key with Realtime API access

Run these commands from Terminal:

```bash
cd /Users/tonylee/solo/co-translator
npm install
cp .env.example .env
cp .env.example .env.local
npm run dev
```

Check the local app package version:

```bash
npm run version
npm run version:check
```

The same checks work with Bun:

```bash
bun run version
bun run version:check
```

When the app opens, click the key button in the top-right corner and paste your OpenAI API key. The app stores it only on this device. You can also put the key in `.env` and `.env.local`:

```bash
OPENAI_API_KEY=sk-your-api-key
OPENAI_REALTIME_MODEL=gpt-realtime-translate
OPENAI_REALTIME_TRANSCRIPTION_MODEL=gpt-realtime-whisper
OPENAI_REALTIME_RACE_SOCKETS=3
OPENAI_WARM_IDLE_TIMEOUT_MS=45000
```

Both `.env` and `.env.local` are ignored by Git.

## Prompt For An AI Terminal Agent

You can paste this prompt into an AI coding or terminal agent:

```text
In /Users/tonylee/solo/co-translator, install and run Co Translator.
Run:
1. npm install
2. cp .env.example .env if .env does not exist
3. cp .env.example .env.local if .env.local does not exist
4. npm run dev
Do not print or expose my OpenAI API key. If the app asks for a key, tell me to paste it into the in-app API key dialog.
```

## How To Use

1. Start the app with `npm run dev`.
2. Allow microphone permission when macOS or Windows asks.
3. Click the settings button to choose microphone, latency mode, and whether to transcribe the user's voice.
4. Choose the source language, or leave it as `Auto`.
5. Choose the target language.
6. Press `Play`, speak, and watch the User text and Target text panes update.
7. Press `Stop` when finished.

Latency modes:

- `Fastest`: warmed WebSocket translation with 10 ms PCM chunks. It races three translation sockets by default for lower tail latency.
- `WebRTC`: WebRTC translation call for browser media transport comparison.
- `Balanced`: 20 ms audio chunks with local voice activity detection.
- `Stable network`: 40 ms audio chunks and a larger socket buffer for less reliable networks.

## How To Use The Record

The app records the session as text, not as an audio file.

- `User text` is the source transcript from the user microphone when `Transcribe user voice` is on.
- `Target text` is the translated transcript.
- You can edit either text pane after or during a session.
- Click the download button above a pane to export that text as a Markdown record.
- Development latency records are written to `logs/latency.ndjson`.

To watch latency records while the app runs:

```bash
tail -f logs/latency.ndjson
```

## API Price Alert

The app shows an in-app API price alert before the text panes. Pricing changes over time, so verify current rates on the official OpenAI pricing page: https://openai.com/api/pricing/

As of May 11, 2026, the relevant listed rates are:

- `gpt-realtime-translate`: `$0.034` per minute, or `$0.00057` per second.
- `gpt-realtime-whisper`: `$0.017` per minute, or `$0.00028` per second.
- `gpt-4o-transcribe-diarize`: `$0.006` per minute, or `$0.00010` per second.

The app estimate is:

```text
translation cost + transcription cost + diarization cost
```

The running total shows realtime audio duration for WebSocket modes and connected media time for WebRTC mode. If the user plays, stops, and plays again, each interval is added to the previous intervals. The displayed Translate and Whisper times use the same realtime duration when both APIs run together. Translation cost is multiplied by the active translation session count for that interval, Whisper cost is added while user transcription is enabled, and meeting diarization cost is added for the recorded meeting audio that is sent to the diarization API.

With the default `Fastest` mode, translation is multiplied by `OPENAI_REALTIME_RACE_SOCKETS` because the app races multiple translation sockets. The default is `3`, so `Fastest` with user transcription on is approximately:

```text
($0.034 x 3) + $0.017 = $0.119 per minute while sessions are open
```

Set this in `.env` and `.env.local` to reduce Fastest-mode translation cost:

```bash
OPENAI_REALTIME_RACE_SOCKETS=1
```

## Build Native Installers

```bash
npm run dist:mac
npm run dist:win
```

Cross-building Windows installers from macOS may require Wine. Building each target on its own OS is the most reliable path.

## Notes

- The app uses `/v1/realtime/translations` for translation.
- The optional User text pane uses a parallel Realtime transcription session.
- The renderer never receives `OPENAI_API_KEY`.
- The app no longer plays translated speech. The product UI target is translated text latency.

## License

Apache License 2.0. See [LICENSE](./LICENSE).
