# MJ Assistant — Production & Windows Deployment Guide

Covers local development, single-server production hosting, local-first SQLite operations, PostgreSQL multi-device considerations (Section 06), TLS/reverse-proxy configuration, and Windows Tauri companion builds.

---

## 1. Pre-Deployment Verification Checklist (Section 17 & Appendix A)

Before every release or deployment:
1. **Re-verify Gemini / optional provider model identifiers** in `.env`:
   - Configure `VOICE_MODEL` / `GEMINI_VOICE_MODEL` (e.g. `gemini-2.5-flash-native-audio-preview-12-2025` or `free-browser-voice`) for free voice, and keep `XAI_VOICE_MODEL` only if explicitly enabling paid xAI (`FREE_ONLY_MODE=false`).
2. Confirm `XAI_API_KEY` is valid with active credits/billing on [console.x.ai](https://console.x.ai).
3. Ensure `.env` stays out of version control (gitignored) and `.env.example` contains placeholders only.
4. Ensure all OS-level capability classes remain defaulted OFF cleanly across fresh installs.

---

## 2. Database Schema & Migrations (`@mj/database`)

MJ Assistant defaults to **local-first SQLite** (`node:sqlite` + Drizzle ORM with WAL mode and foreign keys enabled), so personal and Bengali/English conversation histories stay on your own machine:

| Migration ID | Tables / Changes |
|---|---|
| `0001_stage1_foundation` | `conversations`, `messages`, `usage_logs`, `app_settings` |
| `0002_stage2_voice_tracking` | `messages.channel`, `usage_logs.kind`, `usage_logs.voice_seconds` |
| `0003_stage4_privacy_desktop` | `desktop_allowlist`, `privileged_audit_logs` |

- **Run migrations explicitly**:
  ```bash
  npm run db:migrate
  ```
- **Automatic migration on boot**: Starting `@mj/server` also executes pending migrations inside `BEGIN IMMEDIATE` transactions.
- **Backup**: Back up the `.db` file (along with `-wal` / `-shm` if live, or after graceful server shutdown).
- **Hosted PostgreSQL note (Section 06)**: Only migrate storage to hosted PostgreSQL if multi-device sync is explicitly desired and disclosed in Settings; the current Stage 1/2/4/5 delivery ships SQLite local-first storage.

---

## 3. Production Self-Hosted Web + API Deployment

### 3.1 Generate Required Production Secrets
When `APP_ENV=production`, `apps/server/src/config.ts` **enforces** startup validation and refuses placeholder secrets or missing passcodes:
1. Generate a strong `AUTH_SECRET` (>= 32 chars):
   ```bash
   node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
   ```
2. Set `APP_ACCESS_PASSCODE` (>= 8 characters) in `.env`.
3. Set `XAI_API_KEY=<your-real-key>`, `APP_ENV=production`, and exact public origin(s) in `CORS_ORIGIN=https://mj.yourdomain.com`.

### 3.2 Build Artifacts
```bash
npm install
npm run typecheck
npm test
npm run build
npm run db:migrate
```
- `apps/web/dist`: Static production Vite bundle (`sourcemap: false`, split lazy route chunks).
- `apps/server/dist`: Compiled Fastify Node 24 server.

### 3.3 Single-Server Static + API Launch
With `SERVE_WEB_DIST=true` (automatic when `APP_ENV=production`), Fastify serves `apps/web/dist` for non-`/api/*` routes alongside the `/api/*` backend:
```bash
npm start
```
(`npm start` invokes `tsx src/index.ts` in `@mj/server`, resolving `@mj/*` workspace sources consistently without stale build artifacts.)
> **Important Security Requirement (HTTPS):** Place TLS termination (Caddy, Nginx, Cloudflare Tunnel, or Tailscale Serve) in front of Fastify in production. Browser microphone access (`getUserMedia`) and `Secure` session cookies require HTTPS on non-localhost origins.

### 3.4 Recommended Reverse Proxy (Caddy Example)
```caddyfile
mj.yourdomain.com {
    reverse_proxy 127.0.0.1:3001
}
```
Notice the server's Helmet CSP allows `connect-src 'self' wss://api.x.ai https://api.x.ai`, permitting browser Direct-to-xAI WebSocket realtime voice connections authenticated solely by the backend's temporary `client_secret`.

---

## 4. Windows Tauri 2 Desktop Companion (`apps/desktop`)

### Prerequisites on Windows 10/11
1. **Node.js 24 LTS** & **npm 10+**
2. **Rust toolchain (`rustup`, `rustc`, `cargo`)**: https://rustup.rs/
3. **Microsoft C++ Build Tools (MSVC)** (Desktop development with C++ workload)
4. **Microsoft Edge WebView2 Runtime** (pre-installed on Windows 10/11; NSIS/MSI bundle includes bootstrapper fallback)

### Commands
- Install desktop CLI workspace dependency (requires registry access on first setup):
  ```bash
  npm install
  ```
- Launch companion in development (while keeping `npm run dev:server` running at `127.0.0.1:3001`):
  ```bash
  npm run desktop:dev
  ```
- Build Windows installers (`nsis` / `msi` in `apps/desktop/src-tauri/target/release/bundle/`):
  ```bash
  npm run desktop:build
  ```

### Windows Security & Privilege Guarantee
- Runs strictly at standard user level (**`asInvoker`** — no UAC admin prompt).
- `@tauri-apps/plugin-shell` is omitted; arbitrary shell execution is blocked at both TypeScript and Rust layers.
- Built without compiling Rust on hosts lacking `rustc`/`cargo` (verify `cargo check` and `npm run desktop:build` on a Windows build machine with Rust + MSVC installed).
