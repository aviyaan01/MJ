# MJ Assistant — API Integration Reference (xAI & Backend REST/SSE)

This document details all external xAI API integrations and internal backend routes implemented across Stages 1, 2, 4, and 5.

> **Pre-deployment reminder (Section 03 & Appendix A):** Re-verify current supported text/voice model identifiers and per-unit pricing at [docs.x.ai](https://docs.x.ai) and [console.x.ai](https://console.x.ai) before each deployment. `grok-voice-latest` is a moving alias.

---

## 1. Required External Credentials

| Variable | Required | Where Stored | Purpose |
|---|---|---|---|
| `XAI_API_KEY` | Yes (AI features) | Server `.env` only (never bundled/sent to browser) | Authorizes requests to `api.x.ai/v1` |
| `AUTH_SECRET` | Yes in production | Server `.env` only | Signs `HttpOnly` `mj_session` cookies (HMAC-SHA256, >= 32 chars) |
| `APP_ACCESS_PASSCODE` | Yes in production | Server `.env` only | Gates Unlock screen when set (>= 8 chars in production) |

---

## 2. xAI Upstream Endpoints (`packages/ai`)

1. **Text Intelligence (`POST /v1/responses`)** — [xaiClient.ts](file:///C:/Users/ASUS/Desktop/MJ/packages/ai/src/xaiClient.ts)
   - Server-only `Authorization: Bearer ${XAI_API_KEY}`.
   - Sends `model`, `instructions` (`buildMjSystemPrompt`), `input` (SQLite turn context), `reasoning: { effort }`, `max_output_tokens`, `stream`, and `store: false`.
   - Transient failures (`429`, `5xx`, network/timeout) retry up to 2 times using exponential backoff with jitter before first delta emission.
2. **Model Availability Check (`GET /v1/models`)** — `XaiResponsesClient.listAvailableModelIds()`
   - Read-only metadata check triggered explicitly from **Usage & System Monitor -> Verify Live xAI Model**.
3. **Ephemeral Browser Voice Secrets (`POST /v1/realtime/client_secrets`)** — [voiceApi.ts](file:///C:/Users/ASUS/Desktop/MJ/packages/ai/src/voiceApi.ts)
   - Server exchanges `XAI_API_KEY` for a short-lived client secret (`expires_after.seconds = 300`).
4. **Realtime Speech-to-Speech (`wss://api.x.ai/v1/realtime?model=...`)** — [voiceService.ts](file:///C:/Users/ASUS/Desktop/MJ/packages/voice/src/voiceService.ts)
   - Browser WebSocket authenticates strictly via subprotocol `xai-client-secret.<ephemeralToken>`.
   - Streams PCM16 24 kHz audio both ways with `server_vad` automatic turn detection, instant barge-in interruption, and automatic Bengali/English/Banglish detection.
5. **Fallback TTS & Voices (`POST /v1/tts`, `GET /v1/tts/voices`)** and **STT (`POST /v1/stt`)** — proxied server-side.

---

## 3. Fastify Backend Routes (`apps/server`)

| Method | Path | Auth | Purpose |
|---|---|---|---|
| `GET` | `/api/health` | Public | Backend, SQLite health, API key configured boolean, active models, uptime |
| `GET` | `/api/auth/session` | Public | Current `HttpOnly` session authentication state |
| `POST` | `/api/auth/login` | Public (rate-limited) | Validates passcode and sets `mj_session` `HttpOnly` cookie |
| `POST` | `/api/auth/logout` | Public | Clears session cookie |
| `GET` / `POST` | `/api/conversations` | Session | List/search (`?q=`) or create shared conversation |
| `GET` / `PATCH` / `DELETE` | `/api/conversations/:id` | Session | Get detail, rename, or delete conversation |
| `POST` | `/api/conversations/:id/messages` | Session | Stream Grok `/v1/responses` SSE reply (`externalWebServices` + hard budget gated) |
| `POST` | `/api/conversations/:id/regenerate` | Session | Regenerate last assistant message via SSE |
| `POST` | `/api/conversations/:id/voice-turns` | Session | Persist spoken user/assistant transcript turn into unified SQLite history |
| `POST` | `/api/voice/client-secret` | Session (rate-limited) | Issue ephemeral token (`microphoneAccess` + `voiceSessionAccess` + `externalWebServices` + hard budget gated) |
| `GET` | `/api/voice/voices` | Session | List available xAI TTS voices (cached 5 minutes) |
| `POST` | `/api/voice/tts` | Session | Proxy speech synthesis & record TTS usage/errors |
| `POST` | `/api/voice/stt` | Session | Proxy speech-to-text & record STT usage/cost/errors |
| `POST` | `/api/voice/usage` | Session | Record completed realtime voice session duration & estimated cost |
| `GET` / `PATCH` | `/api/settings` | Session | Read or update model, reasoning, UI, voice & budget settings |
| `GET` | `/api/usage` | Session | Today & month totals, channel breakdown (`byKind`), spend-vs-budget status, recent events |
| `POST` | `/api/usage/connectivity` | Session (rate-limited) | Verify live upstream `/v1/models` and `/v1/tts/voices` reachability |
| `GET` / `PATCH` | `/api/privacy/permissions` | Session | Read or toggle ONE single permission key (`UpdateSinglePermissionSchema.strict()`) |
| `POST` | `/api/privacy/revoke-desktop` | Session | Emergency reset of all 8 OS capabilities to `false` |
| `GET` / `POST` | `/api/privacy/audit-log` | Session | Read/append privileged-action audit log entries |
| `GET` / `POST` / `DELETE` | `/api/privacy/allowlist` | Session | Manage app/folder/domain allowlists with shell & protected-path enforcement |
| `GET` | `/api/privacy/export` | Session | Export personal conversations, settings, allowlist & audit logs (secrets excluded) |
| `DELETE` | `/api/privacy/conversations` | Session | Clear saved conversations without erasing privileged audit logs |
| `GET` | `/api/desktop/system-status` | Session | Read local host telemetry (gated by `systemMonitoring`) |
| `POST` | `/api/desktop/validate-action` | Session | Validate capability flag, shell blocklist, allowlists & `fileWrite` confirmation |
