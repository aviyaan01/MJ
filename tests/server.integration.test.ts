import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { XaiResponsesClient } from '@mj/ai';
import { buildServer, type MjServerContext } from '../apps/server/src/app.js';
import { loadServerConfig } from '../apps/server/src/config.js';

function createMockXaiClient(replyText = 'Hello! I am MJ Assistant.'): XaiResponsesClient {
  return new XaiResponsesClient({
    apiKey: 'xai-unit-test-only-key',
    baseUrl: 'https://api.x.ai/v1',
    defaultModel: 'grok-4.7',
    timeoutMs: 5000,
    fetchImpl: async () => {
      const encoder = new TextEncoder();
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(
            encoder.encode(
              'event: response.created\ndata: {"type":"response.created","response":{"id":"resp_int_1"}}\n\n',
            ),
          );
          controller.enqueue(
            encoder.encode(
              `event: response.output_text.delta\ndata: ${JSON.stringify({ type: 'response.output_text.delta', delta: replyText })}\n\n`,
            ),
          );
          controller.enqueue(
            encoder.encode(
              'event: response.completed\ndata: {"type":"response.completed","response":{"id":"resp_int_1","usage":{"input_tokens":30,"output_tokens":15,"output_tokens_details":{"reasoning_tokens":0},"input_tokens_details":{"cached_tokens":0},"total_tokens":45}}}\n\n',
            ),
          );
          controller.close();
        },
      });
      return new Response(stream, {
        status: 200,
        headers: { 'Content-Type': 'text/event-stream' },
      });
    },
  });
}

