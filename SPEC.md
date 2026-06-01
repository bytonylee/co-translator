# Adversarial Bridge Hardening SPEC

## Summary

This spec tracks the follow-up remediation for adversarial bridge review findings discovered after the initial security implementation:

- `Origin: null` was still accepted by both bridge backends.
- `npm run dev` used a public fixed bridge token.
- Renderer connection errors could expose the tokenized WebSocket URL.
- Smoke coverage only checked missing-token rejection, not origin-policy bypasses.

The intended security posture is: a browser page must need both a valid per-run bridge token and an explicitly allowed origin before it can invoke privileged bridge commands. Non-browser local tooling may connect without an `Origin` header only when it has the token.

## File Checklist

| File | Issue | Solution | Checklist |
| --- | --- | --- | --- |
| `src/backend/server.ts` | Node/Bun bridge allowed `Origin: null`, enabling sandboxed/data/file-origin bypasses when token is known. | Remove `null` from the allowed-origin set while keeping packaged app origins, dev localhost origins, and no-origin local clients. | [x] `null` removed [x] Missing origin still allowed for tokened local clients [x] Smoke proves `null` rejected |
| `router-go/cmd/backend/main.go` | Go bridge had the same `Origin: null` bypass as Node/Bun. | Remove `null` from the Go `CheckOrigin` allowlist and keep parity with Node/Bun. | [x] `null` removed [x] Origin policy matches Node/Bun [x] Go build/test rerun |
| `package.json` | `npm run dev` used committed public token `dev-local-bridge-token`, making dev bridge auth predictable. | Generate a random token at dev-script runtime and pass it through the parent environment to both the external backend and Zero Native dev shell. | [x] Fixed token removed [x] Runtime random token generated [x] `package.json` syntax validated |
| `src/renderer/src/nativeBridge.ts` | Connection error included the full `ws://.../bridge?token=...` URL. | Keep using the tokenized URL internally, but report only the tokenless bridge base URL in errors. | [x] Token omitted from error text [x] Typecheck rerun |
| `scripts/backend-integration-smoke.mjs` | Smoke test only verified missing-token rejection and missed the `Origin: null` bypass. | Add reusable bridge probe helpers and assert rejection for missing token, wrong token, disallowed remote origin, and `Origin: null`; assert acceptance for allowed dev origin and no-origin local client. | [x] Missing token rejected [x] Wrong token rejected [x] Remote origin rejected [x] Null origin rejected [x] Allowed/no-origin accepted [x] Smoke rerun |
| `scripts/benchmark-shells.mjs` | Benchmark uses a fixed token, but only inside a local benchmark process that does not load real user keys. | Leave fixed benchmark token as test-only; no production/dev user credential boundary depends on it. | [x] Reviewed as test-only |
| `SPEC.md` | Previous spec marked the bridge issue closed while adversarial bypasses remained. | Replace spec with this follow-up checklist and mark validation only after rerunning checks. | [x] Rewritten [x] Validation checklist updated after checks |

## Acceptance Checks

- [x] `node -e "JSON.parse(require('fs').readFileSync('package.json','utf8'))"`
- [x] `npm run typecheck`
- [x] `cd router-go && go test ./...`
- [x] `zig build`
- [x] `npm run build:backend`
- [x] `node scripts/backend-integration-smoke.mjs`

## Residual Risk

- The bridge token still travels in the WebSocket query string internally. User-visible errors no longer include it, but a future stronger design should move authentication to `Sec-WebSocket-Protocol` or an initial auth message.
- Fixed tokens remain in smoke/benchmark scripts only. They must not be used in normal development or production flows that may load a real user API key.
- API keys remain plaintext on disk by product decision from the previous remediation.
