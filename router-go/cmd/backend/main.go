package main

import (
	"bytes"
	"crypto/rand"
	"crypto/subtle"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"mime/multipart"
	"net/http"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/gorilla/websocket"
)

const (
	apiKeyPageURL                    = "https://platform.openai.com/settings/organization/api-keys"
	bridgePath                       = "/bridge"
	apiKeyStoreFile                  = "openai-api-key.json"
	maxAPIKeyLength                  = 4096
	maxAudioBase64Length             = 64 * 1024
	maxMeetingAudioChunkBase64Length = 6 * 1024 * 1024
	maxMeetingAudioBase64Length      = 36 * 1024 * 1024
	maxBridgeMessageBytes            = 40 * 1024 * 1024
	allowOpenAIBaseURLOverrideFlag   = "CO_TRANSLATOR_ALLOW_OPENAI_BASE_URL_OVERRIDE"
)

var (
	bridgeTokenValue string
	runtimeAPIKeyMu  sync.Mutex
	runtimeAPIKey    string
)

type bridgeRequest struct {
	ID      string          `json:"id,omitempty"`
	Command string          `json:"command"`
	Payload json.RawMessage `json:"payload,omitempty"`
}

type bridgeResponse struct {
	ID     string      `json:"id"`
	OK     bool        `json:"ok"`
	Result interface{} `json:"result,omitempty"`
	Error  string      `json:"error,omitempty"`
}

type eventEnvelope struct {
	Type  string      `json:"type"`
	Event interface{} `json:"event"`
}

type config struct {
	SourceLanguage      string `json:"sourceLanguage"`
	TargetLanguage      string `json:"targetLanguage"`
	LatencyMode         string `json:"latencyMode"`
	TranscribeUserVoice *bool  `json:"transcribeUserVoice,omitempty"`
}

type audioChunk struct {
	Base64PCM16     string  `json:"base64Pcm16"`
	CapturedAt      int64   `json:"capturedAt"`
	SpeechStartedAt *int64  `json:"speechStartedAt,omitempty"`
	ChunkMs         float64 `json:"chunkMs"`
	RMS             float64 `json:"rms"`
}

type meetingRequest struct {
	Base64Audio    string `json:"base64Audio"`
	MimeType       string `json:"mimeType"`
	SourceLanguage string `json:"sourceLanguage"`
	TargetLanguage string `json:"targetLanguage"`
}

type meetingSegment struct {
	Speaker string  `json:"speaker,omitempty"`
	Text    string  `json:"text"`
	Start   float64 `json:"start,omitempty"`
	End     float64 `json:"end,omitempty"`
	Index   int     `json:"index,omitempty"`
}

type meetingResult struct {
	Text     string           `json:"text,omitempty"`
	Segments []meetingSegment `json:"segments"`
}

type saveChunkRequest struct {
	SessionID   string `json:"sessionId"`
	Sequence    int    `json:"sequence"`
	Base64Audio string `json:"base64Audio"`
	MimeType    string `json:"mimeType"`
	CapturedAt  int64  `json:"capturedAt"`
}

type server struct {
	mu                       sync.Mutex
	writeMu                  sync.Mutex
	clientWriteMu            sync.Mutex
	clients                  map[*websocket.Conn]bool
	realtime                 []*websocket.Conn
	transcription            *websocket.Conn
	transcriptionConfig      config
	transcriptionAppendCount int
	warmedTranscription      bool
	activeConfig             config
	exitSource               string
	exitTarget               string
	httpClient               *http.Client
}

func main() {
	if len(os.Args) > 1 && os.Args[1] == "--prewarm-exit" {
		return
	}

	s := &server{clients: map[*websocket.Conn]bool{}, httpClient: &http.Client{Timeout: 60 * time.Second}}
	mux := http.NewServeMux()
	mux.HandleFunc("/health", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.Header().Set("Access-Control-Allow-Origin", "*")
		_, _ = w.Write([]byte(`{"ok":true}`))
	})
	mux.HandleFunc(bridgePath, s.handleBridge)
	port := getenv("CO_TRANSLATOR_BRIDGE_PORT", "41873")
	logLatency("bridge_server_listening", map[string]interface{}{"port": port, "runtime": "go"})
	if err := http.ListenAndServe("127.0.0.1:"+port, mux); err != nil {
		log.Fatal(err)
	}
}

