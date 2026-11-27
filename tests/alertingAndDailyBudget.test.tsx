import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it } from 'vitest';
import {
  DEFAULT_BUDGET_SETTINGS,
  VoiceStates,
  evaluateBudgetStatus,
  sanitizeDiagnosticText,
  sanitizeUrlForLog,
  type PublicSettingsDTO,
  type SystemHealthDTO,
  type UsageSummaryDTO,
} from '@mj/shared';
import { ProviderRouterClient } from '@mj/ai';
import { createDatabase } from '@mj/database';
import { AlertMonitor } from '../apps/server/src/alerting.js';
import { buildServer, type MjServerContext } from '../apps/server/src/app.js';
import { loadServerConfig } from '../apps/server/src/config.js';
import { DEFAULT_HEALTH_WATCHDOG_INTERVAL_MS } from '../apps/server/src/routes/health.js';
import { UsageDashboardView } from '../apps/web/src/components/UsageDashboardView.js';

describe('Uptime, Crash & Error-Rate Alerting, Daily Budget Warning & Log Sanitization', () => {
  const contexts: MjServerContext[] = [];

  afterEach(async () => {
    while (contexts.length > 0) {
      const ctx = contexts.pop()!;
      await ctx.app.close();
      ctx.dbHandle.close();
    }
  });

  it('dispatches Telegram + Email crash alerts cleanly while redacting API keys and personal data', async () => {
    const dispatched: Array<{ url: string; body: string; auth?: string }> = [];
    const loggedMessages: string[] = [];

    const monitor = new AlertMonitor(
      {
        appEnv: 'production',
        telegramBotToken: '123456789:AAFakeTelegramBotTokenForTestingOnly',
        telegramChatId: '-100999888777',
        resendApiKey: 're_FakeResendSecretKey123456',
        smtpPort: 587,
        smtpSecure: false,
        emailFrom: 'alerts@mj.local',
        emailTo: 'ops-private@example.com',
        errorRateThresholdPct: 25,
        minSampleRequests: 5,
        windowMinutes: 15,
        cooldownMinutes: 15,
      },
      {
        fetchImpl: async (input, init) => {
          const headers = (init?.headers ?? {}) as Record<string, string>;
          dispatched.push({
            url: String(input),
            body: String(init?.body ?? ''),
            auth: headers.Authorization,
          });
          return new Response(JSON.stringify({ ok: true }), { status: 200 });
        },
        onLog: (msg) => loggedMessages.push(msg),
      },
    );

    const leakedCrashError = new Error(
      'Upstream crash Authorization Bearer eyJhbGciOi.secret_token xai-superSecretApiKey12345 for alice.personal@gmail.com at C:\\Users\\AlicePrivate\\MJ\\data',
    );
    await monitor.notifyCrash('uncaughtException', leakedCrashError);

    expect(dispatched).toHaveLength(2);
    const telegramCall = dispatched.find((d) => d.url.includes('api.telegram.org'));
    const resendCall = dispatched.find((d) => d.url.includes('api.resend.com'));
    expect(telegramCall).toBeDefined();
    expect(resendCall).toBeDefined();

    // Neither outbound alert text nor logs may expose the API key, Bearer token, user email, or OS username
    for (const payload of [telegramCall!.body, resendCall!.body]) {
      expect(payload).not.toContain('xai-superSecretApiKey12345');
      expect(payload).not.toContain('eyJhbGciOi.secret_token');
      expect(payload).not.toContain('alice.personal@gmail.com');
      expect(payload).not.toContain('AlicePrivate');
      expect(payload).toContain('uncaughtException');
    }

    const status = monitor.getStatus();
    expect(status.emailConfigured).toBe(true);
    expect(status.telegramConfigured).toBe(true);
    expect(status.lastAlertReason).toBe('crash');
    expect(status.lastDeliveryStatus).toBe('sent');
    expect(status.alertsSentCount).toBe(1);
    expect(loggedMessages).toHaveLength(0);
  });

  it('triggers high error-rate alerts after minimum sample threshold, honors cooldown, and fires SMTP fallback', async () => {
    let now = 1_700_000_000_000;
    const smtpSent: Array<{ subject: string; text: string }> = [];

    const monitor = new AlertMonitor(
      {
        appEnv: 'production',
        smtpHost: 'smtp.example.local',
        smtpPort: 587,
        smtpSecure: false,
        emailFrom: 'mj-bot@example.local',
        emailTo: 'admin@example.local',
        errorRateThresholdPct: 25,
        minSampleRequests: 4,
        windowMinutes: 15,
        cooldownMinutes: 10,
      },
      {
        nowMs: () => now,
        sendSmtpEmailImpl: async (_cfg, payload) => {
          smtpSent.push({ subject: payload.subject, text: payload.text });
        },
      },
    );

    // Below minSampleRequests -> does not fire yet
    await monitor.recordApiOutcome({ ok: false, code: 'UPSTREAM_ERROR' });
    await monitor.recordApiOutcome({ ok: true });
    await monitor.recordApiOutcome({ ok: true });
    expect(smtpSent).toHaveLength(0);

    // 4th request fails -> 2/4 = 50% >= 25% -> fires alert!
    await monitor.recordApiOutcome({ ok: false, code: 'TIMEOUT' });
    expect(smtpSent).toHaveLength(1);
    expect(smtpSent[0]!.text).toContain('50.0%');

    // Within 10-minute cooldown -> suppressed
    now += 60_000;
    await monitor.recordApiOutcome({ ok: false, code: 'UPSTREAM_ERROR' });
    expect(smtpSent).toHaveLength(1);

    // Past cooldown -> fires again cleanly
    now += 11 * 60_000;
    await monitor.recordApiOutcome({ ok: false, code: 'UPSTREAM_ERROR' });
    expect(smtpSent).toHaveLength(2);
  });

  it('wires health DB failure, API error rate telemetry, and strict log sanitization into the server', async () => {
    const telegramAlerts: string[] = [];
    const config = loadServerConfig({
      APP_ENV: 'test',
      DATABASE_URL: ':memory:',
      XAI_API_KEY: 'xai-server-secret-must-never-leak-999',
      AUTH_SECRET: 'test-auth-secret-minimum-32-characters-long',
      ALERT_TELEGRAM_BOT_TOKEN: '987654321:AAFakeTelegramTokenHere',
      ALERT_TELEGRAM_CHAT_ID: '123456',
      ALERT_ERROR_RATE_PCT: '25',
      ALERT_MIN_REQUESTS: '1',
    });

    const alertMonitor = new AlertMonitor(config.alerting, {
      fetchImpl: async (_input, init) => {
        telegramAlerts.push(String(init?.body ?? ''));
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      },
    });

    const ctx = await buildServer({
      config,
      alertMonitor,
      voiceGateway: {
        createClientSecret: async () => {
          throw new Error('Upstream outage with xai-server-secret-must-never-leak-999');
        },
        synthesizeSpeech: async () => ({
          audioBuffer: new Uint8Array([1]).buffer,
          contentType: 'audio/mpeg',
        }),
        listVoices: async () => [],
        transcribeSpeech: async () => ({ text: 'ok' }),
      },
    });
    contexts.push(ctx);

    const loginRes = await ctx.app.inject({ method: 'POST', url: '/api/auth/login', payload: {} });
    const cookie = String(loginRes.headers['set-cookie']).split(';')[0]!;

    // Trigger DB ping failure -> triggers uptime_down alert without leaking secrets
    const origPing = ctx.dbHandle.ping;
    ctx.dbHandle.ping = () => false;
    try {
      const healthRes = await ctx.app.inject({ method: 'GET', url: '/health' });
      expect(healthRes.statusCode).toBe(503);
    } finally {
      ctx.dbHandle.ping = origPing;
    }

    await new Promise((r) => setTimeout(r, 20));
    expect(telegramAlerts.some((b) => b.includes('uptime_down') || b.includes('Health'))).toBe(true);

    // Enable required voice permissions individually, then fail /api/voice/client-secret
    for (const key of ['microphoneAccess', 'voiceSessionAccess', 'externalWebServices']) {
      await ctx.app.inject({
        method: 'PATCH',
        url: '/api/privacy/permissions',
        headers: { cookie },
        payload: { key, enabled: true },
      });
    }
    const failVoice = await ctx.app.inject({
      method: 'POST',
      url: '/api/voice/client-secret',
      headers: { cookie },
      payload: {},
    });
    expect(failVoice.statusCode).toBe(500);
    expect(failVoice.body).not.toContain('xai-server-secret-must-never-leak-999');

    await new Promise((r) => setTimeout(r, 20));
    expect(telegramAlerts.some((b) => b.includes('High API Error Rate'))).toBe(true);
    expect(telegramAlerts.some((b) => b.includes('Crash'))).toBe(true);
    for (const payload of telegramAlerts) {
      expect(payload).not.toContain('xai-server-secret-must-never-leak-999');
    }

    // GET /api/usage exposes sanitized alerting status (never exposes bot token or chat ID)
    const usageRes = await ctx.app.inject({
      method: 'GET',
      url: '/api/usage',
      headers: { cookie },
    });
    expect(usageRes.statusCode).toBe(200);
    expect(usageRes.body).not.toContain('987654321:AAFakeTelegramTokenHere');
    expect(usageRes.body).not.toContain('xai-server-secret-must-never-leak-999');
    const usageJson = usageRes.json() as UsageSummaryDTO;
    expect(usageJson.alerting?.telegramConfigured).toBe(true);
    expect(usageJson.alerting?.currentWindowErrors).toBeGreaterThanOrEqual(1);
    expect(usageJson.alerting?.alertsSentCount).toBeGreaterThanOrEqual(3);
    expect(usageJson.alerting?.lastAlertReason).toBe('crash');
  });

  it('evaluates daily spend vs daily budget and renders warning alert banner in UsageDashboardView when exceeded', () => {
    const under = evaluateBudgetStatus(1.0, 1.25, { ...DEFAULT_BUDGET_SETTINGS, dailyCapUsd: 2.0 });
    expect(under.dailyLevel).toBe('ok');
    expect(under.remainingDailyCapUsd).toBeCloseTo(0.75, 4);

    const over = evaluateBudgetStatus(2.4, 2.4, { ...DEFAULT_BUDGET_SETTINGS, dailyCapUsd: 2.0 });
    expect(over.dailyLevel).toBe('daily_cap_exceeded');
    expect(over.percentOfDailyCap).toBeCloseTo(120, 1);
    expect(over.remainingDailyCapUsd).toBe(0);

    const baseHealth: SystemHealthDTO = {
      status: 'online',
      stage: 'Stage 5 · Monitoring, Usage & Final Delivery',
      backend: 'online',
      database: 'healthy',
      aiEngine: 'ready',
      voiceEngine: 'ready',
      activeModel: 'grok-4.7',
      activeVoiceModel: 'grok-voice-latest',
      apiBaseHost: 'api.x.ai',
      uptimeSeconds: 10,
      appEnv: 'test',
      timestamp: new Date().toISOString(),
      features: {
        textChat: true,
        streaming: true,
        conversationHistory: true,
        voice: true,
        memory: false,
        tools: false,
        automation: false,
        desktop: true,
      },
    };

    const baseSettings: PublicSettingsDTO = {
      assistantName: 'MJ Assistant',
      activeModel: 'grok-4.7',
      availableModels: ['grok-4.7'],
      reasoningEffort: 'medium',
      responseStyle: 'balanced',
      maxOutputTokens: 4096,
      timeoutMs: 60000,
      streamResponses: true,
      reducedMotionOverride: 'system',
      compactDensity: false,
      apiBaseHost: 'api.x.ai',
      apiKeyConfigured: true,
      appEnv: 'test',
      budget: { ...DEFAULT_BUDGET_SETTINGS, dailyCapUsd: 2.0 },
      voice: {
        voiceModel: 'grok-voice-latest',
        availableVoiceModels: ['grok-voice-latest'],
        voiceId: 'ara',
        availableVoices: [{ id: 'ara', label: 'Ara', description: 'Warm' }],
        speakingRate: 1,
        volume: 0.9,
        autoPlayback: false,
        voiceOutputEnabled: true,
        languageMode: 'auto',
      },
    };

    const makeUsage = (dayCost: number): UsageSummaryDTO => ({
      today: {
        requestCount: 3,
        errorCount: 0,
        inputTokens: 1000,
        outputTokens: 500,
        reasoningTokens: 0,
        cachedTokens: 0,
        totalTokens: 1500,
        voiceSeconds: 0,
        estimatedCostUsd: dayCost,
        avgLatencyMs: 200,
        byKind: {
          text: { requests: 3, errors: 0, estimatedCostUsd: dayCost, avgLatencyMs: 200, totalTokens: 1500, voiceSeconds: 0 },
          voice_realtime: { requests: 0, errors: 0, estimatedCostUsd: 0, avgLatencyMs: 0, totalTokens: 0, voiceSeconds: 0 },
          tts: { requests: 0, errors: 0, estimatedCostUsd: 0, avgLatencyMs: 0, totalTokens: 0, voiceSeconds: 0 },
          stt: { requests: 0, errors: 0, estimatedCostUsd: 0, avgLatencyMs: 0, totalTokens: 0, voiceSeconds: 0 },
        },
      },
      month: {
        requestCount: 3,
        errorCount: 0,
        inputTokens: 1000,
        outputTokens: 500,
        reasoningTokens: 0,
        cachedTokens: 0,
        totalTokens: 1500,
        voiceSeconds: 0,
        estimatedCostUsd: dayCost,
        avgLatencyMs: 200,
        byKind: {
          text: { requests: 3, errors: 0, estimatedCostUsd: dayCost, avgLatencyMs: 200, totalTokens: 1500, voiceSeconds: 0 },
          voice_realtime: { requests: 0, errors: 0, estimatedCostUsd: 0, avgLatencyMs: 0, totalTokens: 0, voiceSeconds: 0 },
          tts: { requests: 0, errors: 0, estimatedCostUsd: 0, avgLatencyMs: 0, totalTokens: 0, voiceSeconds: 0 },
          stt: { requests: 0, errors: 0, estimatedCostUsd: 0, avgLatencyMs: 0, totalTokens: 0, voiceSeconds: 0 },
        },
      },
      budgetStatus: evaluateBudgetStatus(dayCost, dayCost, { ...DEFAULT_BUDGET_SETTINGS, dailyCapUsd: 2.0 }),
      recentEvents: [],
    });

    const noop = async () => {};
    const okHtml = renderToStaticMarkup(
      <UsageDashboardView
        health={baseHealth}
        backendLatencyMs={15}
        online
        voiceState={VoiceStates.IDLE}
        settings={baseSettings}
        usage={makeUsage(0.5)}
        connectivityCheck={null}
        checkingConnectivity={false}
        onRefreshUsage={noop}
        onCheckConnectivity={noop}
        onSaveSettings={noop}
      />,
    );
    expect(okHtml).toContain('WITHIN LIMIT');
    expect(okHtml).not.toContain('Daily Budget Warning:');

    const exceededHtml = renderToStaticMarkup(
      <UsageDashboardView
        health={baseHealth}
        backendLatencyMs={15}
        online
        voiceState={VoiceStates.IDLE}
        settings={baseSettings}
        usage={makeUsage(2.4)}
        connectivityCheck={null}
        checkingConnectivity={false}
        onRefreshUsage={noop}
        onCheckConnectivity={noop}
        onSaveSettings={noop}
      />,
    );
    expect(exceededHtml).toContain('role="alert"');
    expect(exceededHtml).toContain('Daily Budget Warning:');
    expect(exceededHtml).toContain('Daily Spend Budget Crossed');
    expect(exceededHtml).toContain('EXCEEDED');
  });

  it('scrubs secrets, emails, bot tokens, user paths, and URL query strings from diagnostic logs', () => {
    const geminiKey = 'AIzaSyFakeTestKey1234567890ABCDEFGHIJKLMN';
    const groqKey = 'gsk_FakeGroqKey987654321';
    const ghpKey = 'ghp_FakeGitHubClassicToken123';
    const ghPat = 'github_pat_FakeFineGrainedToken_123456';
    const bearerTok = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.abc+def/123=';

    const raw =
      `Failed /api/conversations?q=my+private+journal for john.doe@example.com with xai-abc123456789, ${geminiKey}, ${groqKey}, ${ghpKey}, ${ghPat}, Bearer ${bearerTok}, re_SecretResend1234, bot987654:SecretBotToken99, C:\\Users\\JohnDoe\\secret.txt`;
    const sanitized = sanitizeDiagnosticText(raw);

    expect(sanitized).not.toContain('my+private+journal');
    expect(sanitized).not.toContain('john.doe@example.com');
    expect(sanitized).not.toContain('xai-abc123456789');
    expect(sanitized).not.toContain(geminiKey);
    expect(sanitized).not.toContain(groqKey);
    expect(sanitized).not.toContain(ghpKey);
    expect(sanitized).not.toContain(ghPat);
    expect(sanitized).not.toContain(bearerTok);
    expect(sanitized).not.toContain('re_SecretResend1234');
    expect(sanitized).not.toContain('SecretBotToken99');
    expect(sanitized).not.toContain('JohnDoe');
    expect(sanitized).toContain('AIza[REDACTED]');
    expect(sanitized).toContain('xai-[REDACTED]');
    expect(sanitized).toContain('gsk_[REDACTED]');
    expect(sanitized).toContain('ghp_[REDACTED]');
    expect(sanitized).toContain('github_pat_[REDACTED]');
    expect(sanitized).toContain('Bearer [REDACTED]');

    expect(sanitizeUrlForLog('/api/conversations?q=personal+medical+notes')).toBe(
      '/api/conversations?[REDACTED]',
    );
    expect(sanitizeUrlForLog('/health')).toBe('/health');
  });

  it('persists error-rate window & cooldown in SQLite across restarts, runs 60s background watchdog without /health hits, and ignores expected auto-failover errors', async () => {
    expect(DEFAULT_HEALTH_WATCHDOG_INTERVAL_MS).toBe(60_000);

    const sharedDb = createDatabase(':memory:');
    const sentAlerts: string[] = [];

    const config = loadServerConfig({
      APP_ENV: 'test',
      AI_PROVIDER: 'auto',
      GEMINI_API_KEY: 'AIzaSyFakeTestKey1234567890ABCDEFGHIJKLMN',
      OLLAMA_ENABLED: 'true',
      OLLAMA_BASE_URL: 'http://127.0.0.1:11434/v1',
      DATABASE_URL: ':memory:',
      AUTH_SECRET: 'test-auth-secret-minimum-32-characters-long',
      ALERT_TELEGRAM_BOT_TOKEN: '987654321:AAFakeTelegramTokenHere',
      ALERT_TELEGRAM_CHAT_ID: '123456',
      ALERT_ERROR_RATE_PCT: '25',
      ALERT_MIN_REQUESTS: '2',
      ALERT_COOLDOWN_MINUTES: '15',
    });

    try {
      // Boot #1: record failure window -> triggers high_error_rate and persists in SQLite
      const ctx1 = await buildServer({
        config,
        dbHandle: sharedDb,
        watchdogIntervalMs: 0,
      });

      // Test AlertMonitor persistence via shared SQLite + restart simulation using stateStore
      const monitor1 = new AlertMonitor(config.alerting, {
        fetchImpl: async (_in, init) => {
          sentAlerts.push(String(init?.body ?? ''));
          return new Response(JSON.stringify({ ok: true }), { status: 200 });
        },
        stateStore: {
          load: () => ctx1.repo.getStoredSettings('mj.alert_monitor.test.v1'),
          save: (state) => ctx1.repo.saveStoredSettings('mj.alert_monitor.test.v1', state),
        },
      });
      await monitor1.hydrate();

      // Expected auto-failover must NOT trigger error counting or high_error_rate alert
      await monitor1.recordApiOutcome({ ok: false, code: 'RATE_LIMITED', expectedFailover: true });
      await monitor1.recordApiOutcome({ ok: false, code: 'RATE_LIMITED', expectedFailover: true });
      expect(monitor1.getStatus().currentWindowErrors).toBe(0);
      expect(sentAlerts).toHaveLength(0);

      // Genuine failures reach threshold and trigger alert + cooldown
      await monitor1.recordApiOutcome({ ok: false, code: 'UPSTREAM_ERROR' });
      await monitor1.recordApiOutcome({ ok: false, code: 'UPSTREAM_ERROR' });
      await monitor1.flushPersistence();
      expect(sentAlerts.some((b) => b.includes('High API Error Rate'))).toBe(true);
      const alertCountBeforeRestart = sentAlerts.length;

      await ctx1.app.close();

      // Boot #2 on same SQLite handle: state + cooldown survive restart!
      const ctx2 = await buildServer({
        config,
        dbHandle: sharedDb,
        watchdogIntervalMs: 0,
      });

      const monitor2 = new AlertMonitor(config.alerting, {
        fetchImpl: async (_in, init) => {
          sentAlerts.push(String(init?.body ?? ''));
          return new Response(JSON.stringify({ ok: true }), { status: 200 });
        },
        stateStore: {
          load: () => ctx2.repo.getStoredSettings('mj.alert_monitor.test.v1'),
          save: (state) => ctx2.repo.saveStoredSettings('mj.alert_monitor.test.v1', state),
        },
      });
      await monitor2.hydrate();

      const restoredStatus = monitor2.getStatus();
      expect(restoredStatus.currentWindowErrors).toBe(2);
      expect(restoredStatus.lastAlertReason).toBe('high_error_rate');
      // Another genuine error within persisted cooldown must NOT duplicate high_error_rate alert
      await monitor2.recordApiOutcome({ ok: false, code: 'UPSTREAM_ERROR' });
      expect(sentAlerts).toHaveLength(alertCountBeforeRestart);

      // Background health watchdog triggers uptime_down even if /health is never called
      const watchdogMonitor = new AlertMonitor(config.alerting, {
        fetchImpl: async (_in, init) => {
          sentAlerts.push(String(init?.body ?? ''));
          return new Response(JSON.stringify({ ok: true }), { status: 200 });
        },
      });
      const ctxWatchdog = await buildServer({
        config,
        dbHandle: sharedDb,
        alertMonitor: watchdogMonitor,
        watchdogIntervalMs: 25,
      });
      const origPing = sharedDb.ping;
      sharedDb.ping = () => false;
      try {
        await new Promise((r) => setTimeout(r, 70));
      } finally {
        sharedDb.ping = origPing;
      }
      expect(sentAlerts.some((b) => b.includes('Background health watchdog'))).toBe(true);

      // Full-server auto-failover (Gemini 429 quota -> Ollama succeeds) must NOT trigger high_error_rate
      const router = new ProviderRouterClient({
        xai: { apiKey: '', baseUrl: 'https://api.x.ai/v1', model: 'grok-4.7', models: ['grok-4.7'] },
        ollama: { enabled: true, baseUrl: 'http://127.0.0.1:11434/v1', model: 'qwen2.5:7b' },
        groq: { apiKey: '', baseUrl: 'https://api.groq.com/openai/v1', model: 'llama-3.3-70b-versatile' },
        gemini: config.aiProviders.gemini,
        openrouter: config.aiProviders.openrouter,
        cerebras: config.aiProviders.cerebras,
        mistral: config.aiProviders.mistral,
        github: config.aiProviders.github,
        timeoutMs: 5000,
        maxRetries: 0,
        fetchImpl: async (input) => {
          const u = String(input);
          if (u.endsWith('/api/tags')) {
            return new Response(JSON.stringify({ models: [{ name: 'qwen2.5:7b' }] }), { status: 200 });
          }
          if (u.includes('generativelanguage.googleapis.com')) {
            return new Response(
              JSON.stringify({ error: { status: 'RESOURCE_EXHAUSTED', message: 'Quota exceeded' } }),
              { status: 429 },
            );
          }
          return new Response(
            'data: {"choices":[{"index":0,"delta":{"content":"Ollama failover ok"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n',
            { status: 200, headers: { 'Content-Type': 'text/event-stream' } },
          );
        },
      });

      const failoverMonitor = new AlertMonitor(config.alerting, {
        fetchImpl: async (_in, init) => {
          sentAlerts.push(`failover:${String(init?.body ?? '')}`);
          return new Response(JSON.stringify({ ok: true }), { status: 200 });
        },
      });
      const ctxFailover = await buildServer({
        config,
        dbHandle: sharedDb,
        providerRouter: router,
        alertMonitor: failoverMonitor,
        watchdogIntervalMs: 0,
      });

      const login = await ctxFailover.app.inject({ method: 'POST', url: '/api/auth/login', payload: {} });
      const cookie = String(login.headers['set-cookie']).split(';')[0]!;
      const conv = await ctxFailover.app.inject({
        method: 'POST',
        url: '/api/conversations',
        headers: { cookie },
        payload: {},
      });
      const convId = conv.json().conversation.id as string;
      const chatRes = await ctxFailover.app.inject({
        method: 'POST',
        url: `/api/conversations/${convId}/messages`,
        headers: { cookie },
        payload: { content: 'Auto failover test' },
      });
      expect(chatRes.statusCode).toBe(200);
      expect(chatRes.body).toContain('Ollama failover ok');
      expect(failoverMonitor.getStatus().currentWindowErrors).toBe(0);
      expect(sentAlerts.some((s) => s.startsWith('failover:'))).toBe(false);

      await ctxFailover.app.close();
      await ctxWatchdog.app.close();
      await ctx2.app.close();
    } finally {
      sharedDb.close();
    }
  });
});
