[English](./README.md) | [한국어](./README.ko.md)
![Version](https://img.shields.io/badge/version-0.0.1-333333?style=flat-square) [![License: Apache 2.0](https://img.shields.io/badge/License-Apache%202.0-yellow.svg)](./LICENSE)

# Co Translator

macOS와 Windows용 네이티브 실시간 번역 데스크톱 앱입니다. Electron, React, TypeScript, OpenAI Realtime translation을 사용합니다. 마이크와 화면은 렌더러가 처리하고, OpenAI API 키는 Electron 메인 프로세스에만 보관합니다.

> [!WARNING]
> Windows OS는 아직 메인테이너가 테스트하지 않았습니다. Windows에서 직접 확인해 주시고, Windows 빌드가 잘 동작하도록 수정 사항이나 확인 내용을 기여해 주세요.

## 터미널에서 설치하기

필요한 것:

- Node.js 20 이상
- npm
- Realtime API를 사용할 수 있는 OpenAI API 키

터미널에서 아래 명령어를 실행하세요.

```bash
cd /Users/tonylee/solo/co-translator
npm install
cp .env.example .env
cp .env.example .env.local
npm run dev
```

로컬 앱 패키지 버전을 확인하려면:

```bash
npm run version
npm run version:check
```

Bun에서도 같은 명령을 사용할 수 있습니다.

```bash
bun run version
bun run version:check
```

앱이 열리면 오른쪽 위의 키 버튼을 누르고 OpenAI API 키를 붙여 넣으세요. 키는 이 기기에만 저장됩니다. 또는 `.env`와 `.env.local`에 직접 넣을 수 있습니다.

```bash
OPENAI_API_KEY=sk-your-api-key
OPENAI_REALTIME_MODEL=gpt-realtime-translate
OPENAI_REALTIME_TRANSCRIPTION_MODEL=gpt-realtime-whisper
OPENAI_REALTIME_RACE_SOCKETS=3
OPENAI_WARM_IDLE_TIMEOUT_MS=45000
```

`.env`와 `.env.local`은 Git에 포함되지 않습니다.

## AI 터미널 에이전트에게 줄 프롬프트

AI 코딩 에이전트나 터미널 에이전트에 아래 문장을 붙여 넣어도 됩니다.

```text
/Users/tonylee/solo/co-translator에서 Co Translator를 설치하고 실행해 주세요.
다음 명령을 실행하세요.
1. npm install
2. .env가 없으면 cp .env.example .env
3. .env.local이 없으면 cp .env.example .env.local
4. npm run dev
내 OpenAI API 키를 출력하거나 노출하지 마세요. 앱에서 키가 필요하면 인앱 API 키 창에 직접 붙여 넣으라고 안내하세요.
```

## 사용 방법

1. `npm run dev`로 앱을 실행합니다.
2. macOS 또는 Windows가 마이크 권한을 요청하면 허용합니다.
3. 설정 버튼에서 마이크, 지연 시간 모드, 사용자 음성 받아쓰기 여부를 고릅니다.
4. 원본 언어를 고르거나 `Auto`로 둡니다.
5. 번역 대상 언어를 고릅니다.
6. `Play`를 누르고 말하면 User text와 Target text 영역이 업데이트됩니다.
7. 끝나면 `Stop`을 누릅니다.

지연 시간 모드:

- `Fastest`: 10 ms PCM 청크를 사용하는 예열된 WebSocket 번역입니다. 기본값으로 번역 소켓 3개를 경주 방식으로 사용해 꼬리 지연 시간을 낮춥니다.
- `WebRTC`: 브라우저 미디어 전송 비교용 WebRTC 번역 호출입니다.
- `Balanced`: 20 ms 오디오 청크와 로컬 음성 활동 감지를 사용합니다.
- `Stable network`: 40 ms 오디오 청크와 더 큰 소켓 버퍼를 사용해 불안정한 네트워크에 맞춥니다.

## 기록 사용 방법

이 앱은 오디오 파일이 아니라 텍스트 기록을 만듭니다.

- `User text`는 `Transcribe user voice`가 켜져 있을 때 마이크 음성을 받아쓴 원문입니다.
- `Target text`는 번역된 텍스트입니다.
- 세션 중이나 세션 후에 두 텍스트 영역을 직접 수정할 수 있습니다.
- 각 영역 위의 다운로드 버튼을 누르면 Markdown 파일로 기록을 내보냅니다.
- 개발용 지연 시간 기록은 `logs/latency.ndjson`에 저장됩니다.

앱 실행 중 지연 시간 기록을 보려면:

```bash
tail -f logs/latency.ndjson
```

## API 가격 알림

앱은 텍스트 영역 위에 API 가격 알림을 보여줍니다. 가격은 바뀔 수 있으므로 공식 OpenAI 가격 페이지에서 최신 정보를 확인하세요: https://openai.com/api/pricing/

2026년 5월 11일 기준 관련 가격은 다음과 같습니다.

- `gpt-realtime-translate`: 분당 `$0.034`, 초당 `$0.00057`
- `gpt-realtime-whisper`: 분당 `$0.017`, 초당 `$0.00028`
- `gpt-4o-transcribe-diarize`: 분당 `$0.006`, 초당 `$0.00010`

앱의 예상 비용 계산은 다음과 같습니다.

```text
번역 비용 + 받아쓰기 비용 + 화자 분리 비용
```

누적 합계는 WebSocket 모드에서는 실제로 스트리밍한 realtime 오디오 길이를, WebRTC 모드에서는 연결된 미디어 시간을 표시합니다. 사용자가 Play, Stop, 다시 Play를 반복하면 각 구간을 이전 구간에 더합니다. Translate와 Whisper가 함께 실행될 때 표시되는 시간은 같은 realtime 길이를 사용합니다. 번역 비용은 해당 구간의 번역 세션 수만큼 곱하고, Whisper 비용은 사용자 음성 받아쓰기가 켜진 동안 더하며, 회의 화자 분리 비용은 화자 분리 API로 전송한 녹음된 회의 오디오 길이를 더합니다.

기본 `Fastest` 모드에서는 `OPENAI_REALTIME_RACE_SOCKETS` 값만큼 번역 비용이 곱해집니다. 기본값은 `3`입니다. 따라서 사용자 음성 받아쓰기가 켜진 `Fastest` 모드는 대략 다음과 같습니다.

```text
($0.034 x 3) + $0.017 = 세션이 열린 동안 분당 $0.119
```

Fastest 모드 번역 비용을 줄이려면 `.env`와 `.env.local`에 아래 값을 설정하세요.

```bash
OPENAI_REALTIME_RACE_SOCKETS=1
```

## 네이티브 설치 파일 만들기

```bash
npm run dist:mac
npm run dist:win
```

macOS에서 Windows 설치 파일을 크로스 빌드하려면 Wine이 필요할 수 있습니다. 각 OS에서 직접 빌드하는 방식이 가장 안정적입니다.

## 참고

- 번역에는 `/v1/realtime/translations`를 사용합니다.
- 선택적 User text 영역은 별도의 Realtime transcription 세션을 사용합니다.
- 렌더러는 `OPENAI_API_KEY`를 받지 않습니다.
- 앱은 더 이상 번역 음성을 재생하지 않습니다. 제품 UI의 목표는 번역 텍스트 지연 시간입니다.

## 라이선스

Apache License 2.0입니다. 자세한 내용은 [LICENSE](./LICENSE)를 참고하세요.