func bridgeRequestAuthorized(r *http.Request) bool {
	token := r.URL.Query().Get("token")
	if subtle.ConstantTimeCompare([]byte(token), []byte(bridgeToken())) != 1 {
		return false
	}
	origin := r.Header.Get("Origin")
	if origin == "" {
		return true
	}
	switch origin {
	case "zero://app", "zero://inline", "file://local", "file://", "http://127.0.0.1:5173", "http://localhost:5173":
		return true
	default:
		return false
	}
}

func bridgeToken() string {
	if bridgeTokenValue != "" {
		return bridgeTokenValue
	}
	if token := strings.TrimSpace(os.Getenv("CO_TRANSLATOR_BRIDGE_TOKEN")); token != "" {
		bridgeTokenValue = token
		return bridgeTokenValue
	}
	var raw [32]byte
	if _, err := rand.Read(raw[:]); err != nil {
		panic(err)
	}
	bridgeTokenValue = hex.EncodeToString(raw[:])
	return bridgeTokenValue
}

func (s *server) handleBridge(w http.ResponseWriter, r *http.Request) {
	upgrader := websocket.Upgrader{CheckOrigin: bridgeRequestAuthorized}
	conn, err := upgrader.Upgrade(w, r, nil)
	if err != nil {
		return
	}
	conn.SetReadLimit(maxBridgeMessageBytes)
	s.mu.Lock()
	s.clients[conn] = true
	s.mu.Unlock()
	defer func() { s.mu.Lock(); delete(s.clients, conn); s.mu.Unlock(); _ = conn.Close() }()
	for {
		_, data, err := conn.ReadMessage()
		if err != nil {
			return
		}
		var req bridgeRequest
		if err := json.Unmarshal(data, &req); err != nil || req.Command == "" {
			continue
		}
		if req.ID == "" {
			_, _ = s.runCommand(req.Command, req.Payload)
			continue
		}
		result, err := s.runCommand(req.Command, req.Payload)
		response := bridgeResponse{ID: req.ID, OK: err == nil, Result: result}
		if err != nil {
			response.Error = err.Error()
		}
		s.clientWriteMu.Lock()
		_ = conn.WriteJSON(response)
		s.clientWriteMu.Unlock()
	}
}

func (s *server) runCommand(command string, payload json.RawMessage) (interface{}, error) {
	switch command {
	case "translator:get-api-key-status":
		return s.apiKeyStatus(), nil
	case "translator:get-api-pricing":
		return apiPricing(), nil
	case "translator:set-api-key":
		var key string
		_ = json.Unmarshal(payload, &key)
		return s.setAPIKey(key)
	case "translator:open-api-key-page":
		return nil, openExternal(apiKeyPageURL)
	case "translator:warm":
		cfg, err := parseConfig(payload)
		if err != nil {
			return nil, err
		}
		return nil, s.warm(cfg)
	case "translator:start":
		cfg, err := parseConfig(payload)
		if err != nil {
			return nil, err
		}
		return nil, s.start(cfg)
	case "translator:start-translation-call":
		cfg, err := parseConfig(payload)
		if err != nil {
			return nil, err
		}
		return s.startTranslationCall(cfg)
	case "translator:audio":
		var chunk audioChunk
		if err := json.Unmarshal(payload, &chunk); err != nil {
			return nil, err
		}
		if err := validateAudioChunk(chunk); err != nil {
			return nil, err
		}
		s.receiveAudio(chunk)
		return nil, nil
	case "translator:stop":
		return nil, s.stop()
	case "translator:meeting-transcribe":
		var req meetingRequest
		if err := json.Unmarshal(payload, &req); err != nil {
			return nil, err
		}
		if err := validateMeetingRequest(req); err != nil {
			return nil, err
		}
		return s.transcribeMeeting(req)
	case "translator:save-meeting-audio-chunk":
		var req saveChunkRequest
		if err := json.Unmarshal(payload, &req); err != nil {
			return nil, err
		}
		if err := validateSaveChunkRequest(req); err != nil {
			return nil, err
		}
		return nil, saveMeetingAudioChunk(req)
	case "translator:exit-save-state":
		var state struct{ SourceText, TargetText string }
		_ = json.Unmarshal(payload, &state)
		s.mu.Lock()
		s.exitSource = state.SourceText
		s.exitTarget = state.TargetText
		s.mu.Unlock()
		return nil, nil
	case "translator:ui-log":
		return nil, nil
	case "translator:save-exit-texts":
		return true, nil
	default:
		return nil, fmt.Errorf("unknown bridge command: %s", command)
	}
}

