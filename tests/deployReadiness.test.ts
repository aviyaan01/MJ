import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { buildServer, type MjServerContext } from '../apps/server/src/app.js';
import { loadServerConfig } from '../apps/server/src/config.js';
import type { VoiceGateway } from '../apps/server/src/routes/voice.js';

describe('Split Production Deployment Readiness', () => {
  const contexts: MjServerContext[] = [];

  afterEach(async () => {
    while (contexts.length > 0) {
      const ctx = contexts.pop()!;
      await ctx.app.close();
      ctx.dbHandle.close();
    }
  });

  it('exposes /health with 200 when database is healthy and 503 when database ping fails, without leaking secrets', async () => {
    const secretKey = 'xai-deploy-health-check-secret-999';
    const config = loadServerConfig({
      APP_ENV: 'test',
      DATABASE_URL: ':memory:',
      XAI_API_KEY: secretKey,
      AUTH_SECRET: 'deploy-test-auth-secret-minimum-32-characters',
      APP_ACCESS_PASSCODE: 'mj-deploy-pass',
      SERVE_WEB_DIST: 'false',
    });

    const ctx = await buildServer({ config });
    contexts.push(ctx);

    const okRes = await ctx.app.inject({ method: 'GET', url: '/health' });
    expect(okRes.statusCode).toBe(200);
    expect(okRes.body).not.toContain(secretKey);
    const okPayload = okRes.json() as Record<string, unknown>;
    expect(okPayload.status).toBe('online');
    expect(okPayload.backend).toBe('online');
    expect(okPayload.database).toBe('healthy');
    expect(okPayload.aiEngine).toBe('ready');
    expect(okPayload.voiceEngine).toBe('ready');

    const apiOkRes = await ctx.app.inject({ method: 'GET', url: '/api/health' });
    expect(apiOkRes.statusCode).toBe(200);
    expect(apiOkRes.json()).toMatchObject({ status: 'online', database: 'healthy' });

    const originalPing = ctx.dbHandle.ping;
    ctx.dbHandle.ping = () => false;
    try {
      const degradedRes = await ctx.app.inject({ method: 'GET', url: '/health' });
      expect(degradedRes.statusCode).toBe(503);
      expect(degradedRes.body).not.toContain(secretKey);
      expect(degradedRes.json()).toMatchObject({
        status: 'degraded',
        backend: 'online',
        database: 'unavailable',
      });
    } finally {
      ctx.dbHandle.ping = originalPing;
    }
  });

  it('supports split-origin HTTPS cookies, CORS, and server-side-only ephemeral voice secret flow in production config', async () => {
    const prodApiKey = 'xai-prod-secret-never-sent-to-browser-999';
    const config = loadServerConfig({
      APP_ENV: 'production',
      HOST: '0.0.0.0',
      PORT: '3001',
      SERVE_WEB_DIST: 'false',
      DATABASE_URL: ':memory:',
      XAI_API_KEY: prodApiKey,
      AUTH_SECRET: '0123456789abcdef0123456789abcdef0123456789abcdef',
      APP_ACCESS_PASSCODE: 'prod-passcode-1234',
      CORS_ORIGIN: 'https://app.example.com',
      COOKIE_SAME_SITE: 'none',
      COOKIE_DOMAIN: '.example.com',
    });

    expect(config.serveWebDist).toBe(false);
    expect(config.cookieSameSite).toBe('none');
    expect(config.cookieDomain).toBe('.example.com');
    expect(config.corsOrigins).toEqual(['https://app.example.com']);

    const mockVoiceGateway: VoiceGateway = {
      createClientSecret: async (expiresAfterSeconds = 300) => ({
        token: 'ek_test_ephemeral_token_only',
        expiresAt: Math.floor(Date.now() / 1000) + expiresAfterSeconds,
      }),
      synthesizeSpeech: async () => ({
        audioBuffer: Buffer.from([1, 2, 3]),
        contentType: 'audio/mpeg',
      }),
      listVoices: async () => [],
      transcribeSpeech: async () => ({ text: 'ok' }),
    };

    const ctx = await buildServer({ config, voiceGateway: mockVoiceGateway });
    contexts.push(ctx);

    const loginRes = await ctx.app.inject({
      method: 'POST',
      url: '/api/auth/login',
      headers: {
        origin: 'https://app.example.com',
      },
      payload: {
        passcode: 'prod-passcode-1234',
      },
    });

    expect(loginRes.statusCode).toBe(200);
    expect(loginRes.headers['access-control-allow-origin']).toBe('https://app.example.com');
    expect(loginRes.headers['access-control-allow-credentials']).toBe('true');

    const setCookieHeader = loginRes.headers['set-cookie'];
    const cookieStrings = Array.isArray(setCookieHeader) ? setCookieHeader : [String(setCookieHeader)];
    const sessionCookie = cookieStrings.find((item) => item.startsWith('mj_session='));
    expect(sessionCookie).toBeDefined();
    expect(sessionCookie).toContain('HttpOnly');
    expect(sessionCookie).toContain('SameSite=None');
    expect(sessionCookie).toContain('Secure');
    expect(sessionCookie).toContain('Domain=.example.com');
    const cookiePair = sessionCookie!.split(';')[0]!;

    // Enable the three voice permission switches explicitly (no master toggle) and mint ephemeral token
    for (const capability of ['microphoneAccess', 'voiceSessionAccess', 'externalWebServices']) {
      const permRes = await ctx.app.inject({
        method: 'PATCH',
        url: '/api/privacy/permissions',
        headers: {
          cookie: cookiePair,
          origin: 'https://app.example.com',
        },
        payload: { key: capability, enabled: true },
      });
      expect(permRes.statusCode).toBe(200);
    }

    const secretRes = await ctx.app.inject({
      method: 'POST',
      url: '/api/voice/client-secret',
      headers: {
        cookie: cookiePair,
        origin: 'https://app.example.com',
      },
      payload: { languageMode: 'auto' },
    });

    expect(secretRes.statusCode).toBe(200);
    expect(secretRes.body).not.toContain(prodApiKey);
    expect(secretRes.json()).toMatchObject({
      token: 'ek_test_ephemeral_token_only',
      realtimeUrl: 'wss://api.x.ai/v1/realtime',
    });
  });

  it('ships complete split deployment artifacts with placeholder-only env templates and zero secrets', () => {
    const rootDir = resolve(process.cwd());
    const requiredFiles = [
      '.dockerignore',
      'Dockerfile.backend',
      'Dockerfile.frontend',
      'docker-compose.prod.yml',
      'deploy/Caddyfile',
      'deploy/nginx.frontend.conf',
      'deploy/nginx-https.conf',
      '.env.example',
      'apps/server/.env.production.example',
      'apps/web/.env.production.example',
      'docs/https-setup.md',
      'DEPLOY.md',
    ];

    for (const relPath of requiredFiles) {
      const absPath = resolve(rootDir, relPath);
      expect(existsSync(absPath), `Missing deploy artifact: ${relPath}`).toBe(true);
      const contents = readFileSync(absPath, 'utf8');
      expect(contents).not.toMatch(/xai-[A-Za-z0-9]{12,}/);
    }

    const serverEnvExample = readFileSync(resolve(rootDir, 'apps/server/.env.production.example'), 'utf8');
    expect(serverEnvExample).toContain('XAI_API_KEY=your_xai_api_key_here');
    expect(serverEnvExample).toContain('AUTH_SECRET=replace_with_a_long_random_secret_min_32_chars');
    expect(serverEnvExample).toContain('SERVE_WEB_DIST=false');
    expect(serverEnvExample).toContain('COOKIE_SAME_SITE=none');

    const webEnvExample = readFileSync(resolve(rootDir, 'apps/web/.env.production.example'), 'utf8');
    expect(webEnvExample).toContain('VITE_API_BASE_URL=https://api.yourdomain.com');
    expect(webEnvExample).not.toMatch(/^\s*(XAI_API_KEY|AUTH_SECRET|APP_ACCESS_PASSCODE)=/m);

    const clientSource = readFileSync(resolve(rootDir, 'apps/web/src/api/client.ts'), 'utf8');
    expect(clientSource).toContain('VITE_API_BASE_URL');
    expect(clientSource).toContain('resolveApiUrl(');
    expect(clientSource).toContain('fetch(resolveApiUrl(url)');
  });
});
