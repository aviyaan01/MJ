import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  ProviderRouterClient,
  XaiResponsesClient,
  parseOpenAiChatStreamFrame,
  transcribeSpeechWithGroqFree,
} from '@mj/ai';
import { AI_PROVIDER_CATALOG } from '@mj/shared';
import { buildServer, type MjServerContext } from '../apps/server/src/app.js';
import { loadServerConfig } from '../apps/server/src/config.js';
import { createDefaultVoiceGateway } from '../apps/server/src/routes/voice.js';

function createOpenAiChatSseResponse(replyText: string, id = 'chatcmpl_free_1'): Response {
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(
        encoder.encode(
          `data: ${JSON.stringify({
            id,
            choices: [{ index: 0, delta: { content: replyText }, finish_reason: null }],
          })}\n\n`,
        ),
      );
      controller.enqueue(
        encoder.encode(
          `data: ${JSON.stringify({
            id,
            choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
            usage: { prompt_tokens: 18, completion_tokens: 9, total_tokens: 27 },
          })}\n\n`,
        ),
      );
      controller.enqueue(encoder.encode('data: [DONE]\n\n'));
      controller.close();
    },
  });
  return new Response(stream, {
    status: 200,
    headers: { 'Content-Type': 'text/event-stream' },
  });
}