func parseConfig(payload []byte) (config, error) {
	var cfg config
	if err := json.Unmarshal(payload, &cfg); err != nil {
		return cfg, err
	}
	if cfg.SourceLanguage == "" {
		cfg.SourceLanguage = "Auto"
	}
	if cfg.TargetLanguage == "" {
		return cfg, errors.New("target language is required")
	}
	if cfg.LatencyMode == "" {
		cfg.LatencyMode = "balanced"
	}
	return cfg, nil
}

func (s *server) apiKeyStatus() map[string]interface{} {
	if currentRuntimeAPIKey() != "" {
		return map[string]interface{}{"configured": true, "storage": "local"}
	}
	if v := os.Getenv("OPENAI_API_KEY"); v != "" {
		if _, err := validateAPIKey(v); err != nil {
			return map[string]interface{}{"configured": false, "storage": "none"}
		}
		return map[string]interface{}{"configured": true, "storage": "environment"}
	}
	if readStoredAPIKey() != "" {
		return map[string]interface{}{"configured": true, "storage": "local"}
	}
	return map[string]interface{}{"configured": false, "storage": "none"}
}

func (s *server) setAPIKey(key string) (map[string]interface{}, error) {
	key, err := validateAPIKey(key)
	if err != nil {
		return nil, err
	}
	if err := os.MkdirAll(userDataDir(), 0700); err != nil {
		return nil, err
	}
	data, _ := json.MarshalIndent(map[string]string{"encoding": "plaintext-v1", "value": key}, "", "  ")
	if err := os.WriteFile(apiKeyStorePath(), data, 0600); err != nil {
		return nil, err
	}
	setRuntimeAPIKey(key)
	return map[string]interface{}{"configured": true, "storage": "local"}, nil
}

func apiPricing() map[string]interface{} {
	return map[string]interface{}{
		"realtimeTranslateUsdPerMinute": 0.034,
		"realtimeTranslateUsdPerSecond": 0.00057,
		"realtimeWhisperUsdPerMinute":   0.017,
		"realtimeWhisperUsdPerSecond":   0.00028,
		"realtimeRaceSockets":           realtimeRaceSockets(),
		"meetingDiarizeUsdPerMinute":    0.006,
		"meetingDiarizeUsdPerSecond":    0.0001,
		"realtimeSourceTranscriptMode":  "separate",
	}
}

func (s *server) warm(cfg config) error {
	if cfg.LatencyMode == "webrtc" {
		_, err := s.translationClientSecret(cfg)
		return err
	}
	return s.ensureTranscription(cfg, true)
}

func (s *server) start(cfg config) error {
	s.mu.Lock()
	s.activeConfig = cfg
	s.mu.Unlock()
	logLatency("translator_start", map[string]interface{}{"latencyMode": cfg.LatencyMode, "targetLanguage": cfg.TargetLanguage})
	s.broadcast(map[string]interface{}{"type": "state", "state": "connecting", "message": "Connecting to OpenAI Realtime"})
	if err := s.connectRealtime(cfg); err != nil {
		return err
	}
	if shouldTranscribe(cfg) {
		if err := s.ensureTranscription(cfg, false); err != nil {
			return err
		}
	}
	s.broadcast(map[string]interface{}{"type": "state", "state": "connected", "message": "Connected"})
	return nil
}

func (s *server) startTranslationCall(cfg config) (map[string]string, error) {
	secret, err := s.translationClientSecret(cfg)
	if err != nil {
		return nil, err
	}
	if shouldTranscribe(cfg) {
		_ = s.ensureTranscription(cfg, false)
	}
	return map[string]string{"clientSecret": secret}, nil
}

func shouldTranscribe(cfg config) bool {
	return cfg.TranscribeUserVoice == nil || *cfg.TranscribeUserVoice
}

