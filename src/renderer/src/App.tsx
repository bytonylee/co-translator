import { useEffect, useLayoutEffect, useRef, useState, type SetStateAction } from "react";
import { ArrowDown, Captions, CircleAlert, Download, ExternalLink, KeyRound, Mic2, Moon, Play, Settings2, ShieldCheck, Square, Sun, X } from "lucide-react";
import { createAudioInputStream, createAudioStreamer, createAudioStreamerFromStream, type AudioStreamer } from "./audio";
import { translateKnownPhrase } from "./phrasePreview";
import { createSpeechPreview, type SpeechPreview } from "./speechPreview";
import { createWebRtcTranslator, getWebRtcSourceStream, type WebRtcTranslator } from "./webrtc";
import { languageOptions, targetLanguageOptions } from "../../shared/languages";
import type { ApiPricing, LatencyMode, MainToRendererEvent, MeetingTranscriptSegment, SessionState } from "../../shared/types";

const sourcePlaceholder = "Listening...";
const targetPlaceholder = "Translating...";
const viteEnv = (import.meta as unknown as { env?: Record<string, string | undefined> }).env;
const fastestPrimeMs = Math.max(0, Number(viteEnv?.VITE_FASTEST_PRIME_MS || 1500));
const defaultApiPricing: ApiPricing = {
  realtimeTranslateUsdPerMinute: 0.034,
  realtimeTranslateUsdPerSecond: 0.00057,
  realtimeWhisperUsdPerMinute: 0.017,
  realtimeWhisperUsdPerSecond: 0.00028,
  realtimeRaceSockets: 3,
  meetingDiarizeUsdPerMinute: 0.006,
  meetingDiarizeUsdPerSecond: 0.0001,
  realtimeSourceTranscriptMode: "separate"
};

type Device = {
  deviceId: string;
  label: string;
};

type ActiveCostSession = {
  startedAtMs: number;
  usageBasis: "audio" | "wallClock";
  realtimeAudioMs: number;
  realtimeTranslateUsdPerSecond: number;
  realtimeWhisperUsdPerSecond: number;
  translationSessionCount: number;
  transcribeUserVoice: boolean;
};

type ActiveMeetingDiarizeSession = {
  startedAtMs: number;
  endedAtMs?: number;
  meetingDiarizeUsdPerSecond: number;
};

type CostUsage = {
  workingMs: number;
  translateBillableMs: number;
  whisperBillableMs: number;
  meetingDiarizeBillableMs: number;
  translateUsd: number;
  whisperUsd: number;
  meetingDiarizeUsd: number;
};

type ThemeMode = "light" | "dark";
type AppMode = "presentation" | "meeting";
type StopPhase = "idle" | "stopping";

type MeetingRecordingSession = {
  recorder: MediaRecorder;
  stream: MediaStream;
  chunks: Blob[];
  pendingSaves: Promise<void>[];
  stopped: Promise<Blob>;
  startedAtMs: number;
};

type CompletedRecording = {
  blob: Blob;
  sourceLanguage: string;
  startedAtMs: number;
  endedAtMs: number;
  diarized: boolean;
};

const themeStorageKey = "co-translator-theme";
const terminalPunctuationPattern = /[.!?。？！)]$/;

const emptyCostUsage: CostUsage = {
  workingMs: 0,
  translateBillableMs: 0,
  whisperBillableMs: 0,
  meetingDiarizeBillableMs: 0,
  translateUsd: 0,
  whisperUsd: 0,
  meetingDiarizeUsd: 0
};

