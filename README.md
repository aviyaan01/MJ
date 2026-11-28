# MJ Assistant — Personal AI Workspace (Stages 1, 2, 4 & 5 Complete)

MJ Assistant is a JARVIS-inspired personal AI assistant built in the obsidian-dark **MJ/AURA** visual identity (`#07080B` / `#0D1017` / `#121722` with cool ice-blue accents). It routes chat and voice with **Google Gemini** (`gemini-2.5-flash` & **Gemini Live**) as the primary provider, seamless **zero-cost failover** to **Ollama (Local)** and **Groq Free Tier** (plus OpenRouter `:free`, Cerebras, Mistral, GitHub Models, and browser Web Speech API fallback), and optional paid fallback to **xAI Grok**.

This repository implements **Stages 1, 2, 4, and 5** (Sections **00, 01, 02, 03, 04, 05, 07, 08, 14, 15, 16, 17**, and **Final Development Instructions**). Stage 3 features (`memoryAccess`, long-term memory, arbitrary tool calling, web search, cloud file analysis, and scheduled automation) remain **strictly OFF and deferred**.

---

## Architecture

```text
mj-assistant/
├── apps/
│   ├── web/        # React 19 + TypeScript + Vite (route splitting + manualChunks) + Tailwind CSS v4
│   ├── server/     # Fastify 5 + TypeScript API proxy, SSE streaming, Gemini Live / failover routing, alerting watchdog, static host
│   └── desktop/    # Tauri 2 Windows companion (system tray, Win32-safe allowlisted actions, asInvoker, no shell plugin)
├── packages/
│   ├── shared/     # Shared DTOs, Zod schemas, centralized AppError & ErrorCodes, provider display catalog, cost calculators
│   ├── ai/         # Multi-provider router & SSE parser (Gemini, Ollama, Groq, OpenRouter, Cerebras, Mistral, GitHub, xAI)
│   ├── voice/      # Independent Voice Service: 9-state machine, PCM16 24kHz codec, Gemini Live / WebSocket / Web Audio playback
│   └── ui/         # Obsidian-dark CSS tokens (WCAG AA), audio-synced MJCoreOrb, Panel, StatusPill, BrandMark
├── database/       # Drizzle ORM + built-in node:sqlite (WAL, foreign keys, versioned SQL migrations + alert/audit tables)
├── docs/           # Delivery package: API reference, deployment guide, test report & per-stage checklists
├── tests/          # Vitest tests (provider routing, voice, SQLite DB, Fastify integration, alerting, backup/restore, UI)
├── RESTORE.md      # Encrypted SQLite daily backup (.mjbak AES-256-GCM) & step-by-step restore instructions
└── .env.example    # Environment placeholders only (no real secrets)
```

---

## Prerequisites