func (s *server) translationClientSecret(cfg config) (string, error) {
	body := map[string]interface{}{"session": map[string]interface{}{"model": getenv("OPENAI_REALTIME_MODEL", "gpt-realtime-translate"), "audio": map[string]interface{}{"output": map[string]string{"language": languageCode(cfg.TargetLanguage)}}}}
	encoded, _ := json.Marshal(body)
	base, err := apiBase()
	if err != nil {
		return "", err
	}
	req, err := http.NewRequest("POST", base+"/v1/realtime/translations/client_secrets", bytes.NewReader(encoded))
	if err != nil {
		return "", err
	}
	req.Header.Set("Authorization", "Bearer "+apiKey())
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("OpenAI-Safety-Identifier", "co-translator-local-desktop")
	resp, err := s.httpClient.Do(req)
	if err != nil {
		return "", err
	}
	defer resp.Body.Close()
	var payload map[string]interface{}
	_ = json.NewDecoder(resp.Body).Decode(&payload)
	if resp.StatusCode >= 300 {
		return "", fmt.Errorf("could not create translation client secret (%d)", resp.StatusCode)
	}
	if value, ok := payload["value"].(string); ok && value != "" {
		return value, nil
	}
	if nested, ok := payload["client_secret"].(map[string]interface{}); ok {
		if value, ok := nested["value"].(string); ok && value != "" {
			return value, nil
		}
	}
	return "", errors.New("translation client secret response did not include a value")
}

func (s *server) connectRealtime(cfg config) error {
	s.closeRealtime()
	count := 1
	if cfg.LatencyMode == "fast" {
		count = realtimeRaceSockets()
	}
	sockets := make([]*websocket.Conn, 0, count)
	for lane := 0; lane < count; lane++ {
		base, err := realtimeBase()
		if err != nil {
			return err
		}
		u := base + "/v1/realtime/translations?model=" + url.QueryEscape(getenv("OPENAI_REALTIME_MODEL", "gpt-realtime-translate"))
		conn, _, err := websocket.DefaultDialer.Dial(u, http.Header{"Authorization": {"Bearer " + apiKey()}, "OpenAI-Safety-Identifier": {"co-translator-local-desktop"}})
		if err != nil {
			s.closeRealtime()
			return err
		}
		sockets = append(sockets, conn)
		go s.readRealtime(conn, lane, count)
		_ = conn.WriteJSON(map[string]interface{}{"type": "session.update", "session": map[string]interface{}{"audio": map[string]interface{}{"output": map[string]string{"language": languageCode(cfg.TargetLanguage)}}}})
	}
	s.mu.Lock()
	s.realtime = sockets
	s.mu.Unlock()
	return nil
}

func (s *server) readRealtime(conn *websocket.Conn, lane, count int) {
	for {
		var event map[string]interface{}
		if err := conn.ReadJSON(&event); err != nil {
			return
		}
		typ, _ := event["type"].(string)
		switch typ {
		case "session.input_transcript.delta":
			s.mu.Lock()
			hasTranscription := s.transcription != nil
			s.mu.Unlock()
			if hasTranscription {
				continue
			}
			if delta, _ := event["delta"].(string); delta != "" {
				s.broadcast(map[string]interface{}{"type": "sourceTranscript", "text": delta, "final": false})
			}
		case "session.input_transcript.done":
			s.mu.Lock()
			hasTranscription := s.transcription != nil
			s.mu.Unlock()
			if hasTranscription {
				continue
			}
			if text, _ := event["transcript"].(string); text != "" {
				s.broadcast(map[string]interface{}{"type": "sourceTranscript", "text": text, "final": true})
			}
		case "session.output_transcript.delta":
			if delta, _ := event["delta"].(string); delta != "" {
				s.broadcast(map[string]interface{}{"type": "targetTranslation", "text": delta, "final": false})
			}
		case "session.output_transcript.done":
			if text, _ := event["transcript"].(string); text != "" {
				s.broadcast(map[string]interface{}{"type": "targetTranslation", "text": text, "final": true})
			}
		case "error":
			s.broadcast(map[string]interface{}{"type": "error", "message": "Realtime API error"})
		}
	}
}

