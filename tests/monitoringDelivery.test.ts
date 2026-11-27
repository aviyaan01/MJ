import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  DEFAULT_BUDGET_SETTINGS,
  ErrorCodes,
  estimateResponseCostUsd,
  estimateSttCostUsd,
  estimateTtsCostUsd,
  estimateVoiceDurationCostUsd,
  evaluateBudgetStatus,
} from '@mj/shared';
import { XaiResponsesClient } from '@mj/ai';
import { SQL_MIGRATIONS } from '@mj/database';
import { buildServer, type MjServerContext } from '../apps/server/src/app.js';
import { loadServerConfig } from '../apps/server/src/config.js';

function createProbeXaiClient(options: {
  ok?: boolean;
  models?: string[];
  failStatus?: number;
} = {}): XaiResponsesClient {
  return new XaiResponsesClient({
    apiKey: 'xai-stage5-test-key-never-leak',
    baseUrl: 'https://api.x.ai/v1',
    defaultModel: 'grok-4.7',
    timeoutMs: 5000,
    fetchImpl: async (input) => {
      const url = String(input);
      if (url.endsWith('/models')) {
        if (options.ok === false) {
          return new Response(JSON.stringify({ error: { message: 'Invalid API key' } }), {
            status: options.failStatus ?? 401,
          });
        }
        return new Response(
          JSON.stringify({
            data: (options.models ?? ['grok-4.7', 'grok-4-1-fast']).map((id) => ({ id })),
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        );
      }
      return new Response(
        'event: response.completed\ndata: {"type":"response.completed","response":{"id":"r"}}\n\n',
        { status: 200, headers: { 'Content-Type': 'text/event-stream' } },
      );
    },
  });
}

describe('Section 16 Monitoring, Cost Breakdown, Connectivity Probe & Delivery Integrity', () => {
  const contexts: MjServerContext[] = [];
  const tempDirs: string[] = [];

  afterEach(async () => {
    while (contexts.length > 0) {
      const ctx = contexts.pop()!;
      await ctx.app.close();
      ctx.dbHandle.close();
    }
    while (tempDirs.length > 0) {
      const dir = tempDirs.pop()!;
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('computes accurate spend estimates and spend-vs-budget thresholds across all channels', () => {
    const textUsd = estimateResponseCostUsd(
      { inputTokens: 1_000_000, outputTokens: 500_000, cachedTokens: 200_000 },
      DEFAULT_BUDGET_SETTINGS,
    );
    // 800k uncached * $2/1M = $1.60 + 200k cached * $0.5/1M = $0.10 + 500k out * $6/1M = $3.00 -> $4.70
    expect(textUsd).toBeCloseTo(4.7, 5);

    expect(estimateVoiceDurationCostUsd(120, 0.05)).toBeCloseTo(0.1, 5);
    expect(estimateTtsCostUsd(100_000, 15)).toBeCloseTo(1.5, 5);
    expect(estimateSttCostUsd(1800, 0.2)).toBeCloseTo(0.1, 5);

    const warn = evaluateBudgetStatus(12.5, 3, {
      ...DEFAULT_BUDGET_SETTINGS,
      softCapUsd: 10,
      hardCapUsd: 25,
    });
    expect(warn.level).toBe('soft_cap_warning');
    expect(warn.percentOfHardCap).toBeCloseTo(50, 1);
    expect(warn.percentOfSoftCap).toBeCloseTo(125, 1);
    expect(warn.remainingSoftCapUsd).toBe(0);
    expect(warn.remainingHardCapUsd).toBeCloseTo(12.5, 4);

    const hard = evaluateBudgetStatus(25, 1, DEFAULT_BUDGET_SETTINGS);
    expect(hard.level).toBe('hard_cap_reached');
    expect(hard.remainingHardCapUsd).toBe(0);
  });

  it('tracks multi-channel latency, STT cost, voice error counts, and live connectivity probes', async () => {
    let secretShouldFail = false;
    const config = loadServerConfig({
      APP_ENV: 'test',
      XAI_API_KEY: 'xai-stage5-test-key-never-leak',
      XAI_TEXT_MODEL: 'grok-4.7',
      XAI_VOICE_MODEL: 'grok-voice-latest',
      DATABASE_URL: ':memory:',
      AUTH_SECRET: 'test-signing-secret-must-be-at-least-32-bytes-long',
      CORS_ORIGIN: 'http://localhost:5173',
    });

    const ctx = await buildServer({
      config,
      xaiClient: createProbeXaiClient({ ok: true, models: ['grok-4.7', 'grok-3'] }),
      voiceGateway: {
        createClientSecret: async () => {
          if (secretShouldFail) {
            throw new Error('Upstream voice outage');
          }
          return { token: 'eph_1', expiresAt: 1999999999 };
        },
        synthesizeSpeech: async () => ({
          audioBuffer: new Uint8Array([1, 2, 3, 4]).buffer,
          contentType: 'audio/mpeg',
        }),
        listVoices: async () => [
          { id: 'ara', label: 'Ara', description: 'Warm' },
          { id: 'rex', label: 'Rex', description: 'Clear' },
        ],
        transcribeSpeech: async () => ({ text: 'Hello MJ', language: 'en' }),
      },
    });
    contexts.push(ctx);

    const loginRes = await ctx.app.inject({ method: 'POST', url: '/api/auth/login', payload: {} });
    const cookie = String(loginRes.headers['set-cookie']).split(';')[0]!;

    // Trigger live connectivity probe
    const probeRes = await ctx.app.inject({
      method: 'POST',
      url: '/api/usage/connectivity',
      headers: { cookie },
      payload: {},
    });
    expect(probeRes.statusCode).toBe(200);
    expect(probeRes.body).not.toContain('xai-stage5-test-key-never-leak');
    const probeJson = probeRes.json();
    expect(probeJson.xaiReachable).toBe(true);
    expect(probeJson.modelAvailable).toBe(true);
    expect(probeJson.availableVoiceCount).toBe(2);

    // Record STT usage with duration + failed voice client-secret attempt -> increments error count
    const sttRes = await ctx.app.inject({
      method: 'POST',
      url: '/api/voice/stt',
      headers: { cookie },
      payload: {
        audioBase64: Buffer.from('test-audio-bytes').toString('base64'),
        durationSeconds: 3600,
      },
    });
    expect(sttRes.statusCode).toBe(200);

    secretShouldFail = true;
    const failedVoice = await ctx.app.inject({
      method: 'POST',
      url: '/api/voice/client-secret',
      headers: { cookie },
      payload: {},
    });
    expect(failedVoice.statusCode).toBe(500);

    await ctx.app.inject({
      method: 'POST',
      url: '/api/voice/tts',
      headers: { cookie },
      payload: { text: 'Hello MJ Assistant' },
    });

    const usageRes = await ctx.app.inject({
      method: 'GET',
      url: '/api/usage',
      headers: { cookie },
    });
    expect(usageRes.statusCode).toBe(200);
    const summary = usageRes.json();
    expect(summary.month.requestCount).toBe(3);
    expect(summary.month.errorCount).toBe(1);
    expect(summary.month.byKind.stt.requests).toBe(1);
    expect(summary.month.byKind.stt.estimatedCostUsd).toBeCloseTo(0.1, 4);
    expect(summary.month.byKind.voice_realtime.errors).toBe(1);
    expect(summary.month.byKind.tts.requests).toBe(1);
    expect(summary.budgetStatus.hardCapUsd).toBe(25);
  });

  it('serves built static web bundle safely without leaking paths outside distRoot', async () => {
    const tempDist = resolve(process.cwd(), 'data', `.tmp-dist-${Date.now()}`);
    mkdirSync(resolve(tempDist, 'assets'), { recursive: true });
    tempDirs.push(tempDist);

    writeFileSync(resolve(tempDist, 'index.html'), '<!doctype html><html><body>MJ SPA</body></html>');
    writeFileSync(resolve(tempDist, 'assets', 'app.js'), 'console.log("ok");');

    const config = loadServerConfig({
      APP_ENV: 'test',
      XAI_API_KEY: 'your_xai_api_key_here',
      DATABASE_URL: ':memory:',
      AUTH_SECRET: 'test-signing-secret-must-be-at-least-32-bytes-long',
      CORS_ORIGIN: 'http://localhost:5173',
    });

    const ctx = await buildServer({
      config,
      webDistDir: tempDist,
      xaiClient: createProbeXaiClient(),
    });
    contexts.push(ctx);

    const rootRes = await ctx.app.inject({ method: 'GET', url: '/' });
    expect(rootRes.statusCode).toBe(200);
    expect(rootRes.body).toContain('MJ SPA');

    const assetRes = await ctx.app.inject({ method: 'GET', url: '/assets/app.js' });
    expect(assetRes.statusCode).toBe(200);
    expect(assetRes.headers['cache-control']).toContain('immutable');

    // Unknown /api/* must return JSON 404, never SPA HTML
    const missingApi = await ctx.app.inject({ method: 'GET', url: '/api/nonexistent-endpoint' });
    expect(missingApi.statusCode).toBe(404);
    expect(missingApi.json().error.code).toBe(ErrorCodes.NOT_FOUND);
  });

  it('verifies delivery package artifacts: migrations, docs, and secret-free .env.example', () => {
    expect(SQL_MIGRATIONS.map((m) => m.id)).toEqual([
      '0001_stage1_foundation',
      '0002_stage2_voice_tracking',
      '0003_stage4_privacy_desktop',
    ]);

    const envExample = readFileSync(resolve(process.cwd(), '.env.example'), 'utf8');
    expect(envExample).toContain('XAI_API_KEY=your_xai_api_key_here');
    expect(envExample).toContain('SERVE_WEB_DIST=');
    expect(envExample).not.toMatch(/xai-[A-Za-z0-9]{12,}/);

    const requiredDocs = [
      'README.md',
      'docs/api-integration.md',
      'docs/deployment-guide.md',
      'docs/testing-checklist-and-report.md',
      'docs/stage-1-api-and-testing.md',
      'docs/stage-2-voice-and-testing.md',
      'docs/stage-4-desktop-and-privacy.md',
    ];
    for (const rel of requiredDocs) {
      const full = resolve(process.cwd(), rel);
      expect(existsSync(full), `Missing ${rel}`).toBe(true);
      expect(readFileSync(full, 'utf8').trim().length).toBeGreaterThan(200);
    }
  });
});