describe('Credential Security & Server Integration (Section 08 & 17)', () => {
  const contexts: MjServerContext[] = [];

  afterEach(async () => {
    while (contexts.length > 0) {
      const ctx = contexts.pop()!;
      await ctx.app.close();
      ctx.dbHandle.close();
    }
  });

  it('ensures .env.example has placeholders only and no live secret patterns', () => {
    const envExample = readFileSync(resolve(process.cwd(), '.env.example'), 'utf8');
    expect(envExample).toContain('XAI_API_KEY=your_xai_api_key_here');
    expect(envExample).toContain('AUTH_SECRET=replace_with_a_long_random_secret_min_32_chars');
    expect(envExample).not.toMatch(/xai-[A-Za-z0-9]{12,}/);
  });

  it('requires strong AUTH_SECRET and APP_ACCESS_PASSCODE in production', () => {
    expect(() =>
      loadServerConfig({
        APP_ENV: 'production',
        AUTH_SECRET: 'replace_with_a_long_random_secret_min_32_chars',
        APP_ACCESS_PASSCODE: 'strong-pass-123',
      }),
    ).toThrow();

    expect(() =>
      loadServerConfig({
        APP_ENV: 'production',
        AUTH_SECRET: 'a'.repeat(40),
        APP_ACCESS_PASSCODE: '',
      }),
    ).toThrow();
  });

  it('enforces HttpOnly session auth and never leaks XAI_API_KEY in API responses', async () => {
    const fakeSecretKey = 'xai-super-secret-value-never-leak-to-browser';
    const config = loadServerConfig({
      APP_ENV: 'test',
      XAI_API_KEY: fakeSecretKey,
      XAI_TEXT_MODEL: 'grok-4.7',
      DATABASE_URL: ':memory:',
      AUTH_SECRET: 'test-signing-secret-must-be-at-least-32-bytes-long',
      APP_ACCESS_PASSCODE: 'mj-pass-999',
      CORS_ORIGIN: 'http://localhost:5173',
    });

    const ctx = await buildServer({
      config,
      xaiClient: createMockXaiClient(),
    });
    contexts.push(ctx);

    // Unauthenticated access must fail with 401
    const unauthSettings = await ctx.app.inject({ method: 'GET', url: '/api/settings' });
    expect(unauthSettings.statusCode).toBe(401);

    // Wrong passcode rejected
    const badLogin = await ctx.app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { passcode: 'wrong' },
    });
    expect(badLogin.statusCode).toBe(401);

    // Valid passcode returns HttpOnly session cookie
    const goodLogin = await ctx.app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { passcode: 'mj-pass-999' },
    });
    expect(goodLogin.statusCode).toBe(200);
    const setCookieHeader = String(goodLogin.headers['set-cookie']);
    expect(setCookieHeader).toContain('HttpOnly');
    const cookiePair = setCookieHeader.split(';')[0]!;

    // Health and settings must never leak the API key
    const healthRes = await ctx.app.inject({ method: 'GET', url: '/api/health' });
    expect(healthRes.statusCode).toBe(200);
    expect(healthRes.body).not.toContain(fakeSecretKey);

    const settingsRes = await ctx.app.inject({
      method: 'GET',
      url: '/api/settings',
      headers: { cookie: cookiePair },
    });
    expect(settingsRes.statusCode).toBe(200);
    expect(settingsRes.body).not.toContain(fakeSecretKey);
    expect(settingsRes.json().apiKeyConfigured).toBe(true);

    // Untrusted cross-origin POST must be blocked
    const csrfAttempt = await ctx.app.inject({
      method: 'POST',
      url: '/api/conversations',
      headers: {
        cookie: cookiePair,
        origin: 'https://evil.example.com',
      },
      payload: { title: 'Blocked' },
    });
    expect(csrfAttempt.statusCode).toBe(403);
  });

  it('streams chat responses, persists history, regenerates, and enforces hard budget cap', async () => {
    const config = loadServerConfig({
      APP_ENV: 'test',
      XAI_API_KEY: 'xai-valid-test-key-abcdef',
      XAI_TEXT_MODEL: 'grok-4.7',
      DATABASE_URL: ':memory:',
      AUTH_SECRET: 'test-signing-secret-must-be-at-least-32-bytes-long',
      CORS_ORIGIN: 'http://localhost:5173',
    });

    const ctx = await buildServer({
      config,
      xaiClient: createMockXaiClient('Hello! What are we working on today?'),
    });
    contexts.push(ctx);

    const loginRes = await ctx.app.inject({ method: 'POST', url: '/api/auth/login', payload: {} });
    const cookiePair = String(loginRes.headers['set-cookie']).split(';')[0]!;

    const createConvRes = await ctx.app.inject({
      method: 'POST',
      url: '/api/conversations',
      headers: { cookie: cookiePair },
      payload: {},
    });
    expect(createConvRes.statusCode).toBe(201);
    const convId = createConvRes.json().conversation.id as string;

    const streamRes = await ctx.app.inject({
      method: 'POST',
      url: `/api/conversations/${convId}/messages`,
      headers: { cookie: cookiePair },
      payload: { content: 'Hey MJ' },
    });

    expect(streamRes.statusCode).toBe(200);
    expect(streamRes.headers['content-type']).toContain('text/event-stream');
    expect(streamRes.body).toContain('event: delta');
    expect(streamRes.body).toContain('Hello! What are we working on today?');
    expect(streamRes.body).toContain('event: done');

    // Verify conversation persisted both messages + auto-title
    const detailRes = await ctx.app.inject({
      method: 'GET',
      url: `/api/conversations/${convId}`,
      headers: { cookie: cookiePair },
    });
    expect(detailRes.statusCode).toBe(200);
    const detail = detailRes.json();
    expect(detail.conversation.title).toBe('Hey MJ');
    expect(detail.messages).toHaveLength(2);
    expect(detail.messages[1].content).toBe('Hello! What are we working on today?');

    // Verify regenerate replaces last assistant reply cleanly
    const regenRes = await ctx.app.inject({
      method: 'POST',
      url: `/api/conversations/${convId}/regenerate`,
      headers: { cookie: cookiePair },
      payload: {},
    });
    expect(regenRes.statusCode).toBe(200);
    const detailAfterRegen = await ctx.app.inject({
      method: 'GET',
      url: `/api/conversations/${convId}`,
      headers: { cookie: cookiePair },
    });
    expect(detailAfterRegen.json().messages).toHaveLength(2);

    // Set hard budget cap right at tiny threshold and verify enforcement
    await ctx.app.inject({
      method: 'PATCH',
      url: '/api/settings',
      headers: { cookie: cookiePair },
      payload: { budget: { hardCapUsd: 0.0001 } },
    });

    const blockedRes = await ctx.app.inject({
      method: 'POST',
      url: `/api/conversations/${convId}/messages`,
      headers: { cookie: cookiePair },
      payload: { content: 'Should fail budget cap' },
    });
    expect(blockedRes.statusCode).toBe(429);
    expect(blockedRes.json().error.code).toBe('BUDGET_EXCEEDED');
  });

  it('issues scoped ephemeral voice tokens without leaking XAI_API_KEY and shares voice turns in history', async () => {
    const permanentKey = 'xai-permanent-master-secret-do-not-leak';
    const config = loadServerConfig({
      APP_ENV: 'test',
      XAI_API_KEY: permanentKey,
      XAI_TEXT_MODEL: 'grok-4.7',
      XAI_VOICE_MODEL: 'grok-voice-latest',
      DATABASE_URL: ':memory:',
      AUTH_SECRET: 'test-signing-secret-must-be-at-least-32-bytes-long',
      CORS_ORIGIN: 'http://localhost:5173',
    });

    const ctx = await buildServer({
      config,
      xaiClient: createMockXaiClient(),
      voiceGateway: {
        createClientSecret: async () => ({
          token: 'ephemeral_client_secret_xyz',
          expiresAt: 1999999999,
        }),
        synthesizeSpeech: async () => ({
          audioBuffer: new Uint8Array([1, 2, 3]).buffer,
          contentType: 'audio/mpeg',
        }),
        listVoices: async () => [
          { id: 'ara', label: 'Ara', description: 'Warm and conversational' },
        ],
        transcribeSpeech: async () => ({ text: 'Amar ekta idea ache', language: 'bn' }),
      },
    });
    contexts.push(ctx);

    // Unauthenticated voice secret request rejected
    const unauthVoice = await ctx.app.inject({
      method: 'POST',
      url: '/api/voice/client-secret',
      payload: {},
    });
    expect(unauthVoice.statusCode).toBe(401);

    const loginRes = await ctx.app.inject({ method: 'POST', url: '/api/auth/login', payload: {} });
    const cookiePair = String(loginRes.headers['set-cookie']).split(';')[0]!;

    // Create conversation & persist Banglish voice turns
    const convRes = await ctx.app.inject({
      method: 'POST',
      url: '/api/conversations',
      headers: { cookie: cookiePair },
      payload: {},
    });
    const convId = convRes.json().conversation.id as string;

    const userTurnRes = await ctx.app.inject({
      method: 'POST',
      url: `/api/conversations/${convId}/voice-turns`,
      headers: { cookie: cookiePair },
      payload: { role: 'user', content: 'MJ, amar laptop slow kaj kortese' },
    });
    expect(userTurnRes.statusCode).toBe(201);
    expect(userTurnRes.json().message.channel).toBe('voice');
    expect(userTurnRes.json().conversation.title).toBe('MJ, amar laptop slow kaj kortese');

    // Request ephemeral token bound to conversation context
    const secretRes = await ctx.app.inject({
      method: 'POST',
      url: '/api/voice/client-secret',
      headers: { cookie: cookiePair },
      payload: { conversationId: convId, languageMode: 'auto' },
    });
    expect(secretRes.statusCode).toBe(200);
    expect(secretRes.body).not.toContain(permanentKey);

    const secretJson = secretRes.json();
    expect(secretJson.token).toBe('ephemeral_client_secret_xyz');
    expect(secretJson.realtimeUrl).toBe('wss://api.x.ai/v1/realtime');
    expect(secretJson.model).toBe('grok-voice-latest');
    expect(secretJson.instructions).toContain('MJ, amar laptop slow kaj kortese');

    // Record voice session duration & verify usage summary
    const usageLogRes = await ctx.app.inject({
      method: 'POST',
      url: '/api/voice/usage',
      headers: { cookie: cookiePair },
      payload: {
        conversationId: convId,
        model: 'grok-voice-latest',
        durationSeconds: 120,
        status: 'success',
      },
    });
    expect(usageLogRes.statusCode).toBe(200);
    expect(usageLogRes.json().estimatedCostUsd).toBeCloseTo(0.1, 4);

    const usageRes = await ctx.app.inject({
      method: 'GET',
      url: '/api/usage',
      headers: { cookie: cookiePair },
    });
    expect(usageRes.json().today.voiceSeconds).toBe(120);

    // TTS endpoint works cleanly
    const ttsRes = await ctx.app.inject({
      method: 'POST',
      url: '/api/voice/tts',
      headers: { cookie: cookiePair },
      payload: { text: 'হ্যালো! আমি MJ Assistant।', languageMode: 'bn' },
    });
    expect(ttsRes.statusCode).toBe(200);
    expect(ttsRes.headers['content-type']).toBe('audio/mpeg');
  });
});
