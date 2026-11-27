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

    // Auto routing with a grok model fails over seamlessly to Groq ($0) when xAI returns 403 credits error
    const autoRes = await router.createResponse({
      provider: 'auto',
      model: 'grok-4.7',
      stream: true,
      input: [{ role: 'user', content: 'Hello free world' }],
    });
    expect(autoRes.providerId).toBe('groq');
    expect(autoRes.isFree).toBe(true);
    expect(autoRes.text).toContain('Reply from llama-3.3-70b-versatile');

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
});