func (s *server) ensureTranscription(cfg config, warm bool) error {
	s.mu.Lock()
	existing := s.transcription
	same := existing != nil && s.transcriptionConfig.SourceLanguage == cfg.SourceLanguage && shouldTranscribe(s.transcriptionConfig) == shouldTranscribe(cfg)
	s.mu.Unlock()
	if same {
		logLatency("transcription_warm_reused", map[string]interface{}{"sourceLanguage": cfg.SourceLanguage})
		return nil
	}
	s.closeTranscription()
	base, err := realtimeBase()
	if err != nil {
		return err
	}
	u := base + "/v1/realtime?intent=transcription"
	conn, _, err := websocket.DefaultDialer.Dial(u, http.Header{"Authorization": {"Bearer " + apiKey()}, "OpenAI-Safety-Identifier": {"co-translator-local-desktop"}})
	if err != nil {
		return err
	}
	s.mu.Lock()
	s.transcription = conn
	s.transcriptionConfig = cfg
	s.transcriptionAppendCount = 0
	s.warmedTranscription = warm
	s.mu.Unlock()
	go s.readTranscription(conn)
	transcription := map[string]string{"model": getenv("OPENAI_REALTIME_TRANSCRIPTION_MODEL", "gpt-realtime-whisper")}
	if code := transcriptionLanguageCode(cfg.SourceLanguage); code != "" {
		transcription["language"] = code
	}
	return conn.WriteJSON(map[string]interface{}{"type": "session.update", "session": map[string]interface{}{"type": "transcription", "audio": map[string]interface{}{"input": map[string]interface{}{"format": map[string]interface{}{"type": "audio/pcm", "rate": 24000}, "transcription": transcription, "turn_detection": nil}}}})
}

func (s *server) readTranscription(conn *websocket.Conn) {
	for {
		var event map[string]interface{}
		if err := conn.ReadJSON(&event); err != nil {
			return
		}
		typ, _ := event["type"].(string)
		switch typ {
		case "conversation.item.input_audio_transcription.delta":
			if delta, _ := event["delta"].(string); delta != "" {
				s.broadcast(map[string]interface{}{"type": "sourceTranscript", "text": delta, "final": false})
			}
		case "conversation.item.input_audio_transcription.completed":
			if text, _ := event["transcript"].(string); text != "" {
				s.broadcast(map[string]interface{}{"type": "sourceTranscript", "text": text, "final": true})
			}
		case "error":
			s.broadcast(map[string]interface{}{"type": "error", "message": "Realtime transcription API error"})
		}
	}
}

func validateAudioChunk(chunk audioChunk) error {
	if !validBase64String(chunk.Base64PCM16, maxAudioBase64Length) {
		return errors.New("audio chunk is invalid")
	}
	if chunk.CapturedAt <= 0 || chunk.ChunkMs <= 0 || chunk.ChunkMs > 1000 || chunk.RMS < 0 || chunk.RMS > 10 {
		return errors.New("audio chunk metadata is invalid")
	}
	if chunk.SpeechStartedAt != nil && *chunk.SpeechStartedAt <= 0 {
		return errors.New("audio chunk speech start is invalid")
	}
	return nil
}

func validateMeetingRequest(req meetingRequest) error {
	if !validBase64String(req.Base64Audio, maxMeetingAudioBase64Length) {
		return errors.New("meeting audio must be a base64 audio file under 25 MB")
	}
	if !validAudioMimeType(req.MimeType) {
		return errors.New("meeting audio must include an audio MIME type")
	}
	if req.TargetLanguage == "" {
		return errors.New("target language is required")
	}
	return nil
}

func validateSaveChunkRequest(req saveChunkRequest) error {
	if !validSessionID(req.SessionID) {
		return errors.New("meeting audio chunk session id is invalid")
	}
	if req.Sequence < 0 || req.Sequence > 999999 {
		return errors.New("meeting audio chunk sequence is invalid")
	}
	if !validBase64String(req.Base64Audio, maxMeetingAudioChunkBase64Length) {
		return errors.New("meeting audio chunk must be a base64 audio file under 6 MB")
	}
	if !validAudioMimeType(req.MimeType) {
		return errors.New("meeting audio chunk must include an audio MIME type")
	}
	if req.CapturedAt <= 0 {
		return errors.New("meeting audio chunk capture time is invalid")
	}
	return nil
}

func validSessionID(value string) bool {
	if len(value) == 0 || len(value) > 80 {
		return false
	}
	for _, char := range value {
		if (char >= 'a' && char <= 'z') || (char >= 'A' && char <= 'Z') || (char >= '0' && char <= '9') || char == '.' || char == '_' || char == '-' {
			continue
		}
		return false
	}
	return true
}

func validAudioMimeType(value string) bool {
	return strings.HasPrefix(value, "audio/") && len(value) <= 120
}

func validBase64String(value string, maxLength int) bool {
	if value == "" || len(value) > maxLength {
		return false
	}
	for i := 0; i < len(value); i++ {
		char := value[i]
		if (char >= 'A' && char <= 'Z') || (char >= 'a' && char <= 'z') || (char >= '0' && char <= '9') || char == '+' || char == '/' || char == '=' {
			continue
		}
		return false
	}
	return true
}

