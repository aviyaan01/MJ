# MJ Assistant — Production Deployment Guide (Split Backend & Frontend)

Deploy **Backend (`@mj/server`)** and **Frontend (`@mj/web`)** independently while keeping **`XAI_API_KEY`**, authentication secrets, SQLite data, and ephemeral voice token minting strictly on the backend.

---

## Architecture & Security Guarantee

```text
Browser (https://app.yourdomain.com — Static SPA from Dockerfile.frontend / CDN)
  │
  ├── HTTPS REST / SSE (with HttpOnly mj_session cookie)
  │     └──► Backend API (https://api.yourdomain.com — Dockerfile.backend / Node 24)
  │            ├── Stores XAI_API_KEY, AUTH_SECRET, APP_ACCESS_PASSCODE (never sent to browser)
  │            ├── Streams Grok Responses (/api/conversations/:id/messages -> POST /v1/responses)
  │            ├── Mints short-lived Realtime Voice tokens (/api/voice/client-secret -> POST /v1/realtime/client_secrets)
  │            └── Persists SQLite data (/app/data/mj-assistant.db)
  │
  └── Direct WSS (wss://api.x.ai/v1/realtime) authenticated ONLY with backend-issued ephemeral client_secret
```

- **Zero API keys in frontend**: Only public `VITE_API_BASE_URL` is embedded in the frontend build (`Dockerfile.frontend` runs a post-build grep guard on `dist/assets/*.js`).
- **Health endpoint**: `GET /health` (also mirrored at `GET /api/health`) pings SQLite and returns `200 OK` (`{ "status": "online", "database": "healthy", ... }`) or `503 Service Unavailable` (`status: "degraded"`) without exposing secrets.

---

## Step 1: Pre-Deploy Checks (Required)

