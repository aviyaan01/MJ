# MJ Assistant — Personal AI Workspace (Stages 1, 2, 4 & 5 Complete)

MJ Assistant is a JARVIS-inspired personal AI assistant built in the obsidian-dark **MJ/AURA** visual identity (`#07080B` / `#0D1017` / `#121722` with cool ice-blue accents) powered by xAI's **Grok Responses API** (`POST /v1/responses`) and **Grok Speech-to-Speech Realtime API** (`wss://api.x.ai/v1/realtime`).

This repository implements **Stages 1, 2, 4, and 5** (Sections **00, 01, 02, 03, 04, 05, 07, 08, 14, 15, 16, 17**, and **Final Development Instructions**). Stage 3 features (`memoryAccess`, long-term memory, arbitrary tool calling, web search, cloud file analysis, and scheduled automation) remain **strictly OFF and deferred**.

---

## Architecture

```text
mj-assistant/
├── apps/
│   ├── web/        # React 19 + TypeScript + Vite + Tailwind CSS v4 (Home, Chat, Usage, Desktop, Privacy, Settings)
│   ├── server/     # Fastify 5 + TypeScript API proxy, SSE streaming, ephemeral secrets, privacy/budget guards, static host
│   └── desktop/    # Tauri 2 Windows companion (system tray, Win32-safe allowlisted actions, asInvoker, no shell plugin)
├── packages/
│   ├── shared/     # Shared DTOs, Zod schemas, centralized AppError & ErrorCodes, privacy defaults & cost calculators
│   ├── ai/         # xAI POST /v1/responses client, /v1/models check, /v1/realtime/client_secrets, /v1/tts, /v1/stt
│   ├── voice/      # Independent Voice Service: 9-state machine, PCM16 24kHz codec, WebSocket & Web Audio playback
│   └── ui/         # Obsidian-dark CSS tokens (WCAG AA), audio-synced MJCoreOrb, Panel, StatusPill, BrandMark
├── database/       # Drizzle ORM + built-in node:sqlite (WAL, foreign keys, versioned SQL migrations + audit logs)
├── docs/           # Delivery package: API reference, deployment guide, test report & per-stage checklists
├── tests/          # Vitest tests (AI client, voice codec/state machine, SQLite DB, Fastify integration, Stage 4 & 5 UI/API)
└── .env.example    # Environment placeholders only (no real secrets)
```

---

## Prerequisites

- **Node.js 24 LTS** (built-in `node:sqlite` is used—no C++ native compilation required)
- **npm 10+**
- **xAI API Key** from [console.x.ai](https://console.x.ai) (billing enabled)
- **Optional (for native Windows Tauri desktop builds in `apps/desktop`)**:
  - Rust toolchain (`rustup`, `rustc`, `cargo`) + MSVC C++ Build Tools + WebView2 Runtime

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
   Edit `.env` and set:
   - `XAI_API_KEY=<your-real-xai-api-key>`
   - `XAI_TEXT_MODEL=grok-4.7` (check `docs.x.ai` for current supported text models)
   - `XAI_VOICE_MODEL=grok-voice-latest` (or pin `grok-voice-3.0`)
   - `AUTH_SECRET=<random-64-char-hex-string>`
   - Optionally set `APP_ACCESS_PASSCODE=<your-passcode>` (required when `APP_ENV=production`).

3. **Run SQLite migrations** (also runs automatically on server startup):
   ```bash
   npm run db:migrate
   ```

---

## Running Locally

Start both the Fastify backend (`http://127.0.0.1:3001`) and the Vite React frontend (`http://127.0.0.1:5173`):

```bash
npm run dev
```

Open **http://127.0.0.1:5173** (or **http://localhost:5173**) in Chrome or Edge.

### Optional Windows Tauri Companion (`apps/desktop`)

After installing Rust (`rustup`), MSVC C++ Build Tools, and workspace packages:

```bash
npm run desktop:dev
npm run desktop:build
```

---

## Delivery Package Documentation

- **API Reference & Credentials**: [docs/api-integration.md](docs/api-integration.md)
- **Setup, Production & Windows Deployment Guide**: [docs/deployment-guide.md](docs/deployment-guide.md)
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