export default function App() {
  const [devices, setDevices] = useState<Device[]>([{ deviceId: "", label: "Default microphone" }]);
  const [deviceId, setDeviceId] = useState("");
  const [sourceLanguage, setSourceLanguage] = useState("Korean");
  const [meetingSourceLanguage, setMeetingSourceLanguage] = useState("Auto");
  const [targetLanguage, setTargetLanguage] = useState("English");
  const [state, setState] = useState<SessionState>("idle");
  const [latencyMode, setLatencyMode] = useState<LatencyMode>("fast");
  const [status, setStatus] = useState("Presentation mode");
  const [sourceText, setSourceText] = useState("");
  const [targetText, setTargetText] = useState("");
  const [sourceProvisional, setSourceProvisional] = useState(false);
  const [targetProvisional, setTargetProvisional] = useState(false);
  const [error, setError] = useState("");
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [apiKeyOpen, setApiKeyOpen] = useState(false);
  const [apiKeyInput, setApiKeyInput] = useState("");
  const [apiKeyConfigured, setApiKeyConfigured] = useState(false);
  const [apiKeyError, setApiKeyError] = useState(false);
  const [apiKeyMessage, setApiKeyMessage] = useState("");
  const [apiKeySaving, setApiKeySaving] = useState(false);
  const [apiPricing, setApiPricing] = useState<ApiPricing>(defaultApiPricing);
  const [transcribeUserVoice, setTranscribeUserVoice] = useState(true);
  const [accumulatedCostUsage, setAccumulatedCostUsage] = useState<CostUsage>(emptyCostUsage);
  const [activeCostSession, setActiveCostSession] = useState<ActiveCostSession | null>(null);
  const [activeMeetingDiarizeSession, setActiveMeetingDiarizeSession] = useState<ActiveMeetingDiarizeSession | null>(null);
  const [costTickMs, setCostTickMs] = useState(Date.now());
  const [themeMode, setThemeMode] = useState<ThemeMode>(readInitialThemeMode);
  const [appMode, setAppMode] = useState<AppMode>("presentation");
  const [meetingSegments, setMeetingSegments] = useState<MeetingTranscriptSegment[]>([]);
  const [meetingLiveSourceText, setMeetingLiveSourceText] = useState("");
  const [meetingLiveTargetText, setMeetingLiveTargetText] = useState("");
  const [meetingProcessing, setMeetingProcessing] = useState(false);
  const [meetingTargetMenuOpen, setMeetingTargetMenuOpen] = useState(false);
  const [stopPhase, setStopPhase] = useState<StopPhase>("idle");
  const [voiceActive, setVoiceActive] = useState(false);
  const [showSourceDown, setShowSourceDown] = useState(false);
  const [showTargetDown, setShowTargetDown] = useState(false);
  const streamerRef = useRef<AudioStreamer | null>(null);
  const webRtcTranslatorRef = useRef<WebRtcTranslator | null>(null);
  const speechPreviewRef = useRef<SpeechPreview | null>(null);
  const meetingRecordingRef = useRef<MeetingRecordingSession | null>(null);
  const appModeRef = useRef<AppMode>("presentation");
  const sourceEditorRef = useRef<HTMLTextAreaElement | null>(null);
  const targetEditorRef = useRef<HTMLTextAreaElement | null>(null);
  const meetingChatRef = useRef<HTMLDivElement | null>(null);
  const completedRecordingsRef = useRef<CompletedRecording[]>([]);
  const meetingLiveSourceTextRef = useRef("");
  const meetingLiveTargetTextRef = useRef("");
  const sourceFollowBottomRef = useRef(true);
  const targetFollowBottomRef = useRef(true);
  const meetingFollowBottomRef = useRef(true);
  const runningRef = useRef(false);
  const sourceSessionBaseRef = useRef("");
  const targetSessionBaseRef = useRef("");
  const activeCostSessionRef = useRef<ActiveCostSession | null>(null);
  const activeMeetingDiarizeSessionRef = useRef<ActiveMeetingDiarizeSession | null>(null);
  const apiSourceTextSeenRef = useRef(false);
  const apiTargetTextSeenRef = useRef(false);
  const sourcePlaceholderLoggedRef = useRef(false);
  const targetPlaceholderLoggedRef = useRef(false);
  const sourcePreviewLoggedRef = useRef(false);
  const speculativeTargetLoggedRef = useRef(false);
  const meetingTargetFinalRef = useRef(false);
  const meetingTargetUpdatedAtRef = useRef(0);
  const firstSpeechAtRef = useRef<number | null>(null);
  const fastestPrimeTimerRef = useRef<number | null>(null);
  const voiceActiveTimerRef = useRef<number | null>(null);
  const running = state === "connecting" || state === "connected";
  const stopping = stopPhase !== "idle" || state === "stopping" || meetingProcessing;
  const isMeetingMode = appMode === "meeting";
  const hasTargetText = Boolean(targetText && targetText !== targetPlaceholder);
  const transportButtonClass = [
    "transportButton",
    running ? "stop" : "start",
    stopping ? "stopping" : "",
    running && voiceActive ? "activeMotion" : ""
  ].filter(Boolean).join(" ");
  const transportLabel = stopping ? "Stopping..." : running ? "Stop" : "Play";
  const translationSessionCount = latencyMode === "fast" ? apiPricing.realtimeRaceSockets : 1;
  const activeCostUsage = activeCostSession ? calculateCostUsage(activeCostSession, costTickMs) : emptyCostUsage;
  const activeMeetingDiarizeUsage = activeMeetingDiarizeSession ? calculateMeetingDiarizeUsage(activeMeetingDiarizeSession, costTickMs) : emptyCostUsage;
  const totalCostUsage = addCostUsage(addCostUsage(accumulatedCostUsage, activeCostUsage), activeMeetingDiarizeUsage);
  const totalCostUsd = totalCostUsage.translateUsd + totalCostUsage.whisperUsd + totalCostUsage.meetingDiarizeUsd;
  const sourceUsageLabel = `Whisper ${formatDuration(totalCostUsage.whisperBillableMs)} · ${formatUsd(totalCostUsage.whisperUsd)}`;
  const translateUsageLabel = `Translate ${formatDuration(totalCostUsage.workingMs)} · ${formatUsd(totalCostUsage.translateUsd)}`;
  const meetingUsageLabel = `Diarize ${formatDuration(totalCostUsage.meetingDiarizeBillableMs)} · ${formatUsd(totalCostUsage.meetingDiarizeUsd)}`;
  const totalUsageTitle = `Total estimated API usage: ${formatDuration(totalCostUsage.workingMs)} working time, ${translateUsageLabel}, ${sourceUsageLabel}, ${meetingUsageLabel}, ${formatUsd(totalCostUsd)} total`;
  const totalUsageLabel = `Total usage cost ${formatUsd(totalCostUsd)}`;
  const allUsageLabel = `${translateUsageLabel} · ${sourceUsageLabel} · ${meetingUsageLabel}`;
  const activeSourceLanguage = isMeetingMode ? meetingSourceLanguage : sourceLanguage;
  const groupedMeetingSegments = mergeConsecutiveSpeakerSegments(meetingSegments);
  const meetingDisplayTranslationText = running ? saveableText(meetingLiveTargetText, targetPlaceholder) : "";
  const hasDiarizedMeetingDisplay = groupedMeetingSegments.length > 0;
  const hasTranslatedMeetingDisplay = Boolean(meetingDisplayTranslationText);
  const hasMeetingDisplay = hasDiarizedMeetingDisplay || hasTranslatedMeetingDisplay;
  const meetingExportTranslationText = meetingDisplayTranslationText;

  useEffect(() => {
    void refreshDevices();
    if (!window.translator) {
      setStatus("Presentation mode · Preview");
      return;
    }
    const unsubscribe = window.translator.onEvent(handleTranslatorEvent);
    return () => {
      unsubscribe();
    };
  }, []);

  useEffect(() => {
    document.documentElement.dataset.theme = themeMode;
    try {
      window.localStorage.setItem(themeStorageKey, themeMode);
    } catch {
      // Theme persistence is optional.
    }
  }, [themeMode]);

  useEffect(() => {
    if (!apiKeyOpen) {
      setApiKeyInput("");
      return;
    }
    void refreshApiKeyStatus();
    void refreshApiPricing();
  }, [apiKeyOpen]);

  useEffect(() => {
    runningRef.current = running;
  }, [running]);

  useEffect(() => {
    appModeRef.current = appMode;
  }, [appMode]);

  useEffect(() => {
    meetingLiveSourceTextRef.current = meetingLiveSourceText;
  }, [meetingLiveSourceText]);

  useEffect(() => {
    meetingLiveTargetTextRef.current = meetingLiveTargetText;
  }, [meetingLiveTargetText]);

  useEffect(() => {
    if (running || meetingProcessing) {
      setMeetingTargetMenuOpen(false);
    }
  }, [running, meetingProcessing]);

  useEffect(() => {
    window.translator?.updateExitSaveState({
      sourceText: saveableText(sourceText, sourcePlaceholder),
      targetText: saveableText(targetText, targetPlaceholder)
    });
  }, [sourceText, targetText]);

  useEffect(() => {
    if (!activeCostSession && !activeMeetingDiarizeSession) {
      return;
    }
    setCostTickMs(Date.now());
    const timer = window.setInterval(() => setCostTickMs(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [activeCostSession, activeMeetingDiarizeSession]);

  useLayoutEffect(() => {
    followBottomIfNeeded(sourceEditorRef.current, sourceFollowBottomRef);
    updateDownIndicator(sourceEditorRef.current, setShowSourceDown);
  }, [sourceText]);

  useLayoutEffect(() => {
    followBottomIfNeeded(targetEditorRef.current, targetFollowBottomRef);
    updateDownIndicator(targetEditorRef.current, setShowTargetDown);
  }, [targetText]);

  useLayoutEffect(() => {
    followBottomIfNeeded(meetingChatRef.current, meetingFollowBottomRef);
  }, [groupedMeetingSegments, meetingDisplayTranslationText]);

  async function refreshDevices() {
    if (!navigator.mediaDevices?.enumerateDevices) {
      setDevices([{ deviceId: "", label: "Default microphone" }]);
      return;
    }

    try {
      await navigator.mediaDevices.getUserMedia({ audio: true }).then((stream) => {
        stream.getTracks().forEach((track) => track.stop());
      });
    } catch {
      setStatus("Microphone permission needed");
    }

    const allDevices = await navigator.mediaDevices.enumerateDevices();
    const audioInputs = allDevices
      .filter((device) => device.kind === "audioinput")
      .map((device, index) => ({
        deviceId: device.deviceId,
        label: device.label || `Microphone ${index + 1}`
      }));
    const availableDevices = audioInputs.length ? audioInputs : [{ deviceId: "", label: "Default microphone" }];
    setDevices(availableDevices);
    setDeviceId((current) => current || availableDevices[0]?.deviceId || "");
  }

  async function refreshApiKeyStatus() {
    if (!window.translator) {
      return;
    }
    try {
      const nextStatus = await window.translator.getApiKeyStatus();
      setApiKeyConfigured(nextStatus.configured);
      setApiKeyError(false);
      setApiKeyMessage(apiKeyStatusMessage(nextStatus.storage));
    } catch (statusError) {
      setApiKeyConfigured(false);
      setApiKeyError(true);
      setApiKeyMessage(statusError instanceof Error ? statusError.message : "Could not read API key status.");
    }
  }

  async function refreshApiPricing() {
    if (!window.translator) {
      return;
    }
    try {
      setApiPricing(await window.translator.getApiPricing());
    } catch {
      setApiPricing(defaultApiPricing);
    }
  }

  async function applyApiKey() {
    if (!window.translator) {
      setApiKeyError(true);
      setApiKeyMessage("Start the native backend to store an API key.");
      return;
    }
    const trimmedApiKey = apiKeyInput.trim();
    if (!trimmedApiKey.startsWith("sk-")) {
      setApiKeyError(true);
      setApiKeyMessage("API key must start with sk-.");
      return;
    }

    setApiKeySaving(true);
    setApiKeyError(false);
    setApiKeyMessage("");
    try {
      const nextStatus = await window.translator.setApiKey(trimmedApiKey);
      setApiKeyConfigured(nextStatus.configured);
      setApiKeyError(false);
      setApiKeyMessage(apiKeyStatusMessage(nextStatus.storage));
      setApiKeyInput("");
      setApiKeyOpen(false);
    } catch (saveError) {
      setApiKeyError(true);
      setApiKeyMessage(saveError instanceof Error ? saveError.message : "Could not store API key.");
    } finally {
      setApiKeySaving(false);
    }
  }

  async function openApiKeyPage() {
    if (!window.translator) {
      window.open("https://platform.openai.com/settings/organization/api-keys", "_blank", "noopener,noreferrer");
      return;
    }
    await window.translator.openApiKeyPage();
  }

  function handleTranslatorEvent(event: MainToRendererEvent) {
    if (event.type === "state") {
      setState(event.state);
      if (!hiddenStatus(event.message)) {
        setStatus(event.message || event.state);
      }
      return;
    }
    if (event.type === "speechActivity") {
      if (firstSpeechAtRef.current === null) {
        firstSpeechAtRef.current = event.speechStartedAt;
      }
      logUi("ui_speech_activity_received", {
        speechToRendererMs: Math.max(0, Date.now() - event.speechStartedAt),
        rms: event.rms
      });
      showVoiceActivity();
      setStatus("Listening");
      if (shouldDisplaySourceTranscript() && !apiSourceTextSeenRef.current) {
        setSourceProvisional(true);
        setSessionSourceText((current) => {
          if (current) {
            return current;
          }
          if (!sourcePlaceholderLoggedRef.current) {
            sourcePlaceholderLoggedRef.current = true;
            logUi("ui_source_placeholder_shown");
          }
          return sourcePlaceholder;
        });
      }
      if (!apiTargetTextSeenRef.current) {
        setTargetProvisional(true);
        setSessionTargetText((current) => {
          if (current && current !== targetPlaceholder) {
            return current;
          }
          if (!targetPlaceholderLoggedRef.current) {
            targetPlaceholderLoggedRef.current = true;
            logUi("ui_target_placeholder_shown");
          }
          return targetPlaceholder;
        });
      }
      return;
    }
    if (event.type === "sourceTranscript") {
      if (!shouldDisplaySourceTranscript()) {
        return;
      }
      showVoiceActivity();
      const firstApiSourceText = !apiSourceTextSeenRef.current && Boolean(event.text);
      apiSourceTextSeenRef.current = true;
      setSourceProvisional(false);
      if (firstApiSourceText) {
        logUi("ui_first_source_transcript_rendered", {
          final: event.final,
          chars: event.text.length
        });
      }
      setSessionSourceText((current) => (event.final && !event.text ? current : mergeSessionText(sourceSessionBaseRef.current, event.text)));
      return;
    }
    if (event.type === "targetTranslation") {
      const firstApiTargetText = !apiTargetTextSeenRef.current && Boolean(event.text);
      apiTargetTextSeenRef.current = true;
      if (appModeRef.current === "meeting") {
        meetingTargetFinalRef.current = event.final;
        meetingTargetUpdatedAtRef.current = Date.now();
      }
      if (shouldDisplaySourceTranscript() && !apiSourceTextSeenRef.current) {
        setSourceProvisional(true);
        setSessionSourceText((current) => {
          if (saveableText(current, sourcePlaceholder)) {
            return current;
          }
          return mergeSessionText(sourceSessionBaseRef.current, sourcePlaceholder);
        });
      }
      setTargetProvisional(false);
      setStatus(event.final ? "Translated" : "Translating");
      if (firstApiTargetText) {
        logUi("ui_first_target_translation_rendered", {
          final: event.final,
          chars: event.text.length
        });
      }
      setSessionTargetText((current) => (event.final && !event.text ? current : mergeSessionText(targetSessionBaseRef.current, event.text)));
      return;
    }
    if (event.type === "latency") {
      logUi("latency_snapshot", event.snapshot as unknown as Record<string, unknown>);
      return;
    }
    if (event.type === "error") {
      setError(event.message);
    }
  }

  async function start() {
    if (isMeetingMode) {
      await startMeeting();
      return;
    }

    setError("");
    sourceSessionBaseRef.current = sourceText.trim();
    targetSessionBaseRef.current = targetText.trim();
    setSourceProvisional(false);
    setTargetProvisional(false);
    setVoiceActive(false);
    apiSourceTextSeenRef.current = false;
    apiTargetTextSeenRef.current = false;
    sourcePlaceholderLoggedRef.current = false;
    targetPlaceholderLoggedRef.current = false;
    sourcePreviewLoggedRef.current = false;
    speculativeTargetLoggedRef.current = false;
    firstSpeechAtRef.current = null;
    if (!window.translator) {
      setError("Start the native backend to connect to OpenAI Realtime.");
      return;
    }
    setState("connecting");
    setStatus("Connecting");
    let pendingFastSourceStream: MediaStream | undefined;
    try {
      if (latencyMode === "webrtc") {
        setStatus("Connecting WebRTC translation");
        speechPreviewRef.current = createSpeechPreview(activeSourceLanguage, latencyMode, handleSourcePreview, targetLanguage);
        const fastConnectStartedAt = Date.now();
        const sourceStreamPromise = getWebRtcSourceStream(deviceId).then((sourceStream) => {
          logUi("webrtc_source_stream_ready", {
            readyMs: Date.now() - fastConnectStartedAt
          });
          return sourceStream;
        });
        const translationCallPromise = window.translator.startTranslationCall({ sourceLanguage: activeSourceLanguage, targetLanguage, latencyMode, transcribeUserVoice });
        const [{ clientSecret }, sourceStream] = await Promise.all([translationCallPromise, sourceStreamPromise]);
        pendingFastSourceStream = sourceStream;
        meetingRecordingRef.current = createMeetingRecordingFromStream(sourceStream.clone(), true);
        meetingRecordingRef.current.recorder.start(1000);
        streamerRef.current = await createAudioStreamerFromStream(sourceStream, latencyMode, (audio) => {
          recordRealtimeAudioUsage(audio.chunkMs);
          window.translator.sendAudio(audio);
        });
        webRtcTranslatorRef.current = await createWebRtcTranslator({
          clientSecret,
          deviceId,
          sourceStream,
          onConnected() {
            beginCostSession("wallClock", transcribeUserVoice);
            setState("connected");
            setStatus("Live WebRTC translation");
          },
          onSpeechActivity(speechStartedAt, rms) {
            handleTranslatorEvent({ type: "speechActivity", speechStartedAt, rms });
          },
          onSourceTranscript(text, final) {
            handleTranslatorEvent({ type: "sourceTranscript", text, final });
          },
          onTargetTranslation(text, final) {
            handleTranslatorEvent({ type: "targetTranslation", text, final });
          },
          onLatency(snapshot) {
            logUi("latency_snapshot", snapshot as unknown as Record<string, unknown>);
          },
          onError(message) {
            setError(message);
            setState("error");
            setStatus("WebRTC error");
          },
          log: logUi
        });
        pendingFastSourceStream = undefined;
        return;
      }

      const config = { sourceLanguage: activeSourceLanguage, targetLanguage, latencyMode, transcribeUserVoice };
      const startSessionPromise = window.translator.startSession(config);
      beginCostSession("audio", transcribeUserVoice);
      const sourceStream = await createAudioInputStream(deviceId, latencyMode);
      meetingRecordingRef.current = createMeetingRecordingFromStream(sourceStream.clone(), true);
      meetingRecordingRef.current.recorder.start(1000);
      streamerRef.current = await createAudioStreamerFromStream(sourceStream, latencyMode, (audio) => {
        recordRealtimeAudioUsage(audio.chunkMs);
        window.translator.sendAudio(audio);
      }, true);
      await startSessionPromise;
      if (latencyMode === "fast" && fastestPrimeMs > 0) {
        setStatus("Priming fastest audio");
        logUi("ui_fastest_prime_started", {
          primeMs: fastestPrimeMs
        });
        fastestPrimeTimerRef.current = window.setTimeout(() => {
          fastestPrimeTimerRef.current = null;
          logUi("ui_fastest_prime_ready", {
            primeMs: fastestPrimeMs
          });
          setStatus("Live fastest translation");
        }, fastestPrimeMs);
      }
      speechPreviewRef.current = createSpeechPreview(activeSourceLanguage, latencyMode, handleSourcePreview, targetLanguage);
    } catch (startError) {
      await streamerRef.current?.stop();
      streamerRef.current = null;
      await webRtcTranslatorRef.current?.stop();
      webRtcTranslatorRef.current = null;
      pendingFastSourceStream?.getTracks().forEach((track) => track.stop());
      await window.translator.stopSession();
      const recording = meetingRecordingRef.current;
      meetingRecordingRef.current = null;
      await stopRecordingWithoutDiarize(recording);
      discardCostSession();
      setState("idle");
      setStatus("Presentation mode");
      setError(startError instanceof Error ? startError.message : "Could not start translation.");
    }
  }

  async function stop() {
    if (isMeetingMode) {
      await stopMeeting();
      return;
    }

    setState("stopping");
    setStopPhase("stopping");
    setStatus("Stopping");
    await nextPaint();
    setSourceProvisional(false);
    setTargetProvisional(false);
    setVoiceActive(false);
    clearVoiceActiveTimer();
    try {
      speechPreviewRef.current?.stop();
      speechPreviewRef.current = null;
      clearFastestPrimeTimer();
      await webRtcTranslatorRef.current?.stop();
      webRtcTranslatorRef.current = null;
      await streamerRef.current?.stop();
      streamerRef.current = null;
      finishCostSession();
      const recording = meetingRecordingRef.current;
      meetingRecordingRef.current = null;
      await archiveRecordingForDiarization(recording, sourceLanguage);
      await window.translator?.stopSession();
      await nextPaint();
    } finally {
      if (activeCostSessionRef.current) {
        finishCostSession();
      }
      setState("idle");
      setStopPhase("idle");
      setStatus("Presentation mode");
    }
  }

  async function startMeeting() {
    setError("");
    setMeetingLiveSourceText("");
    setMeetingLiveTargetText("");
    meetingLiveSourceTextRef.current = "";
    meetingLiveTargetTextRef.current = "";
    sourceSessionBaseRef.current = "";
    targetSessionBaseRef.current = "";
    setSourceProvisional(false);
    setTargetProvisional(false);
    setVoiceActive(false);
    apiSourceTextSeenRef.current = false;
    apiTargetTextSeenRef.current = false;
    meetingTargetFinalRef.current = false;
    meetingTargetUpdatedAtRef.current = 0;
    firstSpeechAtRef.current = null;
    if (!window.translator) {
      setError("Start the native backend to diarize meeting audio.");
      return;
    }
    try {
      setState("connecting");
      setStatus("Starting live meeting");
      await window.translator.startSession({ sourceLanguage: meetingSourceLanguage, targetLanguage, latencyMode, transcribeUserVoice });
      beginCostSession("audio", transcribeUserVoice);
      meetingRecordingRef.current = await createMeetingRecording(deviceId, true);
      beginMeetingDiarizeSession(meetingRecordingRef.current.startedAtMs);
      meetingRecordingRef.current.recorder.start(1000);
      streamerRef.current = await createAudioStreamer(deviceId, latencyMode, (audio) => {
        recordRealtimeAudioUsage(audio.chunkMs);
        window.translator.sendAudio(audio);
      });
      speechPreviewRef.current = createSpeechPreview(meetingSourceLanguage, latencyMode, handleSourcePreview, targetLanguage);
      setState("connected");
      setStatus("Live meeting translation");
    } catch (startError) {
      await streamerRef.current?.stop();
      streamerRef.current = null;
      speechPreviewRef.current?.stop();
      speechPreviewRef.current = null;
      await window.translator.stopSession();
      discardCostSession();
      discardMeetingDiarizeSession();
      const meetingRecording = meetingRecordingRef.current;
      meetingRecordingRef.current = null;
      await stopRecordingWithoutDiarize(meetingRecording);
      setState("idle");
      setStatus("Meeting mode");
      setError(startError instanceof Error ? startError.message : "Could not start meeting recording.");
    }
  }

  async function stopMeeting() {
    const recording = meetingRecordingRef.current;
    if (!recording) {
      setState("idle");
      setStatus("Meeting mode");
      return;
    }

    setState("stopping");
    setStopPhase("stopping");
    setMeetingProcessing(true);
    setStatus("Splitting meeting speakers");
    await nextPaint();
    meetingRecordingRef.current = null;
    const recordingMs = Math.max(0, Date.now() - recording.startedAtMs);
    if (!activeMeetingDiarizeSessionRef.current) {
      beginMeetingDiarizeSession(recording.startedAtMs);
    }
    endMeetingDiarizeSession(recording.startedAtMs + recordingMs);
    try {
      speechPreviewRef.current?.stop();
      speechPreviewRef.current = null;
      await streamerRef.current?.stop();
      streamerRef.current = null;
      finishCostSession();
      setSourceProvisional(false);
      setTargetProvisional(false);
      setVoiceActive(false);
      clearVoiceActiveTimer();
      if (recording.recorder.state !== "inactive") {
        recording.recorder.stop();
      }
      recording.stream.getTracks().forEach((track) => track.stop());
      await waitForMeetingTranslationSettled(meetingTargetFinalRef, meetingTargetUpdatedAtRef);
      await window.translator?.stopSession().catch((stopError: unknown) => {
        logUi("meeting_realtime_stop_error", {
          message: stopError instanceof Error ? stopError.message : "Could not stop realtime session"
        });
      });
      await waitForMeetingTranslationSettled(meetingTargetFinalRef, meetingTargetUpdatedAtRef, 1600);
      const audio = await recording.stopped;
      await waitForMeetingAudioSaves(recording);
      if (!audio.size) {
        throw new Error("Meeting recording did not contain audio.");
      }
      const result = await window.translator.transcribeMeetingAudio({
        base64Audio: await blobToBase64(audio),
        mimeType: audio.type || meetingAudioMimeType(),
        sourceLanguage: meetingSourceLanguage,
        targetLanguage
      });
      addMeetingDiarizeUsage(recordingMs);
      const nextSegments = mergeConsecutiveSpeakerSegments([...meetingSegments, ...result.segments]);
      setMeetingSegments(nextSegments);
      setMeetingLiveSourceText("");
      setMeetingLiveTargetText("");
      meetingLiveTargetTextRef.current = "";
      setStatus(`Meeting mode · ${speakerCount(nextSegments)} speakers`);
    } catch (stopError) {
      setError(stopError instanceof Error ? stopError.message : "Could not split meeting speakers.");
      setStatus("Meeting mode");
    } finally {
      if (activeCostSessionRef.current) {
        finishCostSession();
      }
      discardCostSession();
      discardMeetingDiarizeSession();
      setMeetingProcessing(false);
      setState("idle");
      setStopPhase("idle");
    }
  }

  function beginCostSession(usageBasis: ActiveCostSession["usageBasis"], transcribeUserVoice = true) {
    const session: ActiveCostSession = {
      startedAtMs: Date.now(),
      usageBasis,
      realtimeAudioMs: 0,
      realtimeTranslateUsdPerSecond: apiPricing.realtimeTranslateUsdPerSecond,
      realtimeWhisperUsdPerSecond: apiPricing.realtimeWhisperUsdPerSecond,
      translationSessionCount,
      transcribeUserVoice
    };
    activeCostSessionRef.current = session;
    setActiveCostSession(session);
  }

  function recordRealtimeAudioUsage(chunkMs: number) {
    const session = activeCostSessionRef.current;
    if (!session || session.usageBasis !== "audio") {
      return;
    }
    session.realtimeAudioMs += chunkMs;
  }

  function addMeetingDiarizeUsage(recordingMs: number) {
    const meetingDiarizeUsdPerSecond = activeMeetingDiarizeSessionRef.current?.meetingDiarizeUsdPerSecond ?? apiPricing.meetingDiarizeUsdPerSecond;
    const usage: CostUsage = {
      workingMs: 0,
      translateBillableMs: 0,
      whisperBillableMs: 0,
      meetingDiarizeBillableMs: recordingMs,
      translateUsd: 0,
      whisperUsd: 0,
      meetingDiarizeUsd: (recordingMs / 1000) * meetingDiarizeUsdPerSecond
    };
    setAccumulatedCostUsage((current) => addCostUsage(current, usage));
  }

  function beginMeetingDiarizeSession(startedAtMs: number) {
    const session: ActiveMeetingDiarizeSession = {
      startedAtMs,
      meetingDiarizeUsdPerSecond: apiPricing.meetingDiarizeUsdPerSecond
    };
    activeMeetingDiarizeSessionRef.current = session;
    setActiveMeetingDiarizeSession(session);
  }

  function endMeetingDiarizeSession(endedAtMs: number) {
    const session = activeMeetingDiarizeSessionRef.current;
    if (!session) {
      return;
    }
    const endedSession = { ...session, endedAtMs };
    activeMeetingDiarizeSessionRef.current = endedSession;
    setActiveMeetingDiarizeSession(endedSession);
  }

  function finishCostSession() {
    const session = activeCostSessionRef.current;
    if (!session) {
      return;
    }
    const usage = calculateCostUsage(session, Date.now());
    setAccumulatedCostUsage((current) => addCostUsage(current, usage));
    discardCostSession();
  }

  function discardCostSession() {
    activeCostSessionRef.current = null;
    setActiveCostSession(null);
  }

  function discardMeetingDiarizeSession() {
    activeMeetingDiarizeSessionRef.current = null;
    setActiveMeetingDiarizeSession(null);
  }

  async function stopRecordingWithoutDiarize(recording: MeetingRecordingSession | null) {
    if (!recording) {
      return;
    }
    if (recording.recorder.state !== "inactive") {
      recording.recorder.stop();
    }
    recording.stream.getTracks().forEach((track) => track.stop());
    await recording.stopped.catch(() => undefined);
    await waitForMeetingAudioSaves(recording);
  }

  async function archiveRecordingForDiarization(recording: MeetingRecordingSession | null, recordingSourceLanguage: string) {
    if (!recording) {
      return;
    }
    if (recording.recorder.state !== "inactive") {
      recording.recorder.stop();
    }
    recording.stream.getTracks().forEach((track) => track.stop());
    const blob = await recording.stopped.catch(() => null);
    await waitForMeetingAudioSaves(recording);
    if (!blob?.size) {
      return;
    }
    completedRecordingsRef.current.push({
      blob,
      sourceLanguage: recordingSourceLanguage,
      startedAtMs: recording.startedAtMs,
      endedAtMs: Date.now(),
      diarized: false
    });
  }

  async function diarizePendingRecordings(reason: string) {
    const pending = completedRecordingsRef.current.filter((recording) => !recording.diarized);
    if (!pending.length) {
      return;
    }
    if (!window.translator) {
      setError("Start the native backend to split saved conversation audio.");
      return;
    }

    setMeetingProcessing(true);
    setStatus(reason === "mode_switch" ? "Splitting saved conversation" : "Splitting speakers");
    try {
      for (const recording of pending) {
        const result = await window.translator.transcribeMeetingAudio({
          base64Audio: await blobToBase64(recording.blob),
          mimeType: recording.blob.type || meetingAudioMimeType(),
          sourceLanguage: recording.sourceLanguage,
          targetLanguage
        });
        recording.diarized = true;
        setMeetingSegments((current) => mergeConsecutiveSpeakerSegments([...current, ...result.segments]));
        addMeetingDiarizeUsage(Math.max(0, recording.endedAtMs - recording.startedAtMs));
      }
    } finally {
      setMeetingProcessing(false);
      setStatus("Meeting mode");
    }
  }

  function clearFastestPrimeTimer() {
    if (fastestPrimeTimerRef.current !== null) {
      window.clearTimeout(fastestPrimeTimerRef.current);
      fastestPrimeTimerRef.current = null;
    }
  }

  function showVoiceActivity() {
    if (!runningRef.current) {
      return;
    }
    setVoiceActive(true);
    clearVoiceActiveTimer();
    voiceActiveTimerRef.current = window.setTimeout(() => {
      voiceActiveTimerRef.current = null;
      setVoiceActive(false);
    }, 1200);
  }

  function clearVoiceActiveTimer() {
    if (voiceActiveTimerRef.current !== null) {
      window.clearTimeout(voiceActiveTimerRef.current);
      voiceActiveTimerRef.current = null;
    }
  }

  function setSessionSourceText(updater: SetStateAction<string>) {
    if (appModeRef.current === "meeting") {
      setMeetingLiveSourceText(updater);
      return;
    }
    setSourceText(updater);
  }

  function setSessionTargetText(updater: SetStateAction<string>) {
    if (appModeRef.current === "meeting") {
      const nextText = typeof updater === "function"
        ? updater(meetingLiveTargetTextRef.current)
        : updater;
      meetingLiveTargetTextRef.current = nextText;
      setMeetingLiveTargetText(nextText);
      return;
    }
    setTargetText(updater);
  }

  function handleSourcePreview(text: string) {
    if (shouldDisplaySourceTranscript() && !apiSourceTextSeenRef.current && text) {
      if (firstSpeechAtRef.current === null) {
        firstSpeechAtRef.current = Date.now();
        logUi("ui_source_preview_speech_start");
      }
      showVoiceActivity();
      if (!sourcePreviewLoggedRef.current) {
        sourcePreviewLoggedRef.current = true;
        logUi("ui_first_source_preview_rendered", {
          chars: text.length
        });
      }
      setSourceProvisional(true);
      setSessionSourceText(mergeSessionText(sourceSessionBaseRef.current, text));
    }
    showSpeculativeTarget(text);
  }

  function shouldDisplaySourceTranscript() {
    return transcribeUserVoice;
  }

  function showSpeculativeTarget(text: string) {
    if (apiTargetTextSeenRef.current || !text) {
      return;
    }

    const target = translateKnownPhrase(text, targetLanguage);
    if (!target) {
      return;
    }

    const speechToTargetMs = firstSpeechAtRef.current === null ? undefined : Math.max(0, Date.now() - firstSpeechAtRef.current);
    if (!speculativeTargetLoggedRef.current) {
      speculativeTargetLoggedRef.current = true;
      logUi("ui_speculative_target_translation_rendered", {
        speechToTargetMs,
        sourceChars: text.length,
        targetChars: target.length,
        targetLanguage
      });
    }
    setStatus("Speculative translation");
    setTargetProvisional(true);
    setSessionTargetText(mergeSessionText(targetSessionBaseRef.current, target));
    logUi("ui_speculative_target_latency", {
      speechToTargetMs,
      rootCause: "Speculative local phrase preview"
    });
  }

  function exportMarkdown(kind: "user" | "target", text: string) {
    const now = new Date();
    const timestamp = now.toISOString().replace(/[:.]/g, "-");
    const title = kind === "user" ? "User text" : "Target text";
    const content = markdownDocument(title, text);
    const blob = new Blob([content], { type: "text/markdown;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `${timestamp}-${kind}.md`;
    document.body.appendChild(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(url);
  }

  function exportMeetingMarkdown() {
    const now = new Date();
    const timestamp = now.toISOString().replace(/[:.]/g, "-");
    const content = meetingMarkdownDocument(groupedMeetingSegments, "", meetingExportTranslationText);
    const blob = new Blob([content], { type: "text/markdown;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `${timestamp}-meeting.md`;
    document.body.appendChild(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(url);
  }

  async function applyMode(nextMode: AppMode) {
    if (meetingProcessing || nextMode === appMode) {
      return;
    }
    const currentMode = appMode;
    const shouldDiarizePresentation = running && currentMode === "presentation" && nextMode === "meeting";
    setError("");
    if (running) {
      if (shouldDiarizePresentation) {
        targetSessionBaseRef.current = "";
        meetingLiveTargetTextRef.current = "";
        setMeetingLiveTargetText("");
        setAppMode("meeting");
        appModeRef.current = "meeting";
        await stopMeeting();
      } else {
        await stop();
      }
    } else if (currentMode === "presentation" && nextMode === "meeting") {
      setAppMode("meeting");
      appModeRef.current = "meeting";
      await diarizePendingRecordings("mode_switch");
      setStatus("Meeting mode");
      return;
    }
    setAppMode(nextMode);
    appModeRef.current = nextMode;
    if (!shouldDiarizePresentation) {
      setStatus(nextMode === "presentation" ? "Presentation mode" : "Meeting mode");
    }
  }

  function scrollEditorToBottom(editor: HTMLTextAreaElement | null, setter: (value: boolean) => void) {
    if (!editor) {
      return;
    }
    editor.scrollTo({ top: editor.scrollHeight, behavior: "smooth" });
    window.setTimeout(() => updateDownIndicator(editor, setter), 220);
  }

  return (
    <main className="shell">
      <header className="appHeader">
        <div className="headerBar">
          <div className="modeHeader" aria-label="Mode">
            <div className="modeTabs">
              <button className={appMode === "presentation" ? "modeTab active" : "modeTab"} onClick={() => void applyMode("presentation")} disabled={meetingProcessing}>
                Presentation
              </button>
              <button className={appMode === "meeting" ? "modeTab active" : "modeTab"} onClick={() => void applyMode("meeting")} disabled={meetingProcessing}>
                Meeting
              </button>
            </div>
            <span className="modeStatus" title={totalUsageTitle}>{totalUsageLabel}</span>
          </div>
          <div className="headerActions">
            <button className={transportButtonClass} onClick={running ? stop : start} disabled={stopping}>
              {stopping ? <span className="buttonSpinner" aria-hidden="true" /> : running ? <Square size={17} fill="currentColor" /> : <Play size={18} fill="currentColor" />}
              <span>{transportLabel}</span>
            </button>

            <button
              className={settingsOpen ? "iconButton active" : "iconButton"}
              aria-label="Microphone settings"
              aria-expanded={settingsOpen}
              onClick={() => setSettingsOpen((open) => !open)}
            >
              <Settings2 size={20} />
            </button>

            <button
              className={[
                "iconButton",
                apiKeyOpen ? "active" : "",
                apiKeyError ? "errorStatus" : "",
                apiKeyConfigured ? "configured" : ""
              ].filter(Boolean).join(" ")}
              aria-label={apiKeyError ? "API key error" : apiKeyConfigured ? "API key configured" : "Set API key"}
              aria-expanded={apiKeyOpen}
              onClick={() => setApiKeyOpen((open) => !open)}
            >
              {apiKeyError ? <CircleAlert size={20} /> : apiKeyConfigured ? <ShieldCheck size={20} /> : <KeyRound size={20} />}
            </button>

            <button
              className="iconButton"
              aria-label={themeMode === "dark" ? "Switch to light mode" : "Switch to dark mode"}
              title={themeMode === "dark" ? "Light mode" : "Dark mode"}
              onClick={() => setThemeMode((current) => (current === "dark" ? "light" : "dark"))}
            >
              {themeMode === "dark" ? <Sun size={20} /> : <Moon size={20} />}
            </button>
          </div>
        </div>

        {settingsOpen ? (
          <div className="modalBackdrop" role="presentation" onMouseDown={() => setSettingsOpen(false)}>
            <div className="settingsModal" role="dialog" aria-modal="true" aria-label="Settings" onMouseDown={(event) => event.stopPropagation()}>
              <header>
                <div>
                  <span>Settings</span>
                  <strong>Input and display</strong>
                </div>
                <button className="iconButton" aria-label="Close settings" onClick={() => setSettingsOpen(false)}>
                  <X size={19} />
                </button>
              </header>
              <label>
                <span>
                  <Mic2 size={16} />
                  Microphone
                </span>
                <select value={deviceId} onChange={(event) => setDeviceId(event.target.value)} disabled={running}>
                  {devices.map((device) => (
                    <option key={device.deviceId} value={device.deviceId}>
                      {device.label}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                <span>Latency</span>
                <select value={latencyMode} onChange={(event) => setLatencyMode(event.target.value as LatencyMode)} disabled={running}>
                  <option value="fast">Fastest</option>
                  <option value="webrtc">WebRTC</option>
                  <option value="balanced">Balanced</option>
                  <option value="stable">Stable network</option>
                </select>
              </label>
              <div className="toggleRow">
                <span id="transcribe-user-voice-label">
                  <Captions size={16} />
                  GPT-Realtime-Whisper user transcript
                </span>
                <button
                  type="button"
                  className="toggleSwitch"
                  aria-pressed={transcribeUserVoice}
                  aria-labelledby="transcribe-user-voice-label"
                  onClick={() => setTranscribeUserVoice((enabled) => !enabled)}
                >
                  <span aria-hidden="true" />
                </button>
              </div>
            </div>
          </div>
        ) : null}

        {apiKeyOpen ? (
          <div className="modalBackdrop" role="presentation" onMouseDown={() => setApiKeyOpen(false)}>
            <form
              className="settingsModal apiKeyModal"
              role="dialog"
              aria-modal="true"
              aria-label="API key settings"
              onMouseDown={(event) => event.stopPropagation()}
              onSubmit={(event) => {
                event.preventDefault();
                void applyApiKey();
              }}
            >
              <header>
                <div>
                  <span>API key</span>
                  <strong>OpenAI access</strong>
                </div>
                <button type="button" className="iconButton" aria-label="Close API key settings" onClick={() => setApiKeyOpen(false)}>
                  <X size={19} />
                </button>
              </header>
              <button type="button" className="linkButton" onClick={() => void openApiKeyPage()}>
                <ExternalLink size={17} />
                Open OpenAI API keys
              </button>
              <label>
                <span>
                  <KeyRound size={16} />
                  API key
                </span>
                <input
                  value={apiKeyInput}
                  onChange={(event) => setApiKeyInput(event.target.value)}
                  placeholder="sk-..."
                  type="password"
                  autoComplete="off"
                  spellCheck={false}
                />
              </label>
              <div className="modalActions">
                <p className={[
                  "apiKeyStatus",
                  apiKeyError ? "errorStatus" : "",
                  apiKeyConfigured ? "configured" : ""
                ].filter(Boolean).join(" ")}>
                  {apiKeyMessage || "Stored only on this device."}
                </p>
                <button type="submit" className="primaryButton" disabled={apiKeySaving || !apiKeyInput.trim()}>
                  {apiKeySaving ? "Applying" : "Apply"}
                </button>
              </div>
            </form>
          </div>
        ) : null}
      </header>

      {error ? <div className="error">{error}</div> : null}

      {isMeetingMode ? (
        <section className="textGrid meetingGrid">
          <article className="languagePane meetingPane">
            <header className="paneHeader">
              <div className="paneTitle">
                <span>Meeting</span>
              </div>
              <span className="usageEstimate" title={`${totalUsageTitle}. GPT-4o Transcribe Diarize is estimated at ${formatUsdRate(apiPricing.meetingDiarizeUsdPerSecond)} per second after Stop.`}>
                {meetingProcessing ? `Splitting speakers · ${allUsageLabel}` : groupedMeetingSegments.length ? `${speakerCount(groupedMeetingSegments)} speakers · ${allUsageLabel}` : allUsageLabel}
              </span>
              <div className="paneTools">
                <button className="toolButton" aria-label="Download meeting text" onClick={exportMeetingMarkdown} disabled={!hasMeetingExportText(groupedMeetingSegments, "", meetingExportTranslationText)}>
                  <Download size={17} />
                </button>
                <select value={meetingSourceLanguage} onChange={(event) => setMeetingSourceLanguage(event.target.value)} disabled={running || meetingProcessing}>
                  {languageOptions.map((language) => (
                    <option key={language}>{language}</option>
                  ))}
                </select>
                <div
                  className="languageMenu"
                  onBlur={(event) => {
                    if (!event.currentTarget.contains(event.relatedTarget as Node | null)) {
                      setMeetingTargetMenuOpen(false);
                    }
                  }}
                >
                  <button
                    type="button"
                    className="languageMenuButton"
                    aria-haspopup="listbox"
                    aria-expanded={meetingTargetMenuOpen}
                    disabled={running || meetingProcessing}
                    onClick={() => setMeetingTargetMenuOpen((open) => !open)}
                  >
                    <span>{targetLanguage}</span>
                    <span className="languageOptionLead">targeted</span>
                  </button>
                  {meetingTargetMenuOpen ? (
                    <div className="languageMenuList" role="listbox" aria-label="Meeting target language">
                      {targetLanguageOptions.map((language) => (
                        <button
                          type="button"
                          className={language === targetLanguage ? "languageMenuOption active" : "languageMenuOption"}
                          role="option"
                          aria-selected={language === targetLanguage}
                          key={language}
                          onMouseDown={(event) => event.preventDefault()}
                          onClick={() => {
                            setTargetLanguage(language);
                            setMeetingTargetMenuOpen(false);
                          }}
                        >
                          <span>{language}</span>
                          <span className="languageOptionLead">targeted</span>
                        </button>
                      ))}
                    </div>
                  ) : null}
                </div>
              </div>
            </header>
            <div
              className="meetingChat"
              aria-live="polite"
              ref={meetingChatRef}
              onScroll={() => {
                meetingFollowBottomRef.current = isScrolledToBottom(meetingChatRef.current);
              }}
            >
              {hasMeetingDisplay ? (
                <>
                  {groupedMeetingSegments.map((segment, index) => (
                    <div className="chatTurn diarizedTurn" key={`${segment.speaker}-${index}`}>
                      <div className="speakerTag">
                        {segment.speaker}
                        <span className="speakerDivider"> |</span>
                      </div>
                      <MarkdownText text={segment.text} />
                    </div>
                  ))}
                  {hasDiarizedMeetingDisplay && hasTranslatedMeetingDisplay ? (
                    <div className="meetingSectionDivider" role="separator" aria-label="Translation begins">
                      <span>--</span>
                    </div>
                  ) : null}
                  {hasTranslatedMeetingDisplay ? (
                    <div className="chatTurn liveMeetingTurn">
                      <div className="speakerTag">
                        Translation
                      </div>
                      <MarkdownText text={meetingDisplayTranslationText} />
                    </div>
                  ) : null}
                </>
              ) : (
                <p className="meetingEmpty">
                  {running ? "Recording meeting audio..." : meetingProcessing ? "Splitting speakers..." : "Press Play to record a meeting, then Stop to split speakers."}
                </p>
              )}
            </div>
          </article>
        </section>
      ) : (
        <section className="textGrid">
          <article className="languagePane">
            <header className="paneHeader">
              <div className="paneTitle">
                <span>User</span>
              </div>
              <span className="usageEstimate" title={`${totalUsageTitle}. GPT-Realtime-Whisper is billed at ${formatUsdRate(apiPricing.realtimeWhisperUsdPerSecond)} per second while user transcription is on.`}>
                {sourceUsageLabel}
              </span>
              <div className="paneTools">
                <button className="toolButton" aria-label="Download user text" onClick={() => exportMarkdown("user", sourceText)}>
                  <Download size={17} />
                </button>
                <select value={sourceLanguage} onChange={(event) => setSourceLanguage(event.target.value)} disabled={running}>
                  {languageOptions.map((language) => (
                    <option key={language}>{language}</option>
                  ))}
                </select>
              </div>
            </header>
            <div className="editorWrap">
              <textarea
                ref={sourceEditorRef}
                className={[
                  "textEditor",
                  sourceProvisional ? "provisionalText" : "",
                ].filter(Boolean).join(" ")}
                value={sourceText}
                onScroll={() => handleScrollableTextScroll(sourceEditorRef.current, sourceFollowBottomRef, setShowSourceDown)}
                onChange={(event) => {
                  setSourceText(event.target.value);
                  if (!runningRef.current) {
                    sourceSessionBaseRef.current = event.target.value.trim();
                  }
                }}
                placeholder="Waiting for user voice..."
                spellCheck
              />
              {showSourceDown ? (
                <button className="downButton" aria-label="Scroll user text to bottom" onClick={() => scrollEditorToBottom(sourceEditorRef.current, setShowSourceDown)}>
                  <ArrowDown size={18} />
                </button>
              ) : null}
            </div>
          </article>

          <article className="languagePane">
            <header className="paneHeader">
              <div className="paneTitle">
                <span>Translation</span>
              </div>
              <span className="usageEstimate" title={`${totalUsageTitle}. GPT-Realtime-Translate is billed at ${formatUsdRate(apiPricing.realtimeTranslateUsdPerSecond)} per second per translation session.`}>
                {translateUsageLabel}
              </span>
              <div className="paneTools">
                <button className="toolButton" aria-label="Download target text" onClick={() => exportMarkdown("target", targetText)}>
                  <Download size={17} />
                </button>
                <select value={targetLanguage} onChange={(event) => setTargetLanguage(event.target.value)} disabled={running}>
                  {targetLanguageOptions.map((language) => (
                    <option key={language}>{language}</option>
                  ))}
                </select>
              </div>
            </header>
            <div className="editorWrap">
              <textarea
                ref={targetEditorRef}
                className={[
                  "textEditor",
                  targetProvisional ? "provisionalText" : "",
                ].filter(Boolean).join(" ")}
                value={targetText}
                onScroll={() => handleScrollableTextScroll(targetEditorRef.current, targetFollowBottomRef, setShowTargetDown)}
                onChange={(event) => {
                  setTargetText(event.target.value);
                  if (!runningRef.current) {
                    targetSessionBaseRef.current = event.target.value.trim();
                  }
                }}
                placeholder="Translation appears here..."
                spellCheck
              />
              {showTargetDown ? (
                <button className="downButton" aria-label="Scroll target text to bottom" onClick={() => scrollEditorToBottom(targetEditorRef.current, setShowTargetDown)}>
                  <ArrowDown size={18} />
                </button>
              ) : null}
            </div>
          </article>
        </section>
      )}
    </main>
  );
}

function logUi(event: string, data: Record<string, unknown> = {}) {
  window.translator?.logUiEvent(event, data);
}

function MarkdownText({ text }: { text: string }) {
  const blocks = text.split(/\n{2,}/).map((block) => block.trim()).filter(Boolean);
  return (
    <div className="markdownText">
      {blocks.map((block, index) => {
        if (block.startsWith("### ")) {
          return <h4 key={index}>{renderInlineMarkdown(block.slice(4))}</h4>;
        }
        if (block.startsWith("## ")) {
          return <h3 key={index}>{renderInlineMarkdown(block.slice(3))}</h3>;
        }
        if (block.startsWith("# ")) {
          return <h2 key={index}>{renderInlineMarkdown(block.slice(2))}</h2>;
        }
        if (block.split("\n").every((line) => line.trim().startsWith("- "))) {
          return (
            <ul key={index}>
              {block.split("\n").map((line, lineIndex) => (
                <li key={lineIndex}>{renderInlineMarkdown(line.trim().slice(2))}</li>
              ))}
            </ul>
          );
        }
        return <p key={index}>{renderInlineMarkdown(block)}</p>;
      })}
    </div>
  );
}

function renderInlineMarkdown(text: string) {
  const parts = text.split(/(\*\*[^*]+\*\*|`[^`]+`)/g).filter(Boolean);
  return parts.map((part, index) => {
    if (part.startsWith("**") && part.endsWith("**")) {
      return <strong key={index}>{part.slice(2, -2)}</strong>;
    }
    if (part.startsWith("`") && part.endsWith("`")) {
      return <code key={index}>{part.slice(1, -1)}</code>;
    }
    return part;
  });
}

function readInitialThemeMode(): ThemeMode {
  try {
    const stored = window.localStorage.getItem(themeStorageKey);
    if (stored === "light" || stored === "dark") {
      return stored;
    }
  } catch {
    return "light";
  }
  return window.matchMedia?.("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

function hiddenStatus(message: string | undefined) {
  if (!message) {
    return false;
  }
  const normalized = message.toLowerCase();
  return normalized.includes("warm socket closed") || normalized.includes("warm socket ready") || normalized.includes("warm translation token ready") || normalized.includes("websocket ready");
}

function apiKeyStatusMessage(storage: "encrypted" | "local" | "environment" | "none") {
  if (storage === "encrypted") {
    return "API key is stored on this device with OS encryption.";
  }
  if (storage === "local") {
    return "API key is stored on this device.";
  }
  if (storage === "environment") {
    return "API key is loaded from the local environment.";
  }
  return "Stored only on this device.";
}

function saveableText(text: string, placeholder: string) {
  const trimmed = text.trim();
  return trimmed === placeholder ? "" : trimmed;
}

function markdownDocument(title: string, text: string) {
  return `# ${title}\n\n${saveableText(text, title === "User text" ? sourcePlaceholder : targetPlaceholder)}\n`;
}

function meetingMarkdownDocument(segments: MeetingTranscriptSegment[], sourceText: string, targetText: string) {
  const sourceMarkdown = segments.length
    ? formatMeetingSegmentsMarkdown(segments)
    : saveableText(sourceText, sourcePlaceholder);
  const targetMarkdown = saveableText(targetText, targetPlaceholder);
  const sections = ["# Meeting transcript"];
  if (sourceMarkdown) {
    sections.push(`## Speaker split\n\n${sourceMarkdown}`);
  }
  if (targetMarkdown) {
    sections.push(`## Translation\n\n${targetMarkdown}`);
  }
  return `${sections.join("\n\n")}\n`;
}

function hasMeetingExportText(segments: MeetingTranscriptSegment[], sourceText: string, targetText: string) {
  return Boolean(segments.length || saveableText(sourceText, sourcePlaceholder) || saveableText(targetText, targetPlaceholder));
}

async function createMeetingRecording(deviceId: string, persistLocalAudio = false): Promise<MeetingRecordingSession> {
  if (typeof MediaRecorder === "undefined") {
    throw new Error("Meeting recording is not supported in this browser runtime.");
  }
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: {
      deviceId: deviceId ? { exact: deviceId } : undefined,
      echoCancellation: true,
      noiseSuppression: true,
      autoGainControl: true
    }
  });
  return createMeetingRecordingFromStream(stream, persistLocalAudio);
}

function createMeetingRecordingFromStream(stream: MediaStream, persistLocalAudio = false): MeetingRecordingSession {
  if (typeof MediaRecorder === "undefined") {
    throw new Error("Meeting recording is not supported in this browser runtime.");
  }
  const chunks: Blob[] = [];
  const pendingSaves: Promise<void>[] = [];
  const localSessionId = localMeetingAudioSessionId();
  const mimeType = meetingAudioMimeType();
  const recorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
  const stopped = new Promise<Blob>((resolve) => {
    recorder.ondataavailable = (event) => {
      if (event.data.size) {
        chunks.push(event.data);
        if (persistLocalAudio) {
          const sequence = chunks.length - 1;
          pendingSaves.push(persistMeetingAudioChunk(localSessionId, sequence, event.data));
        }
      }
    };
    recorder.onstop = () => {
      resolve(new Blob(chunks, { type: recorder.mimeType || mimeType || "audio/webm" }));
    };
  });
  return {
    recorder,
    stream,
    chunks,
    pendingSaves,
    stopped,
    startedAtMs: Date.now()
  };
}

function localMeetingAudioSessionId() {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

async function persistMeetingAudioChunk(sessionId: string, sequence: number, audio: Blob) {
  if (!window.translator?.saveMeetingAudioChunk) {
    return;
  }
  try {
    await window.translator.saveMeetingAudioChunk({
      sessionId,
      sequence,
      base64Audio: await blobToBase64(audio),
      mimeType: audio.type || meetingAudioMimeType() || "audio/webm",
      capturedAt: Date.now()
    });
  } catch (error) {
    window.translator?.logUiEvent("meeting_audio_chunk_save_error", {
      message: error instanceof Error ? error.message : "Could not save meeting audio chunk",
      sequence
    });
  }
}

async function waitForMeetingAudioSaves(recording: MeetingRecordingSession) {
  await Promise.allSettled(recording.pendingSaves);
}

function meetingAudioMimeType() {
  for (const mimeType of ["audio/webm;codecs=opus", "audio/webm", "audio/mp4", "audio/ogg;codecs=opus"]) {
    if (MediaRecorder.isTypeSupported(mimeType)) {
      return mimeType;
    }
  }
  return "";
}

function blobToBase64(blob: Blob) {
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = typeof reader.result === "string" ? reader.result : "";
      resolve(result.includes(",") ? result.split(",")[1] : result);
    };
    reader.onerror = () => reject(reader.error || new Error("Could not read meeting audio."));
    reader.readAsDataURL(blob);
  });
}

function speakerCount(segments: MeetingTranscriptSegment[]) {
  return new Set(segments.map((segment) => segment.speaker)).size;
}

function formatMeetingSegmentsMarkdown(segments: MeetingTranscriptSegment[]) {
  return mergeConsecutiveSpeakerSegments(segments).map((segment) => {
    const timeRange = formatSegmentTimeRange(segment);
    return `### ${segment.speaker}${timeRange ? ` ${timeRange}` : ""}\n\n${segment.text}`;
  }).join("\n\n");
}

function mergeConsecutiveSpeakerSegments(segments: MeetingTranscriptSegment[]) {
  const grouped: MeetingTranscriptSegment[] = [];
  for (const segment of segments) {
    const text = formatTranscriptForDisplay(segment.text);
    if (!text) {
      continue;
    }
    const previous = grouped[grouped.length - 1];
    if (previous && previous.speaker === segment.speaker) {
      previous.text = appendDisplayText(previous.text, text);
      previous.end = segment.end ?? previous.end;
      continue;
    }
    grouped.push({ ...segment, text });
  }
  return grouped;
}

function formatSegmentTimeRange(segment: MeetingTranscriptSegment) {
  if (segment.start === undefined && segment.end === undefined) {
    return "";
  }
  const start = segment.start === undefined ? "?" : formatTimestamp(segment.start);
  const end = segment.end === undefined ? "?" : formatTimestamp(segment.end);
  return `_${start}-${end}_`;
}

function formatTimestamp(seconds: number) {
  const safeSeconds = Math.max(0, Math.floor(seconds));
  const minutes = Math.floor(safeSeconds / 60);
  const remainingSeconds = safeSeconds % 60;
  return `${minutes}:${remainingSeconds.toString().padStart(2, "0")}`;
}

function calculateCostUsage(session: ActiveCostSession, nowMs: number): CostUsage {
  const workingMs = session.usageBasis === "wallClock"
    ? Math.max(0, nowMs - session.startedAtMs)
    : session.realtimeAudioMs;
  const translateBillableMs = workingMs * session.translationSessionCount;
  const whisperBillableMs = session.transcribeUserVoice ? workingMs : 0;
  return {
    workingMs,
    translateBillableMs,
    whisperBillableMs,
    meetingDiarizeBillableMs: 0,
    translateUsd: (translateBillableMs / 1000) * session.realtimeTranslateUsdPerSecond,
    whisperUsd: (whisperBillableMs / 1000) * session.realtimeWhisperUsdPerSecond,
    meetingDiarizeUsd: 0
  };
}

function calculateMeetingDiarizeUsage(session: ActiveMeetingDiarizeSession, nowMs: number): CostUsage {
  const billableUntilMs = session.endedAtMs ?? nowMs;
  const meetingDiarizeBillableMs = Math.max(0, billableUntilMs - session.startedAtMs);
  return {
    workingMs: 0,
    translateBillableMs: 0,
    whisperBillableMs: 0,
    meetingDiarizeBillableMs,
    translateUsd: 0,
    whisperUsd: 0,
    meetingDiarizeUsd: (meetingDiarizeBillableMs / 1000) * session.meetingDiarizeUsdPerSecond
  };
}

function addCostUsage(left: CostUsage, right: CostUsage): CostUsage {
  return {
    workingMs: left.workingMs + right.workingMs,
    translateBillableMs: left.translateBillableMs + right.translateBillableMs,
    whisperBillableMs: left.whisperBillableMs + right.whisperBillableMs,
    meetingDiarizeBillableMs: left.meetingDiarizeBillableMs + right.meetingDiarizeBillableMs,
    translateUsd: left.translateUsd + right.translateUsd,
    whisperUsd: left.whisperUsd + right.whisperUsd,
    meetingDiarizeUsd: left.meetingDiarizeUsd + right.meetingDiarizeUsd
  };
}

function formatDuration(ms: number) {
  const totalSeconds = Math.floor(ms / 1000);
  const seconds = totalSeconds % 60;
  const totalMinutes = Math.floor(totalSeconds / 60);
  const minutes = totalMinutes % 60;
  const hours = Math.floor(totalMinutes / 60);
  if (hours) {
    return `${hours}:${minutes.toString().padStart(2, "0")}:${seconds.toString().padStart(2, "0")}`;
  }
  return `${minutes}:${seconds.toString().padStart(2, "0")}`;
}

function formatUsd(value: number) {
  return `$${value.toFixed(value < 0.01 ? 4 : 3)}`;
}

function formatUsdRate(value: number) {
  return `$${value.toFixed(5)}`;
}

function mergeSessionText(baseText: string, sessionText: string) {
  const formattedSession = formatTranscriptForDisplay(sessionText);
  return appendDisplayText(baseText, formattedSession);
}

function appendDisplayText(baseText: string, nextText: string) {
  const trimmedBase = formatTranscriptForDisplay(baseText);
  const formattedNext = formatTranscriptForDisplay(nextText);
  if (!trimmedBase) {
    return formattedNext;
  }
  if (!formattedNext) {
    return trimmedBase;
  }
  return `${trimmedBase}${needsDisplayJoinSpace(trimmedBase, formattedNext) ? "\n" : ""}${formattedNext}`;
}

function appendDisplayTextIfMissing(baseText: string, nextText: string) {
  const trimmedBase = formatTranscriptForDisplay(baseText);
  const formattedNext = formatTranscriptForDisplay(nextText);
  if (!formattedNext) {
    return trimmedBase;
  }
  if (!trimmedBase || trimmedBase.endsWith(formattedNext)) {
    return trimmedBase || formattedNext;
  }
  if (formattedNext.startsWith(trimmedBase)) {
    return formattedNext;
  }
  return appendDisplayText(trimmedBase, formattedNext);
}

function formatTranscriptForDisplay(text: string) {
  const normalized = text
    .trim()
    .replace(/\r\n?/g, "\n")
    .replace(/[ \t]*\n[ \t]*/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/[ \t]{2,}/g, " ");
  return splitTranscriptLines(addMissingTerminalPunctuation(normalized));
}

function addMissingTerminalPunctuation(text: string) {
  return text
    .split("\n")
    .map((line) => {
      const trimmed = line.trim();
      if (!trimmed || terminalPunctuationPattern.test(trimmed)) {
        return trimmed;
      }
      return `${trimmed}.`;
    })
    .join("\n");
}

function splitTranscriptLines(text: string) {
  return text
    .split(/\n{2,}/)
    .map((block) => block
      .replace(/\b([A-Za-z]{1,12})([.!?])\s+(?=[A-Z0-9가-힣一-龥ぁ-んァ-ン])/g, (match, word: string, mark: string) => {
        return sentenceBoundaryAbbreviations.has(word.toLowerCase()) ? match : `${word}${mark}\n`;
      })
      .replace(/([。？！])(?=[^\s。？！])/g, "$1\n")
      .replace(/\n{3,}/g, "\n\n")
      .trim())
    .filter(Boolean)
    .join("\n\n");
}

const sentenceBoundaryAbbreviations = new Set([
  "mr",
  "mrs",
  "ms",
  "dr",
  "prof",
  "sr",
  "jr",
  "st",
  "vs",
  "etc"
]);

function needsDisplayJoinSpace(previous: string, next: string) {
  return !/[\s([{“‘"']$/.test(previous) && !/^[\s,.;:!?)}\]。？！、，；：）]/.test(next);
}

function updateDownIndicator(editor: HTMLTextAreaElement | null, setter: (value: boolean) => void) {
  if (!editor) {
    setter(false);
    return;
  }
  setter(!isScrolledToBottom(editor));
}

function handleScrollableTextScroll(editor: HTMLTextAreaElement | null, followRef: { current: boolean }, setter: (value: boolean) => void) {
  followRef.current = isScrolledToBottom(editor);
  updateDownIndicator(editor, setter);
}

function followBottomIfNeeded(element: HTMLElement | null, followRef: { current: boolean }) {
  if (!element || !followRef.current) {
    return;
  }
  element.scrollTop = element.scrollHeight;
}

function isScrolledToBottom(element: HTMLElement | null) {
  if (!element) {
    return true;
  }
  return element.scrollTop + element.clientHeight >= element.scrollHeight - 8;
}

function nextPaint() {
  return new Promise<void>((resolve) => {
    requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
  });
}

async function waitForMeetingTranslationSettled(finalRef: { current: boolean }, updatedAtRef: { current: number }, maxMs = 6000) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < maxMs) {
    if (meetingTranslationIsSettled(finalRef, updatedAtRef, startedAt)) {
      return;
    }
    await delay(120);
  }
}

function meetingTranslationIsSettled(finalRef: { current: boolean }, updatedAtRef: { current: number }, startedAt: number) {
  const lastUpdateAt = updatedAtRef.current;
  if (!lastUpdateAt) {
    return Date.now() - startedAt > 800;
  }
  if (finalRef.current) {
    return Date.now() - lastUpdateAt > 500;
  }
  return Date.now() - lastUpdateAt > 1200;
}

function delay(ms: number) {
  return new Promise<void>((resolve) => window.setTimeout(resolve, ms));
}
