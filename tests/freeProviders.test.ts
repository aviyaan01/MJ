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

  it('extracts Gemini usageMetadata tokens and sends stream_options only for supported providers with 400 retry fallback', async () => {
    const parsedGeminiEvents = parseOpenAiChatStreamFrame({
      event: 'message',
      data: JSON.stringify({
        id: 'gem-1',
        choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
        usageMetadata: {
          promptTokenCount: 120,
          candidatesTokenCount: 45,
          thoughtsTokenCount: 15,
          cachedContentTokenCount: 30,
          totalTokenCount: 180,
        },
      }),
    });
    const completedEvent = parsedGeminiEvents.find((e) => e.type === 'completed');
    expect(completedEvent && completedEvent.type === 'completed' ? completedEvent.usage : undefined).toEqual({
      inputTokens: 120,
      outputTokens: 45,
      reasoningTokens: 15,
      cachedTokens: 30,
      totalTokens: 180,
    });

    const seenBodies: Array<Record<string, unknown>> = [];

    // 1. Gemini sends stream_options: { include_usage: true } when streaming
    const geminiClient = new XaiResponsesClient({
      apiKey: 'AIza-test-gemini',
      baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai',
      defaultModel: 'gemini-2.5-flash',
      timeoutMs: 5000,
      providerId: 'gemini',
      apiFormat: 'openai-chat',
      fetchImpl: (async (_url, init) => {
        seenBodies.push(JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>);
        return createOpenAiChatSseResponse('Hello from Gemini');
      }) as typeof fetch,
    });
    const gemRes = await geminiClient.createResponse({
      model: 'gemini-2.5-flash',
      instructions: 'Be concise.',
      input: [{ role: 'user', content: 'hi' }],
      stream: true,
    });
    expect(gemRes.text).toBe('Hello from Gemini');
    expect(seenBodies[0]?.stream_options).toEqual({ include_usage: true });

    // 2. Mistral omits stream_options
    const mistralBodies: Array<Record<string, unknown>> = [];
    const mistralClient = new XaiResponsesClient({
      apiKey: 'mistral-test-key',
      baseUrl: 'https://api.mistral.ai/v1',
      defaultModel: 'mistral-small-latest',
      timeoutMs: 5000,
      providerId: 'mistral',
      apiFormat: 'openai-chat',
      fetchImpl: (async (_url, init) => {
        mistralBodies.push(JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>);
        return createOpenAiChatSseResponse('Hello from Mistral');
      }) as typeof fetch,
    });
    const misRes = await mistralClient.createResponse({
      model: 'mistral-small-latest',
      instructions: 'Be concise.',
      input: [{ role: 'user', content: 'hi' }],
      stream: true,
    });
    expect(misRes.text).toBe('Hello from Mistral');
    expect(mistralBodies[0]?.stream_options).toBeUndefined();

    // 3. OpenAI-compat provider that rejects stream_options with 400 automatically retries without it
    const retryBodies: Array<Record<string, unknown>> = [];
    let attempt = 0;
    const retryClient = new XaiResponsesClient({
      apiKey: 'gsk-test-retry',
      baseUrl: 'https://api.groq.com/openai/v1',
      defaultModel: 'llama-3.3-70b-versatile',
      timeoutMs: 5000,
      providerId: 'groq',
      apiFormat: 'openai-chat',
      fetchImpl: (async (_url, init) => {
        attempt += 1;
        retryBodies.push(JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>);
        if (attempt === 1) {
          return new Response(
            JSON.stringify({
              error: { message: 'Extra inputs are not permitted: stream_options' },
            }),
            { status: 400, headers: { 'Content-Type': 'application/json' } },
          );
        }
        return createOpenAiChatSseResponse('Recovered after stripping stream_options');
      }) as typeof fetch,
    });
    const retryRes = await retryClient.createResponse({
      model: 'llama-3.3-70b-versatile',
      instructions: 'Be concise.',
      input: [{ role: 'user', content: 'hi' }],
      stream: true,
    });
    expect(attempt).toBe(2);
    expect(retryBodies[0]?.stream_options).toEqual({ include_usage: true });
    expect(retryBodies[1]?.stream_options).toBeUndefined();
    expect(retryRes.text).toBe('Recovered after stripping stream_options');
  });

  it('enforces FREE_ONLY_MODE=true by default across config, settingsStore, providerRouter failover, conversations, and voice STT/TTS', async () => {
    // 1. Default FREE_ONLY_MODE is true
    const defaultDev = loadServerConfig({ APP_ENV: 'development' });
    expect(defaultDev.freeOnlyMode).toBe(true);
    expect(defaultDev.availableModels).toContain('gemini-2.5-flash');
    expect(defaultDev.availableModels).toContain('gemini-2.5-flash-lite');
    expect(defaultDev.availableModels.some((m) => m.startsWith('grok-'))).toBe(false);

    // 2. ProviderRouterClient with freeOnlyMode=true allows ONLY gemini (free tier) -> ollama -> groq,
    // and never calls xAI or OpenRouter even when keys exist and primary fails
    const seenUrls: string[] = [];
    const strictRouter = new ProviderRouterClient({
      freeOnlyMode: true,
      xai: { apiKey: 'xai-paid-key', baseUrl: 'https://api.x.ai/v1', model: 'grok-4.7', models: ['grok-4.7'] },
      ollama: { enabled: true, baseUrl: 'http://127.0.0.1:11434/v1', model: 'qwen2.5:7b' },
      groq: { apiKey: 'gsk_free_key', baseUrl: 'https://api.groq.com/openai/v1', model: 'llama-3.3-70b-versatile' },
      gemini: {
        apiKey: 'AIza-free-key-1234567890123456789012345',
        baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai',
        model: 'gemini-2.5-flash-lite',
        paidTier: false,
      },
      openrouter: { apiKey: 'or-key-should-be-blocked', baseUrl: 'https://openrouter.ai/api/v1', model: 'openrouter/free' },
      cerebras: { apiKey: 'cer-key', baseUrl: 'https://api.cerebras.ai/v1', model: 'llama-3.3-70b' },
      mistral: { apiKey: 'mis-key', baseUrl: 'https://api.mistral.ai/v1', model: 'mistral-small-latest' },
      github: { apiKey: 'ghp-key', baseUrl: 'https://models.inference.ai.azure.com', model: 'gpt-4o-mini' },
      timeoutMs: 5000,
      maxRetries: 0,
      fetchImpl: async (input) => {
        const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
        if (url.endsWith('/api/tags')) {
          return new Response(JSON.stringify({ models: [{ name: 'qwen2.5:7b' }] }), { status: 200 });
        }
        seenUrls.push(url);
        if (url.includes('generativelanguage.googleapis.com') || url.includes('127.0.0.1:11434')) {
          return new Response(JSON.stringify({ error: { message: 'Temporary outage' } }), { status: 503 });
        }
        return createOpenAiChatSseResponse('Groq free failover reply');
      },
    });

    // Catalog in FREE_ONLY_MODE exposes only Gemini, Ollama, Groq
    const strictCatalog = strictRouter.listProviderCatalog().map((p) => p.id);
    expect(strictCatalog).toEqual(['gemini', 'ollama', 'groq']);

    // Auto failover goes Gemini -> Ollama -> Groq and never touches xAI or OpenRouter
    const autoFreeRes = await strictRouter.createResponse({
      provider: 'auto',
      instructions: 'Be concise.',
      input: [{ role: 'user', content: 'Test free failover' }],
      stream: true,
    });
    expect(autoFreeRes.providerId).toBe('groq');
    expect(autoFreeRes.isFree).toBe(true);
    expect(autoFreeRes.text).toBe('Groq free failover reply');
    expect(seenUrls.some((u) => u.includes('api.x.ai') || u.includes('openrouter.ai'))).toBe(false);

    // Explicit xAI or OpenRouter rejected in strict mode
    await expect(
      strictRouter.createResponse({
        provider: 'xai',
        instructions: 'Hi',
        input: [{ role: 'user', content: 'Hi' }],
        stream: true,
      }),
    ).rejects.toMatchObject({ statusCode: 403 });

    await expect(
      strictRouter.createResponse({
        provider: 'openrouter',
        instructions: 'Hi',
        input: [{ role: 'user', content: 'Hi' }],
        stream: true,
      }),
    ).rejects.toMatchObject({ statusCode: 403 });

    // Server enforcement: FREE_ONLY_MODE=true rejects paid xAI/OpenRouter in settings & chat
    const strictServerCfg = loadServerConfig({
      APP_ENV: 'test',
      FREE_ONLY_MODE: 'true',
      AI_PROVIDER: 'auto',
      XAI_API_KEY: 'xai-paid-ignored-in-free-mode',
      OPENROUTER_API_KEY: 'or-ignored-in-free-mode',
      GEMINI_API_KEY: 'AIza-free-key-1234567890123456789012345',
      GROQ_API_KEY: 'gsk_free_key',
      DATABASE_URL: ':memory:',
      AUTH_SECRET: 'test-signing-secret-must-be-at-least-32-bytes-long',
      CORS_ORIGIN: 'http://localhost:5173',
    });
    const ctx = await buildServer({ config: strictServerCfg, providerRouter: strictRouter });
    contexts.push(ctx);
    const loginRes = await ctx.app.inject({ method: 'POST', url: '/api/auth/login', payload: {} });
    const cookie = String(loginRes.headers['set-cookie']).split(';')[0]!;

    const settingsGet = await ctx.app.inject({ method: 'GET', url: '/api/settings', headers: { cookie } });
    expect(settingsGet.json().freeOnlyMode).toBe(true);
    expect(settingsGet.json().providers.map((p: { id: string }) => p.id)).toEqual(['gemini', 'ollama', 'groq']);

    const rejectSettings = await ctx.app.inject({
      method: 'PATCH',
      url: '/api/settings',
      headers: { cookie },
      payload: { activeProvider: 'xai' },
    });
    expect(rejectSettings.statusCode).toBe(403);

    const convRes = await ctx.app.inject({
      method: 'POST',
      url: '/api/conversations',
      headers: { cookie },
      payload: { title: 'Strict Free Check' },
    });
    const convId = convRes.json().conversation.id as string;

    const blockedXaiChat = await ctx.app.inject({
      method: 'POST',
      url: `/api/conversations/${convId}/messages`,
      headers: { cookie },
      payload: { content: 'Try paid', provider: 'xai' },
    });
    expect(blockedXaiChat.statusCode).toBe(403);

    // 3. Voice STT & TTS under FREE_ONLY_MODE=true when ONLY paid XAI_API_KEY exists -> blocked with 403
    const paidOnlyFreeModeCfg = loadServerConfig({
      APP_ENV: 'test',
      FREE_ONLY_MODE: 'true',
      XAI_API_KEY: 'xai-paid-only-key',
      DATABASE_URL: ':memory:',
      AUTH_SECRET: 'test-signing-secret-must-be-at-least-32-bytes-long',
      CORS_ORIGIN: 'http://localhost:5173',
    });
    const paidVoiceCtx = await buildServer({ config: paidOnlyFreeModeCfg });
    contexts.push(paidVoiceCtx);
    const l2 = await paidVoiceCtx.app.inject({ method: 'POST', url: '/api/auth/login', payload: {} });
    const c2 = String(l2.headers['set-cookie']).split(';')[0]!;

    const blockedPaidStt = await paidVoiceCtx.app.inject({
      method: 'POST',
      url: '/api/voice/stt',
      headers: { cookie: c2 },
      payload: { audioBase64: Buffer.from('abc').toString('base64'), durationSeconds: 60 },
    });
    expect(blockedPaidStt.statusCode).toBe(403);
    expect(blockedPaidStt.json().error.code).toBe('PERMISSION_DENIED');

    const blockedPaidTts = await paidVoiceCtx.app.inject({
      method: 'POST',
      url: '/api/voice/tts',
      headers: { cookie: c2 },
      payload: { text: 'Test paid TTS blocked' },
    });
    expect(blockedPaidTts.statusCode).toBe(403);
    expect(blockedPaidTts.json().error.code).toBe('PERMISSION_DENIED');

    // Client secret in FREE_ONLY_MODE never calls xAI and gracefully uses free-browser-voice when Gemini key absent
    const freeSecretRes = await paidVoiceCtx.app.inject({
      method: 'POST',
      url: '/api/voice/client-secret',
      headers: { cookie: c2 },
      payload: {},
    });
    expect(freeSecretRes.statusCode).toBe(200);
    expect(freeSecretRes.json().protocol).toBe('free-browser');
    expect(freeSecretRes.json().model).toBe('free-browser-voice');

    // 4. /api/voice/stt hard_cap_reached check (blocks paid STT with 429 BUDGET_EXCEEDED when FREE_ONLY_MODE=false)
    const paidCapCfg = loadServerConfig({
      APP_ENV: 'test',
      FREE_ONLY_MODE: 'false',
      XAI_API_KEY: 'xai-paid-stt-cap-test',
      DATABASE_URL: ':memory:',
      AUTH_SECRET: 'test-signing-secret-must-be-at-least-32-bytes-long',
      CORS_ORIGIN: 'http://localhost:5173',
    });
    const capCtx = await buildServer({ config: paidCapCfg });
    contexts.push(capCtx);
    const l3 = await capCtx.app.inject({ method: 'POST', url: '/api/auth/login', payload: {} });
    const c3 = String(l3.headers['set-cookie']).split(';')[0]!;
    await capCtx.repo.recordUsageLog({
      kind: 'stt',
      model: 'grok-voice-transcribe-2.0',
      status: 'success',
      estimatedCostUsd: 0.5,
      latencyMs: 50,
    });
    await capCtx.app.inject({
      method: 'PATCH',
      url: '/api/settings',
      headers: { cookie: c3 },
      payload: { budget: { hardCapUsd: 0.01 } },
    });
    const capBlockedStt = await capCtx.app.inject({
      method: 'POST',
      url: '/api/voice/stt',
      headers: { cookie: c3 },
      payload: { audioBase64: Buffer.from('abc').toString('base64'), durationSeconds: 60 },
    });
    expect(capBlockedStt.statusCode).toBe(429);
    expect(capBlockedStt.json().error.code).toBe('BUDGET_EXCEEDED');

    // 5. Free Groq Whisper STT still succeeds under FREE_ONLY_MODE=true + hard_cap_reached and logs $0.00
    const freeSttCfg = loadServerConfig({
      APP_ENV: 'test',
      FREE_ONLY_MODE: 'true',
      GROQ_API_KEY: 'gsk-free-stt-test-1234',
      DATABASE_URL: ':memory:',
      AUTH_SECRET: 'test-signing-secret-must-be-at-least-32-bytes-long',
      CORS_ORIGIN: 'http://localhost:5173',
    });
    const freeSttCtx = await buildServer({
      config: freeSttCfg,
      voiceGateway: createDefaultVoiceGateway(freeSttCfg, async () =>
        new Response(JSON.stringify({ text: 'Groq free STT under cap', language: 'en' }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }),
      ),
    });
    contexts.push(freeSttCtx);
    const l4 = await freeSttCtx.app.inject({ method: 'POST', url: '/api/auth/login', payload: {} });
    const c4 = String(l4.headers['set-cookie']).split(';')[0]!;
    await freeSttCtx.repo.recordUsageLog({
      kind: 'text',
      model: 'grok-4.7',
      status: 'success',
      estimatedCostUsd: 1.0,
      latencyMs: 50,
    });
    await freeSttCtx.app.inject({
      method: 'PATCH',
      url: '/api/settings',
      headers: { cookie: c4 },
      payload: { budget: { hardCapUsd: 0.01 } },
    });
    const freeSttRes = await freeSttCtx.app.inject({
      method: 'POST',
      url: '/api/voice/stt',
      headers: { cookie: c4 },
      payload: { audioBase64: Buffer.from('abc').toString('base64'), durationSeconds: 3600 },
    });
    expect(freeSttRes.statusCode).toBe(200);
    expect(freeSttRes.json().text).toBe('Groq free STT under cap');

    const usageAfterFreeStt = await freeSttCtx.app.inject({
      method: 'GET',
      url: '/api/usage',
      headers: { cookie: c4 },
    });
    expect(usageAfterFreeStt.json().month.estimatedCostUsd).toBeCloseTo(1.0, 5);
    expect(
      usageAfterFreeStt.json().recentEvents.some(
        (e: { kind: string; model: string; estimatedCostUsd: number }) =>
          e.kind === 'stt' && e.model === 'whisper-large-v3-turbo' && e.estimatedCostUsd === 0,
      ),
    ).toBe(true);
  });

  it('resets partial stream chunks with stream_reset on mid-stream failover and preserves old answer on failed regenerate', async () => {
    // 1. Mid-stream finish_reason=error parser check
    expect(() =>
      parseOpenAiChatStreamFrame({
        data: JSON.stringify({
          id: 'err_finish',
          choices: [{ index: 0, delta: {}, finish_reason: 'error' }],
        }),
      }),
    ).toThrow();

    let mode: 'failover_mid_stream' | 'all_fail' | 'clean_ok' = 'failover_mid_stream';
    const capturedMessagesPerRequest: Array<Array<{ role: string; content: string }>> = [];

    const encoder = new TextEncoder();
    const makeMidStreamFailSse = () =>
      new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(
              encoder.encode(
                `data: ${JSON.stringify({
                  id: 'gem_partial',
                  choices: [{ index: 0, delta: { content: 'Half broken Gemini text ' }, finish_reason: null }],
                })}\n\n`,
              ),
            );
            controller.enqueue(
              encoder.encode(
                `data: ${JSON.stringify({
                  error: { message: 'Mid-stream backend disconnect' },
                })}\n\n`,
              ),
            );
            controller.close();
          },
        }),
        { status: 200, headers: { 'Content-Type': 'text/event-stream' } },
      );

    const config = loadServerConfig({
      APP_ENV: 'test',
      FREE_ONLY_MODE: 'true',
      AI_PROVIDER: 'auto',
      GEMINI_API_KEY: 'AIza-stream-reset-test-key-1234567890',
      OLLAMA_ENABLED: 'true',
      OLLAMA_BASE_URL: 'http://127.0.0.1:11434/v1',
      OLLAMA_MODEL: 'qwen2.5:7b',
      DATABASE_URL: ':memory:',
      AUTH_SECRET: 'test-signing-secret-must-be-at-least-32-bytes-long',
      CORS_ORIGIN: 'http://localhost:5173',
    });

    const router = new ProviderRouterClient({
      freeOnlyMode: true,
      xai: { apiKey: '', baseUrl: 'https://api.x.ai/v1', model: 'grok-4.7', models: ['grok-4.7'] },
      ollama: config.aiProviders.ollama,
      groq: config.aiProviders.groq,
      gemini: config.aiProviders.gemini,
      openrouter: config.aiProviders.openrouter,
      cerebras: config.aiProviders.cerebras,
      mistral: config.aiProviders.mistral,
      github: config.aiProviders.github,
      timeoutMs: 5000,
      maxRetries: 0,
      fetchImpl: async (input, init) => {
        const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
        if (url.endsWith('/api/tags')) {
          return new Response(JSON.stringify({ models: [{ name: 'qwen2.5:7b' }] }), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          });
        }
        if (init?.body) {
          const parsedBody = JSON.parse(String(init.body)) as {
            messages?: Array<{ role: string; content: string }>;
          };
          if (parsedBody.messages) {
            capturedMessagesPerRequest.push(parsedBody.messages);
          }
        }
        if (mode === 'all_fail') {
          return new Response(JSON.stringify({ error: { message: 'Temporary total outage' } }), { status: 503 });
        }
        if (url.includes('generativelanguage.googleapis.com')) {
          if (mode === 'failover_mid_stream') {
            return makeMidStreamFailSse();
          }
          return createOpenAiChatSseResponse('Fresh clean answer from Gemini');
        }
        return createOpenAiChatSseResponse('Fresh clean answer from Ollama');
      },
    });

    const ctx = await buildServer({ config, providerRouter: router });
    contexts.push(ctx);
    const loginRes = await ctx.app.inject({ method: 'POST', url: '/api/auth/login', payload: {} });
    const cookie = String(loginRes.headers['set-cookie']).split(';')[0]!;

    const convRes = await ctx.app.inject({
      method: 'POST',
      url: '/api/conversations',
      headers: { cookie },
      payload: { title: 'Stream Reset & Safe Regen' },
    });
    const convId = convRes.json().conversation.id as string;

    // 2. Clean stream failover: Gemini streams partial chunk -> mid-stream error -> stream_reset -> Ollama clean response
    const chatRes = await ctx.app.inject({
      method: 'POST',
      url: `/api/conversations/${convId}/messages`,
      headers: { cookie },
      payload: { content: 'Explain zero-downtime failover.' },
    });
    expect(chatRes.statusCode).toBe(200);
    expect(chatRes.body).toContain('event: stream_reset');
    expect(chatRes.body).toContain('Fresh clean answer from Ollama');

    const afterFailoverDetail = await ctx.app.inject({
      method: 'GET',
      url: `/api/conversations/${convId}`,
      headers: { cookie },
    });
    const msgs1 = afterFailoverDetail.json().messages as Array<{ id: string; role: string; content: string; status: string }>;
    expect(msgs1).toHaveLength(2);
    const originalAssistant = msgs1[1]!;
    expect(originalAssistant.role).toBe('assistant');
    expect(originalAssistant.content).toBe('Fresh clean answer from Ollama');
    expect(originalAssistant.content).not.toContain('Half broken Gemini text');

    // 3. Safe Regenerate when ALL providers fail: original assistant message MUST stay intact
    mode = 'all_fail';
    const failedRegenRes = await ctx.app.inject({
      method: 'POST',
      url: `/api/conversations/${convId}/regenerate`,
      headers: { cookie },
      payload: {},
    });
    expect(failedRegenRes.statusCode).toBe(200);
    expect(failedRegenRes.body).toContain('event: error');
    expect(failedRegenRes.body).toContain(`"preservedMessageId":"${originalAssistant.id}"`);

    const afterFailedRegen = await ctx.app.inject({
      method: 'GET',
      url: `/api/conversations/${convId}`,
      headers: { cookie },
    });
    const msgsAfterFail = afterFailedRegen.json().messages as Array<{ id: string; role: string; content: string; status: string }>;
    expect(msgsAfterFail).toHaveLength(2);
    expect(msgsAfterFail[1]!.id).toBe(originalAssistant.id);
    expect(msgsAfterFail[1]!.content).toBe('Fresh clean answer from Ollama');
    expect(msgsAfterFail[1]!.status).toBe('completed');

    // 4. Safe Regenerate when replacement succeeds: old message deleted ONLY after replacement succeeds,
    // and contextTurns sent to model excluded old assistant reply
    mode = 'clean_ok';
    capturedMessagesPerRequest.length = 0;
    const okRegenRes = await ctx.app.inject({
      method: 'POST',
      url: `/api/conversations/${convId}/regenerate`,
      headers: { cookie },
      payload: { provider: 'ollama' },
    });
    expect(okRegenRes.statusCode).toBe(200);
    expect(okRegenRes.body).toContain(`"replacedMessageId":"${originalAssistant.id}"`);
    expect(okRegenRes.body).toContain('Fresh clean answer from Ollama');

    // Confirm old assistant turn was NOT fed back into regeneration prompt context
    expect(
      capturedMessagesPerRequest.some((turns) =>
        turns.some((t) => t.role === 'assistant'),
      ),
    ).toBe(false);

    const afterOkRegen = await ctx.app.inject({
      method: 'GET',
      url: `/api/conversations/${convId}`,
      headers: { cookie },
    });
    const finalMsgs = afterOkRegen.json().messages as Array<{ id: string; role: string; content: string }>;
    expect(finalMsgs).toHaveLength(2);
    expect(finalMsgs[1]!.id).not.toBe(originalAssistant.id);
    expect(finalMsgs[1]!.content).toBe('Fresh clean answer from Ollama');
  });

  it('hardens /health and /api/health unauthenticated output, FREE_ONLY voiceEngine readiness, VOICE_MODEL/GEMINI_VOICE_MODEL, and nginx X-Forwarded-For', async () => {
    const config = loadServerConfig({
      APP_ENV: 'test',
      AI_PROVIDER: 'auto',
      GEMINI_API_KEY: '',
      GROQ_API_KEY: '',
      OLLAMA_ENABLED: 'true',
      VOICE_MODEL: 'free-browser-voice',
      GEMINI_VOICE_MODEL: 'gemini-2.5-flash-preview-custom',
      DATABASE_URL: ':memory:',
      AUTH_SECRET: 'test-signing-secret-must-be-at-least-32-bytes-long',
      APP_ACCESS_PASSCODE: 'mj-health-lock',
      CORS_ORIGIN: 'http://localhost:5173',
    });

    // Leftover XAI_VOICE_MODEL is separated from Gemini / general VOICE_MODEL
    expect(config.xaiVoiceModel).toBe('grok-voice-latest');
    expect(config.geminiVoiceModel).toBe('gemini-2.5-flash-preview-custom');
    expect(config.voiceModel).toBe('free-browser-voice');

    const ctx = await buildServer({ config });
    contexts.push(ctx);

    // Unauthenticated /health & /api/health return minimal { status: 'ok' } with zero internal leaks
    const unauthHealth = await ctx.app.inject({ method: 'GET', url: '/health' });
    expect(unauthHealth.statusCode).toBe(200);
    expect(unauthHealth.json()).toEqual({ status: 'ok' });

    const unauthApiHealth = await ctx.app.inject({ method: 'GET', url: '/api/health' });
    expect(unauthApiHealth.statusCode).toBe(200);
    expect(unauthApiHealth.json()).toEqual({ status: 'ok' });

    // Authenticated health returns full SystemHealthDTO with voiceEngine='ready' even without XAI_API_KEY
    const loginRes = await ctx.app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { passcode: 'mj-health-lock' },
    });
    const cookie = String(loginRes.headers['set-cookie']).split(';')[0]!;

    const authApiHealth = await ctx.app.inject({
      method: 'GET',
      url: '/api/health',
      headers: { cookie },
    });
    expect(authApiHealth.statusCode).toBe(200);
    const dto = authApiHealth.json() as {
      status: string;
      database: string;
      voiceEngine: string;
      activeVoiceModel: string;
    };
    expect(dto.status).toBe('online');
    expect(dto.database).toBe('healthy');
    expect(dto.voiceEngine).toBe('ready');
    expect(dto.activeVoiceModel).toBe('free-browser-voice');

    // Also ensure voiceEngine stays 'ready' even when OLLAMA_ENABLED=false in FREE_ONLY_MODE
    const browserOnlyConfig = loadServerConfig({
      APP_ENV: 'test',
      AI_PROVIDER: 'gemini',
      GEMINI_API_KEY: '',
      GROQ_API_KEY: '',
      OLLAMA_ENABLED: 'false',
      DATABASE_URL: ':memory:',
      AUTH_SECRET: 'test-signing-secret-must-be-at-least-32-bytes-long',
      APP_ACCESS_PASSCODE: 'mj-browser-only',
      CORS_ORIGIN: 'http://localhost:5173',
    });
    const browserCtx = await buildServer({ config: browserOnlyConfig });
    contexts.push(browserCtx);
    const browserLogin = await browserCtx.app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { passcode: 'mj-browser-only' },
    });
    const browserCookie = String(browserLogin.headers['set-cookie']).split(';')[0]!;
    const browserHealth = await browserCtx.app.inject({
      method: 'GET',
      url: '/api/health',
      headers: { cookie: browserCookie },
    });
    expect(browserHealth.json().voiceEngine).toBe('ready');

    // Nginx proxy config overwrites spoofed X-Forwarded-For with $remote_addr
    const rootDir = resolve(process.cwd());
    const nginxHttps = readFileSync(resolve(rootDir, 'deploy/nginx-https.conf'), 'utf8');
    expect(nginxHttps).toContain('proxy_set_header X-Forwarded-For $remote_addr;');
    expect(nginxHttps).not.toContain('$proxy_add_x_forwarded_for');
  });
});