- **Node.js 24 LTS** (built-in `node:sqlite` is used—no C++ native compilation required)
- **npm 10+**
- **Primary AI & Voice Provider (Free Tier)**: **Google Gemini API Key** from [aistudio.google.com/apikey](https://aistudio.google.com/apikey) (`GEMINI_API_KEY`)
- **Recommended Zero-Cost Fallbacks**:
  - **Ollama** running locally on `http://127.0.0.1:11434` (`ollama pull qwen2.5:7b`) — works 100% offline with no API key (including when `externalWebServices` privacy toggle is OFF)
  - **Groq API Key** from [console.groq.com](https://console.groq.com) (`GROQ_API_KEY`) for fast free chat fallback and **Groq Whisper STT** (`whisper-large-v3-turbo`)
- **Optional**:
  - **xAI API Key** from [console.x.ai](https://console.x.ai) if you also want paid Grok fallback
  - **Native Windows Tauri desktop builds (`apps/desktop`)**: Rust toolchain (`rustup`, `rustc`, `cargo`) + MSVC C++ Build Tools + WebView2 Runtime

---

## Local Setup

1. **Install dependencies** from the project root:
   ```bash
   npm install
   ```

2. **Create `.env` from `.env.example`**:
   ```bash
   cp .env.example .env
   ```
   Edit `.env` and configure:
   - **Primary Provider & Strict Free-Only Mode**:
     - `FREE_ONLY_MODE=true` (enabled by default: guarantees zero paid API calls — blocks xAI, OpenRouter, and paid tiers even during failover; set `FREE_ONLY_MODE=false` only if you intentionally enable paid billing)
     - `AI_PROVIDER=auto` (active free chain: **Google Gemini Free Tier** (`gemini-2.5-flash` / `gemini-2.5-flash-lite`) -> **Ollama (Local)** (`qwen2.5:7b`) -> **Groq Free Tier** (`llama-3.3-70b-versatile`))
     - `GEMINI_API_KEY=<your-google-ai-studio-key>`
     - `GEMINI_MODEL=gemini-2.5-flash` (or `gemini-2.5-flash-lite` / `gemini-2.5-pro`)
   - **Zero-Cost Fallbacks (Ollama / Groq)**:
     - `OLLAMA_ENABLED=true`, `OLLAMA_BASE_URL=http://127.0.0.1:11434/v1`, `OLLAMA_MODEL=qwen2.5:7b`
     - `GROQ_API_KEY=<your-groq-free-key>`, `GROQ_MODEL=llama-3.3-70b-versatile`
   - **Security & Database**:
     - `AUTH_SECRET=<random-64-char-hex-string>`
     - `DATABASE_URL=./data/mj-assistant.db` (single root-resolved SQLite DB shared by `@mj/server` and `@mj/database`)
     - Optionally set `APP_ACCESS_PASSCODE=<your-passcode>` (required when `APP_ENV=production`).

3. **Run SQLite migrations** (also runs automatically on server startup):
   ```bash
   npm run db:migrate
   ```

---

## Running Locally

Start both the Fastify backend (`http://127.0.0.1:3001`) and the Vite React frontend (`http://localhost:5173`):

```bash
npm run dev
```

Open **http://localhost:5173** (or **http://127.0.0.1:5173**) in Chrome or Edge.
- Use the **Provider & Model Switcher** in the **Chat** header (`Auto`, `Gemini`, `Ollama`, `Groq`) or switch defaults under **Settings > AI Model & API**.
- Voice sessions connect via server-managed **Google Gemini Live** and automatically fall back to **Free Browser Voice** (`Web Speech API`) + **Groq Whisper STT** at `$0.00` cost if Gemini Live is unavailable.

### Optional Windows Tauri Companion (`apps/desktop`)

After installing Rust (`rustup`), MSVC C++ Build Tools, and workspace packages:

```bash
npm run desktop:dev
npm run desktop:build
```

---

## Alerting & Budget Guardrails

MJ Assistant monitors uptime, unhandled errors, elevated upstream error rates, and daily/monthly spending:

- **Background Health Watchdog**: An internal server timer checks database health every **60 seconds** so `uptime_down` alerts fire automatically even if `/health` is not being polled externally.
- **Persistent Error Window & Cooldown**: Rolling request/error counts and alert cooldown timestamps persist in SQLite (`alert_state`) across server restarts, while expected auto-failover upstream errors do not trigger false `high_error_rate` alerts.
- **Notification Channels** (configure in `.env`; placeholder values are ignored, secrets redacted in logs):
  - **Telegram**: `ALERT_TELEGRAM_BOT_TOKEN` + `ALERT_TELEGRAM_CHAT_ID`
  - **Email (Resend API or SMTP)**: `ALERT_RESEND_API_KEY` or `ALERT_SMTP_HOST` / `ALERT_SMTP_PORT` / `ALERT_SMTP_USER` / `ALERT_SMTP_PASS` with `ALERT_EMAIL_FROM` + `ALERT_EMAIL_TO`
  - **Thresholds**: `ALERT_ERROR_RATE_PCT` (default `25`), `ALERT_MIN_REQUESTS` (default `5`), `ALERT_WINDOW_MINUTES` (default `15`), `ALERT_COOLDOWN_MINUTES` (default `15`)
- **Free vs Paid Budget Caps**: Configure `dailyCapUsd`, `softCapUsd`, `hardCapUsd`, and `sttRatePerHourUsd` in **Settings > Usage & Budget** or **Usage**. Free providers (`gemini` free tier, `ollama`, `groq`, `:free` routes, `free-browser-voice`) log `$0.00` and are never blocked by paid caps.

---

## Encrypted Backup & Restore (`RESTORE.md`)

All conversations, runtime settings, privacy rules, allowlists, audit logs, and usage telemetry live in local SQLite (`./data/mj-assistant.db`). `@mj/server` runs `DailyBackupScheduler` (`BACKUP_ENABLED=true`) to write `AES-256-GCM` encrypted `*.mjbak` archives under `BACKUP_DIR=./data/backups`.

Set a dedicated `BACKUP_ENCRYPTION_KEY` (>= 16 characters, separate from `AUTH_SECRET` — `AUTH_SECRET` fallback is disabled) and manage backups from the project root:

```bash
# Create an immediate encrypted .mjbak backup
npm run db:backup

# Stop the running server first, then restore & verify checksum + SQLite integrity
npm run db:restore -- --file ./data/backups/<backup-file>.mjbak
```

See **[RESTORE.md](RESTORE.md)** for full key management, Docker restore commands, rollback of `.pre-restore-*.db`, and troubleshooting.

---

## Delivery Package Documentation

- **API Reference & Credentials**: [docs/api-integration.md](docs/api-integration.md)
- **Setup, Production & Windows Deployment Guide**: [docs/deployment-guide.md](docs/deployment-guide.md)
- **Backup & Recovery Guide**: [RESTORE.md](RESTORE.md)
- **Section 17 Test Matrix & Verification Report**: [docs/testing-checklist-and-report.md](docs/testing-checklist-and-report.md)
- **Stage Guides**:
  - [Stage 1 — Text Chat & Error Handling](docs/stage-1-api-and-testing.md)
  - [Stage 2 — Realtime Voice & Ephemeral Secrets](docs/stage-2-voice-and-testing.md)
  - [Stage 4 — Windows Companion & Privacy Hardening](docs/stage-4-desktop-and-privacy.md)

## Testing & Verification

```bash
npm run typecheck
npm test
npm run build
npm run db:migrate
npm run audit:deps
```
