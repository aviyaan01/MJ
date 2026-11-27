# MJ Assistant — Stage 2 (Web Text + Realtime Voice)

MJ Assistant is a JARVIS-inspired personal AI assistant built in the obsidian-dark **MJ/AURA** visual identity (`#07080B` / `#0D1017` / `#121722` with cool ice-blue accents) and powered by xAI's **Grok Responses API** (`POST /v1/responses`) and **Grok Speech-to-Speech Realtime API** (`wss://api.x.ai/v1/realtime`).

This repository implements **Stage 1 & Stage 2** (Sections **00, 01, 02, 03, 04, 05, 07, 08**, and **Phases 1–2 of Section 17**). Long-term memory, tools/function calling, web search, file analysis, personal automation, and Windows Tauri desktop features remain deferred to Stages 3–4.

---

## Architecture

```text
mj-assistant/
├── apps/
│   ├── web/        # React 19 + TypeScript + Vite + Tailwind CSS v4 (AURA Obsidian Dashboard, Voice & Chat)
│   └── server/     # Fastify 5 + TypeScript API proxy, SSE text streaming, ephemeral voice secrets, TTS/STT proxy
├── packages/
│   ├── shared/     # Shared DTOs, Zod schemas, centralized AppError & ErrorCodes, cost estimator
│   ├── ai/         # xAI POST /v1/responses client, /v1/realtime/client_secrets, /v1/tts, /v1/stt, MJ prompts
│   ├── voice/      # Independent Voice Service: 9-state machine, PCM16 24kHz codec, WebSocket & Web Audio playback
│   └── ui/         # Obsidian-dark CSS tokens (WCAG AA), audio-synced MJCoreOrb, Panel, StatusPill, BrandMark
├── database/       # Drizzle ORM + built-in node:sqlite (WAL, foreign keys, versioned SQL migrations)
├── docs/           # Stage 1 & Stage 2 API integration and verification guides
├── tests/          # Vitest unit, voice, database & Fastify integration tests
└── .env.example    # Environment placeholders only (no real secrets)
```

---

## Prerequisites

- **Node.js 24 LTS** (built-in `node:sqlite` is used—no C++ native compilation required)
- **npm 10+**
- **xAI API Key** from [console.x.ai](https://console.x.ai) (billing enabled)

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

---

## Testing & Verification

```bash
npm run typecheck
npm test
npm run build
```

See [docs/stage-1-api-and-testing.md](docs/stage-1-api-and-testing.md) and [docs/stage-2-voice-and-testing.md](docs/stage-2-voice-and-testing.md) for detailed API specs and end-to-end testing checklists.
