# Remote Main vs Present Benchmark

Measured on 2026-06-01 KST.

Remote main revision: `dba1eea1885c24b8989ed28d3788ae7e46dce59a`

## Memory

| Version | Mode | RSS |
| --- | --- | ---: |
| Remote main, Electron process tree | idle app | 371.42 MB |
| Present, Zero Native process tree | active backend | 102.38 MB |
| Present, Zero Native + attributed WebKit XPC | active backend | 178.36 MB |
| Present, Zero Native process tree | idle, no persistent backend | 90.84 MB |
| Present, Zero Native + attributed WebKit XPC | idle, no persistent backend | 167.06 MB |

Present active RSS including WebKit XPC is 193.06 MB lower than remote main, a 52.0% reduction.
Present idle RSS including WebKit XPC is 204.36 MB lower than remote main, a 55.0% reduction.

## Latency

| Metric | Remote main | Present | Difference |
| --- | ---: | ---: | ---: |
| Start click to rendered target text | 122.1 ms | 68.4 ms | 53.7 ms faster |
| Voice start to rendered target text | 32.4 ms | 64.1 ms | 31.7 ms slower |
| IPC / bridge p50 | 0.0000 ms | 0.0448 ms | Electron p50 is timer-quantized |
| IPC / bridge p95 | 0.1000 ms | 0.0730 ms | 0.0270 ms faster |

The start-to-text harness used the same mock voice and mock stream output path for both versions.
The bridge comparison uses Electron IPC on remote main and the present local WebSocket bridge through the Go backend.

## Backend Runtime Comparison

| Backend | Startup | RSS |
| --- | ---: | ---: |
| Go | 29.3 ms | 11.25 MB |
| Bun TypeScript bundle | 114.3 ms | 34.19 MB |
| Node TypeScript build | 112.9 ms | 58.22 MB |

## Commands

- Remote memory: spawned `/tmp/co-translator-origin-main-bench/node_modules/.bin/electron .` after `npm ci && npm run build`, then sampled process-tree RSS after 5 seconds.
- Remote IPC: `BENCH_ITERATIONS=1000 /tmp/co-translator-origin-main-bench/node_modules/.bin/electron /Users/tonylee/solo/co-translator/scripts/electron-ipc-bench.cjs`
- Remote start-to-text: `LATENCY_UI_URL=http://127.0.0.1:5174 ... node scripts/start-to-stream-latency.mjs`
- Present shell benchmark: `BENCH_ITERATIONS=1000 npm run benchmark:shells`
- Present start-to-text: `LATENCY_MOCK_VOICE_DELAY_MS=0 LATENCY_MOCK_STREAM_DELAY_MS=0 LATENCY_START_TO_TEXT_TARGET_MS=70 LATENCY_VOICE_TO_TEXT_TARGET_MS=70 npm run latency:start-to-text`
- Backend comparison: `npm run benchmark:backends`