1. **Verify current xAI model IDs & pricing** on [docs.x.ai](https://docs.x.ai) and [console.x.ai](https://console.x.ai) (especially `XAI_VOICE_MODEL` if overriding `grok-voice-latest`).
2. **Generate production secrets** locally before configuring the backend host:
   ```bash
   node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"
   ```
   Save this as `AUTH_SECRET` (>= 32 characters) and choose a strong `APP_ACCESS_PASSCODE` (>= 8 characters). In `APP_ENV=production`, `@mj/server` rejects startup if either secret is missing or looks like a placeholder.
3. **Run local build & tests first**:
   ```bash
   npm ci
   npm run typecheck
   npm test
   npm run build
   ```

---

## Step 2: Deploy Backend Separately (`Dockerfile.backend` or Node 24 Host)

### Option 2A: Docker Container (Render / Fly.io / VPS / ECS)

1. Copy the template to `apps/server/.env.production` (gitignored) and fill in real secrets/domains from [apps/server/.env.production.example](apps/server/.env.production.example):
   ```bash
   cp apps/server/.env.production.example apps/server/.env.production
   ```
   Required values inside `apps/server/.env.production`:
   - `APP_ENV=production`
   - `HOST=0.0.0.0`
   - `PORT=3001`
   - `SERVE_WEB_DIST=false` (backend stays API-only)
   - `CORS_ORIGIN=https://app.yourdomain.com` (exact frontend HTTPS origin, no trailing slash)
   - `COOKIE_SAME_SITE=none` (`COOKIE_DOMAIN=.yourdomain.com` if sharing a root domain)
   - `DATABASE_URL=/app/data/mj-assistant.db`
   - `AUTH_SECRET=<generated-96-char-hex>`
   - `APP_ACCESS_PASSCODE=<strong-passcode>`
   - `XAI_API_KEY=<your-real-xai-api-key>`
2. Build and run the backend image with a persistent volume mounted at `/app/data`:
   ```bash
   docker build -f Dockerfile.backend -t mj-backend:prod .

   docker run -d \
     --name mj-backend \
     --restart unless-stopped \
     --env-file ./apps/server/.env.production \
     -v mj_sqlite_data:/app/data \
     -p 127.0.0.1:3001:3001 \
     mj-backend:prod
   ```
   On startup, [Dockerfile.backend](Dockerfile.backend) executes `npm run db:migrate && npm start` (running Drizzle SQLite migrations cleanly via Node 24 built-in `node:sqlite`) and exposes a container `HEALTHCHECK` on `/health`.

### Option 2B: Managed Node 24 Host (No Docker)

1. Deploy repository root on Node.js 24 LTS.
2. Set the same environment variables in your host dashboard (do NOT commit `.env` files).
3. Configure:
   - **Install command**: `npm ci --ignore-scripts`
   - **Pre-start / release command**: `npm run db:migrate`
   - **Start command**: `npm start`
   - **Health Check Path**: `/health`
4. Attach a persistent disk for `DATABASE_URL` (for example `/var/data/mj-assistant.db`).

### Verify Backend Health

```bash
curl -sS https://api.yourdomain.com/health
```
Confirm HTTP `200` and `"database": "healthy"`.

---

## Step 3: Deploy Frontend Separately (`Dockerfile.frontend` or Static Host / CDN)

Configure the public backend origin using [apps/web/.env.production.example](apps/web/.env.production.example):
- `VITE_API_BASE_URL=https://api.yourdomain.com` (NO trailing slash, and NEVER add `XAI_API_KEY`, `AUTH_SECRET`, or `APP_ACCESS_PASSCODE`).

### Option 3A: Docker + Nginx Container

1. Build and start the frontend image, passing only `VITE_API_BASE_URL` at build time:
   ```bash
   docker build \
     -f Dockerfile.frontend \
     --build-arg VITE_API_BASE_URL=https://api.yourdomain.com \
     -t mj-frontend:prod .

   docker run -d \
     --name mj-frontend \
     --restart unless-stopped \
     -p 127.0.0.1:8080:80 \
     mj-frontend:prod
   ```
   Nginx inside [Dockerfile.frontend](Dockerfile.frontend) serves the Vite SPA via [deploy/nginx.frontend.conf](deploy/nginx.frontend.conf) with `/healthz` health checks, `Permissions-Policy: microphone=(self)`, and SPA fallback routing.

### Option 3B: Vercel / Cloudflare Pages / Netlify (Static CDN)

1. Connect the repository with:
   - **Install Command**: `npm ci --ignore-scripts`
   - **Build Command**: `npm run build --workspace=@mj/web`
   - **Output Directory**: `apps/web/dist`
   - **Build Environment Variable**: `VITE_API_BASE_URL=https://api.yourdomain.com`
2. Configure SPA fallback rewrite (`/* -> /index.html` status `200`).

---

## Step 4: Enable HTTPS & Connect Domains

Put both services behind HTTPS before opening the app in a browser. Follow [docs/https-setup.md](docs/https-setup.md) for:
- **Automatic Let's Encrypt with Caddy** ([deploy/Caddyfile](deploy/Caddyfile) + `docker compose -f docker-compose.prod.yml --profile tls up -d`)
- **Nginx + Certbot** ([deploy/nginx-https.conf](deploy/nginx-https.conf), ensuring `proxy_buffering off;` for SSE chat streaming)
- **Cloudflare / PaaS TLS** and cross-origin cookie rules (`CORS_ORIGIN`, `COOKIE_SAME_SITE=none`, optional `COOKIE_DOMAIN`)

---

## Step 5: Post-Deployment End-to-End Smoke Verification

1. **Health check**: `GET https://api.yourdomain.com/health` returns `200` with `"status": "online"`.
2. **Auth & CORS**: Visit `https://app.yourdomain.com`, enter `APP_ACCESS_PASSCODE`, confirm login succeeds and `mj_session` cookie is stored (`HttpOnly`, `Secure`, `SameSite=None`).
3. **Text chat**: Send a message and confirm live SSE token streaming works smoothly.
4. **Realtime voice**: Open voice session, verify browser mic permission prompt works over HTTPS, verify `POST /api/voice/client-secret` returns an ephemeral `token` (TTL 300s) and `wss://api.x.ai/v1/realtime` connects cleanly.
5. **Secret isolation check**: Inspect `apps/web/dist/assets/*.js` and browser DevTools Network tab — verify `XAI_API_KEY`, `AUTH_SECRET`, and `APP_ACCESS_PASSCODE` never appear anywhere in browser responses or static assets.

---

## Operations: Backups & Rollback

- **SQLite Backup**: Periodically snapshot `/app/data/mj-assistant.db` (plus `-wal` / `-shm` if live, or during a brief maintenance stop):
  ```bash
  docker run --rm -v mj_sqlite_data:/data -v "$PWD/backups:/backups" alpine \
    cp -a /data/. /backups/snapshot-$(date +%F)
  ```
- **Rollback**: Keep the previous tagged Docker images (`mj-backend:<prev>` and `mj-frontend:<prev>`) and redeploy the prior tag; schema migrations in `@mj/database` are additive (`0001`–`0003`).