describe('Free / $0 AI Providers & Failover Routing', () => {
  const contexts: MjServerContext[] = [];

  afterEach(async () => {
    while (contexts.length > 0) {
      const ctx = contexts.pop()!;
      await ctx.app.close();
      ctx.dbHandle.close();
    }
  });

  it('defines all 7 zero-cost providers alongside xAI in AI_PROVIDER_CATALOG', () => {
    const freeIds = AI_PROVIDER_CATALOG.filter((p) => p.freeTier).map((p) => p.id);
    expect(freeIds).toEqual(
      expect.arrayContaining([
        'ollama',
        'groq',
        'gemini',
        'openrouter',
        'cerebras',
        'mistral',
        'github',
      ]),
    );
  });

  it('parses OpenAI Chat Completions SSE frames accurately', () => {
    const deltaEvents = parseOpenAiChatStreamFrame({
      data: JSON.stringify({
        id: 'chatcmpl_test',
        choices: [{ index: 0, delta: { content: 'Salams! ' }, finish_reason: null }],
      }),
    });
    expect(deltaEvents).toEqual([{ type: 'delta', text: 'Salams! ' }]);

    const doneEvents = parseOpenAiChatStreamFrame({
      data: JSON.stringify({
        id: 'chatcmpl_test',
        choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
        usage: { prompt_tokens: 12, completion_tokens: 5, total_tokens: 17 },
      }),
    });
    expect(
      doneEvents.some(
        (e) => e.type === 'completed' && e.responseId === 'chatcmpl_test' && e.usage?.totalTokens === 17,
      ),
    ).toBe(true);

    const terminalDone = parseOpenAiChatStreamFrame({ data: '[DONE]' });
    expect(terminalDone).toEqual([{ type: 'completed' }]);
  });

  it('routes across all free OpenAI-compatible providers and probes local Ollama without an API key', async () => {
    const seenRequests: Array<{ url: string; auth: string | null; model?: string }> = [];

    const mockFetch: typeof fetch = async (input, init) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
      const headers = new Headers(init?.headers);
      const auth = headers.get('Authorization');

      if (url === 'http://127.0.0.1:11434/api/tags') {
        return new Response(
          JSON.stringify({
            models: [{ name: 'qwen2.5:7b' }, { name: 'llama3.2:latest' }],
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        );
      }

      let model: string | undefined;
      if (typeof init?.body === 'string') {
        const parsed = JSON.parse(init.body) as { model?: string };
        model = parsed.model;
      }
      seenRequests.push({ url, auth, model });

      // Simulate xAI having zero credits
      if (url.startsWith('https://api.x.ai/')) {
        return new Response(
          JSON.stringify({
            error: {
              code: 'permission-denied',
              message: 'Your newly created team does not have credits or licenses yet.',
            },
          }),
          { status: 403, headers: { 'Content-Type': 'application/json' } },
        );
      }

      return createOpenAiChatSseResponse(`Reply from ${model ?? 'free'}`);
    };

    const router = new ProviderRouterClient({
      xai: { apiKey: 'xai-empty-credits', baseUrl: 'https://api.x.ai/v1', model: 'grok-4.7', models: ['grok-4.7'] },
      ollama: { enabled: true, baseUrl: 'http://127.0.0.1:11434/v1', model: 'qwen2.5:7b' },
      groq: { apiKey: 'gsk_test_free', baseUrl: 'https://api.groq.com/openai/v1', model: 'llama-3.3-70b-versatile' },
      gemini: { apiKey: 'gem_test_free', baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai', model: 'gemini-2.5-flash' },
      openrouter: { apiKey: 'or_test_free', baseUrl: 'https://openrouter.ai/api/v1', model: 'openrouter/free' },
      cerebras: { apiKey: 'cer_test_free', baseUrl: 'https://api.cerebras.ai/v1', model: 'llama-3.3-70b' },
      mistral: { apiKey: 'mis_test_free', baseUrl: 'https://api.mistral.ai/v1', model: 'mistral-small-latest' },
      github: { apiKey: 'ghp_test_free', baseUrl: 'https://models.inference.ai.azure.com', model: 'gpt-4o-mini' },
      timeoutMs: 5000,
      maxRetries: 0,
      fetchImpl: mockFetch,
    });

    await router.refreshLocalOllamaModels(true);
    const ollamaInfo = router.getProviderInfo('ollama');
    expect(ollamaInfo?.configured).toBe(true);
    expect(ollamaInfo?.models).toEqual(['qwen2.5:7b', 'llama3.2:latest']);

    // Auto routing prioritizes Gemini first even when model='grok-4.7' and xAI key is present
    const autoRes = await router.createResponse({
      provider: 'auto',
      model: 'grok-4.7',
      stream: true,
      input: [{ role: 'user', content: 'Hello free world' }],
    });
    expect(autoRes.providerId).toBe('gemini');
    expect(autoRes.isFree).toBe(true);
    expect(autoRes.text).toContain('Reply from gemini-2.5-flash');
    expect(seenRequests.some((r) => r.url.startsWith('https://api.x.ai/'))).toBe(false);

    // Explicit Ollama call works with empty Authorization (keyless)
    const ollamaRes = await router.createResponse({
      provider: 'ollama',
      model: 'llama3.2:latest',
      stream: true,
      input: [{ role: 'user', content: 'Local test' }],
    });
    expect(ollamaRes.providerId).toBe('ollama');
    expect(ollamaRes.isFree).toBe(true);
    expect(ollamaRes.text).toContain('llama3.2:latest');
    const ollamaReq = seenRequests.find((r) => r.url.startsWith('http://127.0.0.1:11434/'));
    expect(ollamaReq?.auth).toBeNull();

    // Spot check Gemini, OpenRouter, Cerebras, Mistral, GitHub Models explicit selection
    for (const id of ['gemini', 'openrouter', 'cerebras', 'mistral', 'github'] as const) {
      const res = await router.createResponse({
        provider: id,
        stream: true,
        input: [{ role: 'user', content: `Ping ${id}` }],
      });
      expect(res.providerId).toBe(id);
      expect(res.isFree).toBe(true);
    }
  });

  it('serves chat SSE with $0.00 cost via Fastify server when xAI lacks credits and fails over to local Ollama', async () => {
    const config = loadServerConfig({
      APP_ENV: 'test',
      XAI_API_KEY: 'xai-no-credits-unit-test',
      AI_PROVIDER: 'auto',
      OLLAMA_ENABLED: 'true',
      OLLAMA_BASE_URL: 'http://127.0.0.1:11434/v1',
      OLLAMA_MODEL: 'qwen2.5:7b',
      DATABASE_URL: ':memory:',
      AUTH_SECRET: 'test-signing-secret-must-be-at-least-32-bytes-long',
      APP_ACCESS_PASSCODE: 'mj-free-pass',
      CORS_ORIGIN: 'http://localhost:5173',
    });

    const failingXai = new XaiResponsesClient({
      apiKey: 'xai-no-credits-unit-test',
      baseUrl: 'https://api.x.ai/v1',
      defaultModel: 'grok-4.7',
      timeoutMs: 5000,
      maxRetries: 0,
      fetchImpl: async () =>
        new Response(
          JSON.stringify({
            error: {
              code: 'permission-denied',
              message: 'Team does not have credits or licenses.',
            },
          }),
          { status: 403, headers: { 'Content-Type': 'application/json' } },
        ),
    });

    const mockFetch: typeof fetch = async (input) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
      if (url.endsWith('/api/tags')) {
        return new Response(JSON.stringify({ models: [{ name: 'qwen2.5:7b' }] }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      return createOpenAiChatSseResponse('Free local Ollama response!');
    };

    const router = new ProviderRouterClient({
      xai: { apiKey: config.xaiApiKey, baseUrl: config.xaiBaseUrl, model: config.xaiTextModel, models: config.availableModels },
      ollama: config.aiProviders.ollama,
      groq: config.aiProviders.groq,
      gemini: config.aiProviders.gemini,
      openrouter: config.aiProviders.openrouter,
      cerebras: config.aiProviders.cerebras,
      mistral: config.aiProviders.mistral,
      github: config.aiProviders.github,
      timeoutMs: 5000,
      maxRetries: 0,
      fetchImpl: mockFetch,
      xaiClientOverride: failingXai,
    });

    const ctx = await buildServer({
      config,
      xaiClient: failingXai,
      providerRouter: router,
    });
    contexts.push(ctx);

    const loginRes = await ctx.app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { passcode: 'mj-free-pass' },
    });
    const cookiePair = String(loginRes.headers['set-cookie']).split(';')[0]!;

    const settingsRes = await ctx.app.inject({
      method: 'GET',
      url: '/api/settings',
      headers: { cookie: cookiePair },
    });
    expect(settingsRes.statusCode).toBe(200);
    const settingsJson = settingsRes.json();
    expect(settingsJson.voice.availableVoiceModels).toContain('free-browser-voice');
    expect(settingsJson.providers.some((p: { id: string; configured: boolean }) => p.id === 'ollama' && p.configured)).toBe(true);

    const convRes = await ctx.app.inject({
      method: 'POST',
      url: '/api/conversations',
      headers: { cookie: cookiePair },
      payload: { title: 'Free Failover Chat' },
    });
    expect(convRes.statusCode).toBe(201);
    const convId = convRes.json().conversation.id as string;

    const msgRes = await ctx.app.inject({
      method: 'POST',
      url: `/api/conversations/${convId}/messages`,
      headers: { cookie: cookiePair },
      payload: { content: 'Say hi for free', model: 'grok-4.7' },
    });
    expect(msgRes.statusCode).toBe(200);
    expect(msgRes.body).toContain('Free local Ollama response!');

    const usageRes = await ctx.app.inject({
      method: 'GET',
      url: '/api/usage',
      headers: { cookie: cookiePair },
    });
    expect(usageRes.statusCode).toBe(200);
    const usageJson = usageRes.json();
    expect(usageJson.today.estimatedCostUsd).toBe(0);
    expect(usageJson.month.estimatedCostUsd).toBe(0);
    expect(usageJson.budgetStatus.monthlySpendUsd).toBe(0);
    expect(usageJson.today.requestCount).toBe(1);
  });

  it('supports Groq free Whisper STT directly and as voice gateway fallback', async () => {
    const calledUrls: string[] = [];
    const mockFetch: typeof fetch = async (input) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
      calledUrls.push(url);
      if (url.startsWith('https://api.x.ai/')) {
        return new Response(
          JSON.stringify({
            error: { code: 'permission-denied', message: 'credits or licenses required' },
          }),
          { status: 403, headers: { 'Content-Type': 'application/json' } },
        );
      }
      return new Response(JSON.stringify({ text: 'Assalamu alaikum MJ', language: 'bn' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    };

    const directRes = await transcribeSpeechWithGroqFree(
      { apiKey: 'gsk_test_free', fetchImpl: mockFetch },
      { audioBytes: new Uint8Array([1, 2, 3]), filename: 'clip.webm', mimeType: 'audio/webm' },
    );
    expect(directRes.text).toBe('Assalamu alaikum MJ');

    const cfg = loadServerConfig({
      APP_ENV: 'test',
      XAI_API_KEY: 'xai-empty',
      GROQ_API_KEY: 'gsk_test_free',
      DATABASE_URL: ':memory:',
      AUTH_SECRET: 'test-signing-secret-must-be-at-least-32-bytes-long',
      APP_ACCESS_PASSCODE: 'mj-pass',
    });

    const gateway = createDefaultVoiceGateway(cfg, mockFetch);
    const sttFallback = await gateway.transcribeSpeech({
      audioBytes: new Uint8Array([4, 5, 6]),
      filename: 'voice.webm',
      mimeType: 'audio/webm',
      languageMode: 'auto',
    });
    expect(sttFallback.text).toBe('Assalamu alaikum MJ');
    expect(calledUrls.some((u) => u.includes('api.groq.com/openai/v1/audio/transcriptions'))).toBe(true);
  });

  it('keeps placeholder keys only in .env.example for all free providers', () => {
    const envExample = readFileSync(resolve(process.cwd(), '.env.example'), 'utf8');
    for (const key of [
      'AI_PROVIDER=auto',
      'OLLAMA_ENABLED=true',
      'GROQ_API_KEY=',
      'GEMINI_API_KEY=',
      'OPENROUTER_API_KEY=',
      'CEREBRAS_API_KEY=',
      'MISTRAL_API_KEY=',
      'GITHUB_MODELS_TOKEN=',
    ]) {
      expect(envExample).toContain(key);
    }
    expect(envExample).not.toMatch(/gsk_[A-Za-z0-9]{15,}/);
    expect(envExample).not.toMatch(/AIza[A-Za-z0-9_-]{20,}/);
    expect(envExample).not.toMatch(/sk-or-v1-[A-Za-z0-9]{20,}/);
  });

  it('defaults active provider to gemini (gemini-2.5-flash) and prioritizes gemini -> free/local -> xai with 401/403 cooldown', async () => {
    const devCfg = loadServerConfig({
      APP_ENV: 'development',
      XAI_API_KEY: 'xai-some-key-123456',
      GEMINI_API_KEY: 'gem-primary-test',
      DATABASE_URL: ':memory:',
      AUTH_SECRET: 'test-signing-secret-must-be-at-least-32-bytes-long',
    });
    expect(devCfg.aiProviders.defaultProvider).toBe('gemini');
    expect(devCfg.aiProviders.gemini.model).toBe('gemini-2.5-flash');

    const callLog: string[] = [];
    let currentTimeMs = 1_000_000;
    let geminiShouldFail = true;

    const router = new ProviderRouterClient({
      xai: { apiKey: 'xai-paid-key', baseUrl: 'https://api.x.ai/v1', model: 'grok-4.7', models: ['grok-4.7'] },
      ollama: { enabled: true, baseUrl: 'http://127.0.0.1:11434/v1', model: 'qwen2.5:7b' },
      groq: { apiKey: 'gsk_free_key', baseUrl: 'https://api.groq.com/openai/v1', model: 'llama-3.3-70b-versatile' },
      gemini: { apiKey: 'gem_bad_or_quota', baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai', model: 'gemini-2.5-flash' },
      openrouter: { apiKey: '', baseUrl: 'https://openrouter.ai/api/v1', model: 'openrouter/free' },
      cerebras: { apiKey: '', baseUrl: 'https://api.cerebras.ai/v1', model: 'llama-3.3-70b' },
      mistral: { apiKey: '', baseUrl: 'https://api.mistral.ai/v1', model: 'mistral-small-latest' },
      github: { apiKey: '', baseUrl: 'https://models.inference.ai.azure.com', model: 'gpt-4o-mini' },
      timeoutMs: 5000,
      maxRetries: 0,
      cooldownMs: 60_000,
      nowMs: () => currentTimeMs,
      fetchImpl: async (input) => {
        const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
        if (url.endsWith('/api/tags')) {
          return new Response(JSON.stringify({ models: [{ name: 'qwen2.5:7b' }] }), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          });
        }
        callLog.push(url);

        if (url.includes('generativelanguage.googleapis.com') && geminiShouldFail) {
          return new Response(
            JSON.stringify({ error: { message: 'API key invalid / quota exceeded' } }),
            { status: 401, headers: { 'Content-Type': 'application/json' } },
          );
        }
        return createOpenAiChatSseResponse(`OK:${url}`);
      },
    });

    // (a)/(b) Gemini fails 401 -> fails over to local Ollama (before Groq & xAI)
    const firstRes = await router.createResponse({
      provider: 'auto',
      model: 'grok-4.7',
      stream: true,
      input: [{ role: 'user', content: 'Test failover' }],
    });
    expect(firstRes.providerId).toBe('ollama');
    expect(callLog.filter((u) => u.includes('generativelanguage.googleapis.com'))).toHaveLength(1);
    expect(router.isInCooldown('gemini')).toBe(true);

    // 2nd call during cooldown skips Gemini completely (zero wasted call to Gemini)
    callLog.length = 0;
    const secondRes = await router.createResponse({
      provider: 'auto',
      model: 'grok-4.7',
      stream: true,
      input: [{ role: 'user', content: 'Second turn during cooldown' }],
    });
    expect(secondRes.providerId).toBe('ollama');
    expect(callLog.some((u) => u.includes('generativelanguage.googleapis.com'))).toBe(false);

    // After cooldown expires and Gemini works again, Gemini is selected primary again
    geminiShouldFail = false;
    currentTimeMs += 61_000;
    expect(router.isInCooldown('gemini')).toBe(false);

    callLog.length = 0;
    const recoveredRes = await router.createResponse({
      provider: 'auto',
      model: 'grok-4.7',
      stream: true,
      input: [{ role: 'user', content: 'After cooldown' }],
    });
    expect(recoveredRes.providerId).toBe('gemini');
    expect(callLog).toHaveLength(1);
    expect(callLog[0]).toContain('generativelanguage.googleapis.com');
  });

  it('allows free providers even when hard_cap_reached, while blocking paid xAI, and permits localhost Ollama with externalWebServices OFF', async () => {
    const config = loadServerConfig({
      APP_ENV: 'test',
      AI_PROVIDER: 'gemini',
      GEMINI_API_KEY: 'gem-free-key-123',
      XAI_API_KEY: 'xai-paid-key-123',
      OLLAMA_ENABLED: 'true',
      OLLAMA_BASE_URL: 'http://127.0.0.1:11434/v1',
      OLLAMA_MODEL: 'qwen2.5:7b',
      DATABASE_URL: ':memory:',
      AUTH_SECRET: 'test-signing-secret-must-be-at-least-32-bytes-long',
      APP_ACCESS_PASSCODE: 'mj-pass-cap',
      CORS_ORIGIN: 'http://localhost:5173',
    });

    const mockFetch: typeof fetch = async (input) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
      if (url.endsWith('/api/tags')) {
        return new Response(JSON.stringify({ models: [{ name: 'qwen2.5:7b' }] }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      if (url.includes('127.0.0.1:11434')) {
        return createOpenAiChatSseResponse('Local Ollama offline OK');
      }
      return createOpenAiChatSseResponse('Gemini free OK');
    };

    const router = new ProviderRouterClient({
      xai: { apiKey: config.xaiApiKey, baseUrl: config.xaiBaseUrl, model: config.xaiTextModel, models: config.availableModels },
      ollama: config.aiProviders.ollama,
      groq: config.aiProviders.groq,
      gemini: config.aiProviders.gemini,
      openrouter: config.aiProviders.openrouter,
      cerebras: config.aiProviders.cerebras,
      mistral: config.aiProviders.mistral,
      github: config.aiProviders.github,
      timeoutMs: 5000,
      maxRetries: 0,
      fetchImpl: mockFetch,
    });

    const ctx = await buildServer({ config, providerRouter: router });
    contexts.push(ctx);

    const loginRes = await ctx.app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { passcode: 'mj-pass-cap' },
    });
    const cookie = String(loginRes.headers['set-cookie']).split(';')[0]!;

    const settingsRes = await ctx.app.inject({
      method: 'GET',
      url: '/api/settings',
      headers: { cookie },
    });
    expect(settingsRes.json().activeProvider).toBe('gemini');
    expect(settingsRes.json().activeModel).toBe('gemini-2.5-flash');

    // Simulate spend exceeding hard cap via recorded paid usage + low hard cap
    await ctx.repo.recordUsageLog({
      kind: 'text',
      model: 'grok-4.7',
      status: 'success',
      estimatedCostUsd: 0.05,
      latencyMs: 100,
    });
    await ctx.app.inject({
      method: 'PATCH',
      url: '/api/settings',
      headers: { cookie },
      payload: { budget: { hardCapUsd: 0.01 } },
    });

    const convRes = await ctx.app.inject({
      method: 'POST',
      url: '/api/conversations',
      headers: { cookie },
      payload: { title: 'Cap & Localhost Tests' },
    });
    const convId = convRes.json().conversation.id as string;

    // Paid explicit xAI request MUST be blocked with 429 BUDGET_EXCEEDED
    const blockedPaid = await ctx.app.inject({
      method: 'POST',
      url: `/api/conversations/${convId}/messages`,
      headers: { cookie },
      payload: { content: 'Paid turn', provider: 'xai', model: 'grok-4.7' },
    });
    expect(blockedPaid.statusCode).toBe(429);
    expect(blockedPaid.json().error.code).toBe('BUDGET_EXCEEDED');

    // (c) Free Gemini request MUST succeed despite hard_cap_reached and add $0 cost
    const freeGemini = await ctx.app.inject({
      method: 'POST',
      url: `/api/conversations/${convId}/messages`,
      headers: { cookie },
      payload: { content: 'Free Gemini turn' },
    });
    expect(freeGemini.statusCode).toBe(200);
    expect(freeGemini.body).toContain('Gemini free OK');

    const usageAfterFree = await ctx.app.inject({
      method: 'GET',
      url: '/api/usage',
      headers: { cookie },
    });
    expect(usageAfterFree.json().month.estimatedCostUsd).toBeCloseTo(0.05, 5);

    // Turn OFF externalWebServices -> external Gemini is blocked with real Gemini URL in audit log
    await ctx.app.inject({
      method: 'PATCH',
      url: '/api/privacy/permissions',
      headers: { cookie },
      payload: { key: 'externalWebServices', enabled: false },
    });

    const blockedExternalGemini = await ctx.app.inject({
      method: 'POST',
      url: `/api/conversations/${convId}/messages`,
      headers: { cookie },
      payload: { content: 'External Gemini while offline', provider: 'gemini' },
    });
    expect(blockedExternalGemini.statusCode).toBe(403);
    expect(blockedExternalGemini.json().error.code).toBe('PERMISSION_DENIED');

    const auditRes = await ctx.app.inject({
      method: 'GET',
      url: '/api/privacy/audit-log',
      headers: { cookie },
    });
    const auditEntries = auditRes.json().entries as Array<{ target: string; outcome: string }>;
    expect(
      auditEntries.some(
        (e) =>
          e.outcome === 'denied' &&
          e.target.includes('generativelanguage.googleapis.com/v1beta/openai/chat/completions'),
      ),
    ).toBe(true);

    // Localhost 127.0.0.1 Ollama MUST STILL SUCCEED even with externalWebServices OFF & hard_cap_reached
    const localOllamaOk = await ctx.app.inject({
      method: 'POST',
      url: `/api/conversations/${convId}/messages`,
      headers: { cookie },
      payload: { content: 'Local Ollama while offline', provider: 'ollama', model: 'qwen2.5:7b' },
    });
    expect(localOllamaOk.statusCode).toBe(200);
    expect(localOllamaOk.body).toContain('Local Ollama offline OK');
  });

  it('connects voice to Gemini Live, falls back to free-browser + Groq STT, and records $0 voice/STT cost', async () => {
    const geminiKey = 'gem-live-secret-do-not-leak';
    const groqKey = 'gsk_free_stt_secret';
    let geminiLiveFails = false;

    const mockVoiceFetch: typeof fetch = async (input) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
      if (url.includes('/v1alpha/auth_tokens')) {
        if (geminiLiveFails) {
          return new Response(JSON.stringify({ error: { message: 'Live quota exceeded' } }), {
            status: 429,
            headers: { 'Content-Type': 'application/json' },
          });
        }
        return new Response(JSON.stringify({ name: 'auth_tokens/live_tok_abc' }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      if (url.includes('generativelanguage.googleapis.com') && url.includes(':generateContent')) {
        if (url.includes('tts')) {
          return new Response(
            JSON.stringify({
              candidates: [
                {
                  content: {
                    parts: [
                      {
                        inlineData: {
                          mimeType: 'audio/L16;rate=24000',
                          data: Buffer.from([10, 20, 30, 40]).toString('base64'),
                        },
                      },
                    ],
                  },
                },
              ],
            }),
            { status: 200, headers: { 'Content-Type': 'application/json' } },
          );
        }
        // Fail Gemini STT so it exercises Groq Whisper fallback cleanly
        return new Response(JSON.stringify({ error: { message: 'STT overload' } }), {
          status: 503,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      if (url.includes('api.groq.com/openai/v1/audio/transcriptions')) {
        return new Response(JSON.stringify({ text: 'Hello from Groq STT', language: 'en' }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      return new Response('{}', { status: 404 });
    };

    const config = loadServerConfig({
      APP_ENV: 'test',
      GEMINI_API_KEY: geminiKey,
      GROQ_API_KEY: groqKey,
      XAI_API_KEY: 'your_xai_api_key_here',
      DATABASE_URL: ':memory:',
      AUTH_SECRET: 'test-signing-secret-must-be-at-least-32-bytes-long',
      APP_ACCESS_PASSCODE: 'mj-voice-pass',
      CORS_ORIGIN: 'http://localhost:5173',
    });

    const ctx = await buildServer({
      config,
      voiceGateway: createDefaultVoiceGateway(config, mockVoiceFetch),
    });
    contexts.push(ctx);

    const loginRes = await ctx.app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { passcode: 'mj-voice-pass' },
    });
    const cookie = String(loginRes.headers['set-cookie']).split(';')[0]!;

    // 1. Primary Gemini Live token issuance never leaks GEMINI_API_KEY
    const liveSecretRes = await ctx.app.inject({
      method: 'POST',
      url: '/api/voice/client-secret',
      headers: { cookie },
      payload: { languageMode: 'auto' },
    });
    expect(liveSecretRes.statusCode).toBe(200);
    expect(liveSecretRes.body).not.toContain(geminiKey);
    expect(liveSecretRes.json()).toMatchObject({
      token: 'auth_tokens/live_tok_abc',
      protocol: 'gemini-live',
      model: 'gemini-2.5-flash-native-audio-preview-12-2025',
    });
    expect(liveSecretRes.json().realtimeUrl).toContain('BidiGenerateContentConstrained');

    // 2. When Gemini Live fails/unavailable, seamlessly falls back to free-browser-voice
    geminiLiveFails = true;
    const fallbackRes = await ctx.app.inject({
      method: 'POST',
      url: '/api/voice/client-secret',
      headers: { cookie },
      payload: { languageMode: 'banglish' },
    });
    expect(fallbackRes.statusCode).toBe(200);
    expect(fallbackRes.json()).toMatchObject({
      protocol: 'free-browser',
      model: 'free-browser-voice',
    });

    // 3. Gemini TTS works and logs $0
    const ttsRes = await ctx.app.inject({
      method: 'POST',
      url: '/api/voice/tts',
      headers: { cookie },
      payload: { text: 'হ্যালো! আমি Gemini ভয়েস।', languageMode: 'bn' },
    });
    expect(ttsRes.statusCode).toBe(200);
    expect(ttsRes.headers['content-type']).toBe('audio/wav');

    // 4. STT falls back to Groq Whisper and records actual model + $0 cost
    const sttRes = await ctx.app.inject({
      method: 'POST',
      url: '/api/voice/stt',
      headers: { cookie },
      payload: {
        audioBase64: Buffer.from('sample-audio').toString('base64'),
        durationSeconds: 3600,
      },
    });
    expect(sttRes.statusCode).toBe(200);
    expect(sttRes.json().text).toBe('Hello from Groq STT');

    // 5. /api/voice/usage records $0 for free-browser-voice and Gemini free tier
    const freeBrowserUsage = await ctx.app.inject({
      method: 'POST',
      url: '/api/voice/usage',
      headers: { cookie },
      payload: { model: 'free-browser-voice', durationSeconds: 180, status: 'success' },
    });
    expect(freeBrowserUsage.statusCode).toBe(200);
    expect(freeBrowserUsage.json().estimatedCostUsd).toBe(0);

    const gemFreeUsage = await ctx.app.inject({
      method: 'POST',
      url: '/api/voice/usage',
      headers: { cookie },
      payload: {
        model: 'gemini-2.5-flash-native-audio-preview-12-2025',
        durationSeconds: 120,
        status: 'success',
      },
    });
    expect(gemFreeUsage.statusCode).toBe(200);
    expect(gemFreeUsage.json().estimatedCostUsd).toBe(0);

    const usageSummaryRes = await ctx.app.inject({
      method: 'GET',
      url: '/api/usage',
      headers: { cookie },
    });
    const summary = usageSummaryRes.json();
    expect(summary.month.estimatedCostUsd).toBe(0);
    expect(summary.recentEvents.some((e: { kind: string; model: string }) => e.kind === 'stt' && e.model === 'whisper-large-v3-turbo')).toBe(true);
    expect(summary.recentEvents.some((e: { kind: string; model: string }) => e.kind === 'tts' && e.model === 'gemini-2.5-flash-preview-tts')).toBe(true);
    expect(summary.recentEvents.some((e: { kind: string; model: string }) => e.kind === 'voice_realtime' && e.model === 'free-browser-voice')).toBe(true);
  });
});
