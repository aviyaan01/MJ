# HTTPS & TLS Setup Guide for MJ Assistant (Split Frontend + Backend)

HTTPS is **mandatory** in production on non-localhost origins for three reasons:
1. Browser **microphone capture** (`navigator.mediaDevices.getUserMedia`) is blocked on insecure `http://` origins.
2. **`Secure` `HttpOnly` session cookies (`mj_session`)** require HTTPS (especially when `COOKIE_SAME_SITE=none` is used across separate frontend and backend origins).
3. **Ephemeral Voice Token & SSE protection** prevents session/token interception on the network while keeping `XAI_API_KEY` exclusively on the backend.

> **Proxy Trust Built In:** `apps/server/src/app.ts` enables `trustProxy: true` automatically when `APP_ENV=production`, so Fastify trusts `X-Forwarded-Proto: https` and `X-Forwarded-For` from your TLS reverse proxy.

---

## Option A: Caddy (Automatic Let's Encrypt HTTPS — Simplest VPS Setup)

Caddy automatically provisions, serves, and renews Let's Encrypt TLS certificates for both domains.

1. Point DNS `A` / `AAAA` records for both subdomains to your server IP:
   - `app.yourdomain.com` -> Frontend SPA (`frontend:80` or `127.0.0.1:8080`)
   - `api.yourdomain.com` -> Backend API (`backend:3001` or `127.0.0.1:3001`)
2. Edit [deploy/Caddyfile](../deploy/Caddyfile) and replace `app.yourdomain.com` and `api.yourdomain.com` with your real domains. Notice `flush_interval -1` is preconfigured on `api.yourdomain.com` so SSE streaming tokens from `POST /api/conversations/:id/messages` are never buffered.
3. If running with Docker Compose:
   ```bash
   docker compose -f docker-compose.prod.yml --profile tls up -d --build
   ```
4. If running Caddy natively on Linux (`apt install caddy`), update `reverse_proxy` targets in [deploy/Caddyfile](../deploy/Caddyfile) to `127.0.0.1:8080` and `127.0.0.1:3001`, copy it to `/etc/caddy/Caddyfile`, and reload:
   ```bash
   sudo systemctl reload caddy
   ```

---

## Option B: Nginx + Certbot (Let's Encrypt)

If you already terminate TLS with Nginx on Ubuntu/Debian:

1. Copy [deploy/nginx-https.conf](../deploy/nginx-https.conf) to `/etc/nginx/sites-available/mj-assistant.conf` and replace `app.yourdomain.com` and `api.yourdomain.com`.
2. Obtain certificates with Certbot:
   ```bash
   sudo certbot certonly --nginx -d app.yourdomain.com -d api.yourdomain.com
   ```
3. Verify critical proxy directives remain intact inside the `api.yourdomain.com` block:
   - `proxy_http_version 1.1;`
   - `proxy_set_header X-Forwarded-For $remote_addr;` (overwrites client-spoofed `X-Forwarded-For` headers so Fastify `trustProxy: true` cannot be bypassed)
   - `proxy_set_header X-Forwarded-Proto https;`
   - `proxy_buffering off;` and `proxy_cache off;` (prevents buffered/stalled SSE responses)
   - `proxy_read_timeout 180s;`
4. Test and reload Nginx:
   ```bash
   sudo nginx -t && sudo systemctl reload nginx
   ```

---

## Option C: Managed PaaS TLS (Cloudflare / Vercel / Render / Railway / Fly)

When Frontend and Backend are hosted on separate managed platforms:
- **Frontend** (e.g., Cloudflare Pages, Vercel, Netlify): provides automatic HTTPS on `https://app.yourdomain.com` (or provider domain). Set `VITE_API_BASE_URL=https://api.yourdomain.com` at build time.
- **Backend** (e.g., Render, Railway, Fly.io, DigitalOcean App Platform): terminates TLS at the platform edge and forwards HTTP traffic to container port `3001`.
  - If using Cloudflare Proxy (orange cloud) in front of your own TLS server, set SSL/TLS encryption mode to **Full (Strict)**. Never use *Flexible* SSL because `X-Forwarded-Proto` mismatch breaks secure cookies.

---

## Required Cookie, CORS & CSP Settings Over HTTPS

### 1. Backend CORS & Session Cookie Environment Variables
In your backend runtime environment ([apps/server/.env.production.example](../apps/server/.env.production.example)):

- **Separate domains** (e.g., `https://mj.vercel.app` -> `https://api.yourdomain.com`):
  ```env
  CORS_ORIGIN=https://mj.vercel.app
  COOKIE_SAME_SITE=none
  COOKIE_DOMAIN=
  ```
- **Same parent domain** (e.g., `https://app.yourdomain.com` -> `https://api.yourdomain.com`):
  ```env
  CORS_ORIGIN=https://app.yourdomain.com
  COOKIE_SAME_SITE=none
  COOKIE_DOMAIN=.yourdomain.com
  ```
  > Tip: Hosting under the same parent domain (`app.` + `api.yourdomain.com`) with `COOKIE_DOMAIN=.yourdomain.com` prevents third-party cookie restrictions in browsers such as Safari/ITP.

### 2. Frontend Permissions & Content Security Policy (CSP)
If you configure CSP headers on your Frontend host or CDN, allow connections to your HTTPS backend AND direct browser WebSocket sessions to xAI Realtime (which uses only backend-issued short-lived `client_secret` tokens):

```text
default-src 'self';
script-src 'self';
style-src 'self' 'unsafe-inline';
img-src 'self' data:;
connect-src 'self' https://api.yourdomain.com wss://api.x.ai https://api.x.ai;
media-src 'self' blob:;
object-src 'none';
frame-ancestors 'none';
```

And ensure `Permissions-Policy: microphone=(self)` (already set in [deploy/nginx.frontend.conf](../deploy/nginx.frontend.conf)) so the browser allows microphone capture on your HTTPS frontend origin.

---

## Post-TLS Verification Checklist

1. `curl -i https://api.yourdomain.com/health` returns `HTTP/2 200` with `"status": "online"` and `"database": "healthy"`.
2. Opening `https://app.yourdomain.com` loads over HTTPS without mixed-content warnings.
3. Unlocking with `APP_ACCESS_PASSCODE` sets `mj_session` with `HttpOnly`, `Secure`, and `SameSite=None` in browser DevTools.
4. Text chat streams tokens incrementally (confirming SSE buffering is disabled).
5. Voice session requests `POST https://api.yourdomain.com/api/voice/client-secret` and opens `wss://api.x.ai/v1/realtime` with the temporary token only (`XAI_API_KEY` never appears in Network payloads or `dist/assets/*.js`).