func (s *server) receiveAudio(chunk audioChunk) {
	msg := map[string]interface{}{"type": "session.input_audio_buffer.append", "audio": chunk.Base64PCM16}
	s.mu.Lock()
	realtime := append([]*websocket.Conn(nil), s.realtime...)
	transcription := s.transcription
	s.transcriptionAppendCount++
	appendCount := s.transcriptionAppendCount
	s.mu.Unlock()
	s.writeMu.Lock()
	defer s.writeMu.Unlock()
	for _, conn := range realtime {
		_ = conn.WriteJSON(msg)
	}
	if transcription != nil {
		_ = transcription.WriteJSON(map[string]interface{}{"type": "input_audio_buffer.append", "audio": chunk.Base64PCM16})
		if appendCount >= 20 {
			_ = transcription.WriteJSON(map[string]interface{}{"type": "input_audio_buffer.commit"})
			s.mu.Lock()
			s.transcriptionAppendCount = 0
			s.mu.Unlock()
		}
	}
	if chunk.SpeechStartedAt != nil {
		s.broadcast(map[string]interface{}{"type": "speechActivity", "speechStartedAt": *chunk.SpeechStartedAt, "rms": chunk.RMS})
	}
}

func (s *server) stop() error {
	s.closeTranscription()
	s.closeRealtime()
	s.broadcast(map[string]interface{}{"type": "state", "state": "idle", "message": "idle"})
	return nil
}

func (s *server) closeRealtime() {
	s.mu.Lock()
	sockets := s.realtime
	s.realtime = nil
	s.mu.Unlock()
	s.writeMu.Lock()
	defer s.writeMu.Unlock()
	for _, conn := range sockets {
		_ = conn.WriteControl(websocket.CloseMessage, websocket.FormatCloseMessage(1000, "closing"), time.Now().Add(time.Second))
		_ = conn.Close()
	}
}
func (s *server) closeTranscription() {
	s.mu.Lock()
	conn := s.transcription
	s.transcription = nil
	s.transcriptionAppendCount = 0
	s.mu.Unlock()
	if conn != nil {
		s.writeMu.Lock()
		defer s.writeMu.Unlock()
		_ = conn.WriteControl(websocket.CloseMessage, websocket.FormatCloseMessage(1000, "closing"), time.Now().Add(time.Second))
		_ = conn.Close()
	}
}

func (s *server) transcribeMeeting(req meetingRequest) (meetingResult, error) {
	audio, err := base64.StdEncoding.DecodeString(req.Base64Audio)
	if err != nil {
		return meetingResult{}, err
	}
	if len(audio) < 512 {
		return meetingResult{}, errors.New("meeting audio is too short to transcribe")
	}
	var body bytes.Buffer
	writer := multipart.NewWriter(&body)
	file, _ := writer.CreateFormFile("file", meetingAudioFilename(req.MimeType))
	_, _ = file.Write(audio)
	_ = writer.WriteField("model", getenv("OPENAI_MEETING_TRANSCRIPTION_MODEL", "gpt-4o-transcribe-diarize"))
	_ = writer.WriteField("response_format", "diarized_json")
	_ = writer.WriteField("chunking_strategy", "auto")
	if code := transcriptionLanguageCode(req.SourceLanguage); code != "" {
		_ = writer.WriteField("language", code)
	}
	_ = writer.Close()
	base, err := apiBase()
	if err != nil {
		return meetingResult{}, err
	}
	httpReq, _ := http.NewRequest("POST", base+"/v1/audio/transcriptions", &body)
	httpReq.Header.Set("Authorization", "Bearer "+apiKey())
	httpReq.Header.Set("OpenAI-Safety-Identifier", "co-translator-local-desktop")
	httpReq.Header.Set("Content-Type", writer.FormDataContentType())
	resp, err := s.httpClient.Do(httpReq)
	if err != nil {
		return meetingResult{}, err
	}
	defer resp.Body.Close()
	var result meetingResult
	if err := json.NewDecoder(resp.Body).Decode(&result); err != nil {
		return result, err
	}
	if resp.StatusCode >= 300 {
		return result, fmt.Errorf("could not diarize meeting audio (%d)", resp.StatusCode)
	}
	return s.translateMeetingSegments(result, req)
}

func (s *server) translateMeetingSegments(result meetingResult, req meetingRequest) (meetingResult, error) {
	if len(result.Segments) == 0 || req.SourceLanguage == req.TargetLanguage {
		return result, nil
	}
	payload := map[string]interface{}{"model": getenv("OPENAI_MEETING_TRANSLATION_MODEL", "gpt-4.1-mini"), "input": fmt.Sprintf("{\"targetLanguage\":\"%s\",\"segments\":%s}", req.TargetLanguage, mustJSON(result.Segments))}
	encoded, _ := json.Marshal(payload)
	base, err := apiBase()
	if err != nil {
		return result, err
	}
	httpReq, _ := http.NewRequest("POST", base+"/v1/responses", bytes.NewReader(encoded))
	httpReq.Header.Set("Authorization", "Bearer "+apiKey())
	httpReq.Header.Set("OpenAI-Safety-Identifier", "co-translator-local-desktop")
	httpReq.Header.Set("Content-Type", "application/json")
	resp, err := s.httpClient.Do(httpReq)
	if err != nil {
		return result, err
	}
	defer resp.Body.Close()
	var response struct {
		OutputText string `json:"output_text"`
	}
	_ = json.NewDecoder(resp.Body).Decode(&response)
	if resp.StatusCode >= 300 {
		return result, fmt.Errorf("could not translate meeting text (%d)", resp.StatusCode)
	}
	var translated struct {
		Segments []meetingSegment `json:"segments"`
	}
	if err := json.Unmarshal([]byte(response.OutputText), &translated); err != nil {
		return result, nil
	}
	for i := range result.Segments {
		if i < len(translated.Segments) && translated.Segments[i].Text != "" {
			result.Segments[i].Text = translated.Segments[i].Text
		}
	}
	result.Text = joinSegmentText(result.Segments)
	return result, nil
}

func (s *server) broadcast(event interface{}) {
	s.mu.Lock()
	clients := make([]*websocket.Conn, 0, len(s.clients))
	for c := range s.clients {
		clients = append(clients, c)
	}
	s.mu.Unlock()
	payload := eventEnvelope{Type: "event", Event: event}
	s.clientWriteMu.Lock()
	defer s.clientWriteMu.Unlock()
	for _, c := range clients {
		_ = c.SetWriteDeadline(time.Now().Add(100 * time.Millisecond))
		_ = c.WriteJSON(payload)
	}
}

func saveMeetingAudioChunk(req saveChunkRequest) error {
	if req.SessionID == "" {
		return errors.New("session id is required")
	}
	audio, err := base64.StdEncoding.DecodeString(req.Base64Audio)
	if err != nil {
		return err
	}
	if len(audio) == 0 || len(audio) > maxMeetingAudioChunkBase64Length {
		return errors.New("meeting audio chunk size is invalid")
	}
	dir := filepath.Join(userDataDir(), "meeting-audio", req.SessionID)
	if err := os.MkdirAll(dir, 0700); err != nil {
		return err
	}
	return os.WriteFile(filepath.Join(dir, fmt.Sprintf("chunk-%04d%s", req.Sequence, meetingExt(req.MimeType))), audio, 0600)
}

func userDataDir() string {
	if v := os.Getenv("CO_TRANSLATOR_USER_DATA_DIR"); v != "" {
		return v
	}
	dir, _ := os.UserConfigDir()
	return filepath.Join(dir, "co-translator")
}
func apiKeyStorePath() string { return filepath.Join(userDataDir(), apiKeyStoreFile) }
func apiKey() string {
	if key := currentRuntimeAPIKey(); key != "" {
		return key
	}
	if v := os.Getenv("OPENAI_API_KEY"); v != "" {
		key, err := validateAPIKey(v)
		if err != nil {
			return ""
		}
		return key
	}
	return readStoredAPIKey()
}
func currentRuntimeAPIKey() string {
	runtimeAPIKeyMu.Lock()
	defer runtimeAPIKeyMu.Unlock()
	return runtimeAPIKey
}
func setRuntimeAPIKey(key string) {
	runtimeAPIKeyMu.Lock()
	runtimeAPIKey = key
	runtimeAPIKeyMu.Unlock()
}
func readStoredAPIKey() string {
	data, _ := os.ReadFile(apiKeyStorePath())
	var stored struct {
		Encoding string `json:"encoding"`
		Value    string `json:"value"`
	}
	_ = json.Unmarshal(data, &stored)
	if stored.Encoding != "local" && stored.Encoding != "plaintext-v1" {
		return ""
	}
	key, err := validateAPIKey(stored.Value)
	if err != nil {
		return ""
	}
	return key
}
func validateAPIKey(value string) (string, error) {
	key := strings.TrimSpace(value)
	if key == "" {
		return "", errors.New("API key is required")
	}
	if !strings.HasPrefix(key, "sk-") || len(key) > maxAPIKeyLength {
		return "", errors.New("API key must start with sk- and fit the expected length")
	}
	return key, nil
}
func apiBase() (string, error) {
	return validatedOpenAIBaseURL("OPENAI_API_BASE_URL", "https://api.openai.com", "https")
}
func realtimeBase() (string, error) {
	return validatedOpenAIBaseURL("OPENAI_REALTIME_WS_BASE_URL", "wss://api.openai.com", "wss")
}
func validatedOpenAIBaseURL(envName, fallback, requiredScheme string) (string, error) {
	raw := strings.TrimSpace(getenv(envName, fallback))
	parsed, err := url.Parse(raw)
	if err != nil || parsed.Scheme == "" || parsed.Hostname() == "" {
		return "", fmt.Errorf("%s is not a valid URL", envName)
	}
	overrideAllowed := os.Getenv(allowOpenAIBaseURLOverrideFlag) == "1"
	developmentSchemeAllowed := overrideAllowed && ((requiredScheme == "https" && parsed.Scheme == "http") || (requiredScheme == "wss" && parsed.Scheme == "ws"))
	if parsed.Scheme != requiredScheme && !developmentSchemeAllowed {
		return "", fmt.Errorf("%s must use %s", envName, requiredScheme)
	}
	defaultURL, _ := url.Parse(fallback)
	if parsed.Hostname() != defaultURL.Hostname() && !overrideAllowed {
		return "", fmt.Errorf("%s can only target %s unless %s=1", envName, defaultURL.Hostname(), allowOpenAIBaseURLOverrideFlag)
	}
	return strings.TrimRight(parsed.String(), "/"), nil
}
func getenv(k, fallback string) string {
	if v := os.Getenv(k); v != "" {
		return v
	}
	return fallback
}
func realtimeRaceSockets() int {
	n, _ := strconv.Atoi(getenv("OPENAI_REALTIME_RACE_SOCKETS", "3"))
	if n < 1 {
		return 1
	}
	return n
}
func mustJSON(v interface{}) string { b, _ := json.Marshal(v); return string(b) }
func logLatency(event string, data map[string]interface{}) {
	data["event"] = event
	data["ts"] = time.Now().Format(time.RFC3339Nano)
	b, _ := json.Marshal(data)
	log.Printf("[latency] %s", b)
}
func openExternal(raw string) error {
	cmd := exec.Command("open", raw)
	if _, err := exec.LookPath("open"); err != nil {
		return nil
	}
	return cmd.Start()
}
func languageCode(language string) string {
	switch language {
	case "Korean":
		return "ko"
	case "Japanese":
		return "ja"
	case "Chinese":
		return "zh"
	case "Spanish":
		return "es"
	case "French":
		return "fr"
	case "German":
		return "de"
	case "Portuguese":
		return "pt"
	case "Italian":
		return "it"
	case "Vietnamese":
		return "vi"
	default:
		return "en"
	}
}
func transcriptionLanguageCode(language string) string {
	if language == "Auto" || language == "" {
		return ""
	}
	return languageCode(language)
}
func meetingAudioFilename(mime string) string { return "meeting" + meetingExt(mime) }
func meetingExt(mime string) string {
	if strings.Contains(mime, "wav") {
		return ".wav"
	}
	if strings.Contains(mime, "mpeg") || strings.Contains(mime, "mp3") {
		return ".mp3"
	}
	if strings.Contains(mime, "mp4") {
		return ".m4a"
	}
	if strings.Contains(mime, "ogg") {
		return ".ogg"
	}
	return ".webm"
}
func joinSegmentText(segments []meetingSegment) string {
	parts := []string{}
	for _, s := range segments {
		if strings.TrimSpace(s.Text) != "" {
			parts = append(parts, strings.TrimSpace(s.Text))
		}
	}
	return strings.Join(parts, "\n")
}
