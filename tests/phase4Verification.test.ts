import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ProviderRouterClient } from '@mj/ai';
import {
  ErrorCodes,
  isApprovedHttpsUrl,
  isForbiddenShellTarget,
  isValidApprovedExecutablePath,
  normalizeWebDomainTarget,
} from '@mj/shared';
import { buildServer, type MjServerContext } from '../apps/server/src/app.js';
import { loadServerConfig } from '../apps/server/src/config.js';
import { createDefaultVoiceGateway } from '../apps/server/src/routes/voice.js';

function createOpenAiChatSse(replyText: string, id = 'chatcmpl_p4'): Response {
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
            usage: { prompt_tokens: 12, completion_tokens: 6, total_tokens: 18 },
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

function createMidStreamFailSse(partialText: string, id = 'chatcmpl_partial'): Response {
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(
        encoder.encode(
          `data: ${JSON.stringify({
            id,
            choices: [{ index: 0, delta: { content: partialText }, finish_reason: null }],
          })}\n\n`,
        ),
      );
      controller.enqueue(
        encoder.encode(
          `data: ${JSON.stringify({
            id,
            choices: [{ index: 0, delta: {}, finish_reason: 'error' }],
          })}\n\n`,
        ),
      );
      controller.close();
    },
  });
  return new Response(stream, {
    status: 200,
    headers: { 'Content-Type': 'text/event-stream' },
  });
}

describe('Phase 4 Security, Reliability, Health & Repo Hygiene Verification', () => {
  const contexts: MjServerContext[] = [];

  afterEach(async () => {
    while (contexts.length > 0) {
      const ctx = contexts.pop()!;
      await ctx.app.close();
      ctx.dbHandle.close();
    }
  });

  it('(a) blocks URL parser backslash authority confusion, userinfo, and scheme bypasses', () => {
    const approved = ['approved.com', 'docs.google.com'];

    expect(isApprovedHttpsUrl('https://evil.com\\.approved.com/', approved)).toBeNull();
    expect(isApprovedHttpsUrl('https://sub.approved.com\\@evil.com/path', approved)).toBeNull();
    expect(isApprovedHttpsUrl('https://approved.com@evil.com/', approved)).toBeNull();
    expect(isApprovedHttpsUrl('http://approved.com/', approved)).toBeNull();
    expect(isApprovedHttpsUrl('javascript:alert(1)', approved)).toBeNull();
    expect(isApprovedHttpsUrl('https://notapproved.com/', approved)).toBeNull();

    expect(normalizeWebDomainTarget('evil.com\\.approved.com')).toBeNull();
    expect(normalizeWebDomainTarget('approved.com@evil.com')).toBeNull();
    expect(normalizeWebDomainTarget('*.approved.com')).toBeNull();

    expect(isApprovedHttpsUrl('https://approved.com/chat', approved)).toBe(
      'https://approved.com/chat',
    );
    expect(isApprovedHttpsUrl('https://sub.approved.com/docs', approved)).toBe(
      'https://sub.approved.com/docs',
    );
  });

  it('(b) blocks .bat scripts, non-.exe files, relative paths, and LOLBins in executable checks and validate-action', async () => {
    for (const badTarget of [
      'C:\\Tools\\run.bat',
      'C:\\Tools\\deploy.cmd',
      'C:\\Tools\\script.ps1',
      'C:\\Tools\\macro.vbs',
      'C:\\Tools\\legacy.com',
      'C:\\Tools\\README.txt',
      'C:\\Tools\\extensionless_binary',
      'notepad.exe',
      '\\\\evil-share\\tools\\app.exe',
      'C:\\Tools\\app.exe | whoami',
      'C:\\Python312\\python.exe',
      'C:\\Windows\\System32\\cmd.exe',
    ]) {
      expect(isValidApprovedExecutablePath(badTarget)).toBe(false);
    }
    expect(isForbiddenShellTarget('C:\\Tools\\run.bat')).toBe(true);
    expect(isValidApprovedExecutablePath('C:\\Users\\ASUS\\Apps\\Code.exe')).toBe(true);

    const config = loadServerConfig({
      APP_ENV: 'test',
      DATABASE_URL: ':memory:',
      AUTH_SECRET: 'test-signing-secret-must-be-at-least-32-bytes-long',
      CORS_ORIGIN: 'http://localhost:5173',
    });
    const ctx = await buildServer({ config });
    contexts.push(ctx);
    const loginRes = await ctx.app.inject({ method: 'POST', url: '/api/auth/login', payload: {} });
    const cookie = String(loginRes.headers['set-cookie']).split(';')[0]!;

    await ctx.app.inject({
      method: 'PATCH',
      url: '/api/privacy/permissions',
      headers: { cookie },
      payload: { key: 'appOpening', enabled: true },
    });

    const batRes = await ctx.app.inject({
      method: 'POST',
      url: '/api/desktop/validate-action',
      headers: { cookie },
      payload: {
        capability: 'appOpening',
        action: 'Launch script',
        target: 'C:\\Tools\\run.bat',
      },
    });
    expect(batRes.statusCode).toBe(403);
    expect(batRes.json().error.code).toBe(ErrorCodes.SHELL_EXECUTION_FORBIDDEN);

    const nonExeRes = await ctx.app.inject({
      method: 'POST',
      url: '/api/desktop/validate-action',
      headers: { cookie },
      payload: {
        capability: 'appOpening',
        action: 'Launch document',
        target: 'C:\\Tools\\notes.txt',
      },
    });
    expect(nonExeRes.statusCode).toBe(403);
    expect(nonExeRes.json().error.code).toBe(ErrorCodes.UNAPPROVED_TARGET);
  });

  it('(c) enforces FREE_ONLY_MODE and hard-cap budget blocks on /api/voice/stt', async () => {
    // 1. FREE_ONLY_MODE=true blocks paid-only xAI STT with 403 PERMISSION_DENIED
    const freeOnlyPaidKeyCfg = loadServerConfig({
      APP_ENV: 'test',
      FREE_ONLY_MODE: 'true',
      XAI_API_KEY: 'xai-paid-only-blocked',
      GEMINI_API_KEY: '',
      GROQ_API_KEY: '',
      DATABASE_URL: ':memory:',
      AUTH_SECRET: 'test-signing-secret-must-be-at-least-32-bytes-long',
      CORS_ORIGIN: 'http://localhost:5173',
    });
    const ctx1 = await buildServer({ config: freeOnlyPaidKeyCfg });
    contexts.push(ctx1);
    const l1 = await ctx1.app.inject({ method: 'POST', url: '/api/auth/login', payload: {} });
    const c1 = String(l1.headers['set-cookie']).split(';')[0]!;

    const freeOnlyBlocked = await ctx1.app.inject({
      method: 'POST',
      url: '/api/voice/stt',
      headers: { cookie: c1 },
      payload: { audioBase64: Buffer.from('audio').toString('base64'), durationSeconds: 15 },
    });
    expect(freeOnlyBlocked.statusCode).toBe(403);
    expect(freeOnlyBlocked.json().error.code).toBe(ErrorCodes.PERMISSION_DENIED);

    // 2. FREE_ONLY_MODE=false enforces hard_cap_reached on /api/voice/stt with 429 BUDGET_EXCEEDED
    const paidCapCfg = loadServerConfig({
      APP_ENV: 'test',
      FREE_ONLY_MODE: 'false',
      XAI_API_KEY: 'xai-paid-stt-cap-test',
      GEMINI_API_KEY: '',
      GROQ_API_KEY: '',
      DATABASE_URL: ':memory:',
      AUTH_SECRET: 'test-signing-secret-must-be-at-least-32-bytes-long',
      CORS_ORIGIN: 'http://localhost:5173',
    });
    const ctx2 = await buildServer({ config: paidCapCfg });
    contexts.push(ctx2);
    const l2 = await ctx2.app.inject({ method: 'POST', url: '/api/auth/login', payload: {} });
    const c2 = String(l2.headers['set-cookie']).split(';')[0]!;
    await ctx2.repo.recordUsageLog({
      kind: 'stt',
      model: 'grok-voice-transcribe-2.0',
      status: 'success',
      estimatedCostUsd: 0.75,
      latencyMs: 30,
    });
    await ctx2.app.inject({
      method: 'PATCH',
      url: '/api/settings',
      headers: { cookie: c2 },
      payload: { budget: { hardCapUsd: 0.1 } },
    });

    const budgetBlocked = await ctx2.app.inject({
      method: 'POST',
      url: '/api/voice/stt',
      headers: { cookie: c2 },
      payload: { audioBase64: Buffer.from('audio').toString('base64'), durationSeconds: 60 },
    });
    expect(budgetBlocked.statusCode).toBe(429);
    expect(budgetBlocked.json().error.code).toBe(ErrorCodes.BUDGET_EXCEEDED);

    // 3. Free Groq Whisper STT succeeds with $0.00 cost even under FREE_ONLY_MODE=true + hard_cap_reached
    const freeSttCfg = loadServerConfig({
      APP_ENV: 'test',
      FREE_ONLY_MODE: 'true',
      GROQ_API_KEY: 'gsk-phase4-free-stt',
      DATABASE_URL: ':memory:',
      AUTH_SECRET: 'test-signing-secret-must-be-at-least-32-bytes-long',
      CORS_ORIGIN: 'http://localhost:5173',
    });
    const ctx3 = await buildServer({
      config: freeSttCfg,
      voiceGateway: createDefaultVoiceGateway(freeSttCfg, async () =>
        new Response(JSON.stringify({ text: 'Free Groq STT ok', language: 'en' }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }),
      ),
    });
    contexts.push(ctx3);
    const l3 = await ctx3.app.inject({ method: 'POST', url: '/api/auth/login', payload: {} });
    const c3 = String(l3.headers['set-cookie']).split(';')[0]!;
    await ctx3.repo.recordUsageLog({
      kind: 'stt',
      model: 'grok-voice-transcribe-2.0',
      status: 'success',
      estimatedCostUsd: 0.75,
      latencyMs: 30,
    });
    await ctx3.app.inject({
      method: 'PATCH',
      url: '/api/settings',
      headers: { cookie: c3 },
      payload: { budget: { hardCapUsd: 0.1 } },
    });
    const freeSttOk = await ctx3.app.inject({
      method: 'POST',
      url: '/api/voice/stt',
      headers: { cookie: c3 },
      payload: { audioBase64: Buffer.from('audio').toString('base64'), durationSeconds: 120 },
    });
    expect(freeSttOk.statusCode).toBe(200);
    expect(freeSttOk.json().text).toBe('Free Groq STT ok');
  });

  it('(d) emits stream_reset with clean failover response and (e) preserves old assistant message on failed regenerate', async () => {
    const config = loadServerConfig({
      APP_ENV: 'test',
      AI_PROVIDER: 'auto',
      GEMINI_API_KEY: 'gem-key-phase4-1234',
      OLLAMA_ENABLED: 'true',
      OLLAMA_BASE_URL: 'http://127.0.0.1:11434/v1',
      OLLAMA_MODEL: 'qwen2.5:7b',
      DATABASE_URL: ':memory:',
      AUTH_SECRET: 'test-signing-secret-must-be-at-least-32-bytes-long',
      CORS_ORIGIN: 'http://localhost:5173',
    });

    let failMode: 'failover' | 'all_fail' = 'failover';
    const router = new ProviderRouterClient({
      freeOnlyMode: true,
      xai: { apiKey: '', baseUrl: config.xaiBaseUrl, model: config.xaiTextModel, models: [] },
      ollama: config.aiProviders.ollama,
      groq: config.aiProviders.groq,
      gemini: config.aiProviders.gemini,
      openrouter: config.aiProviders.openrouter,
      cerebras: config.aiProviders.cerebras,
      mistral: config.aiProviders.mistral,
      github: config.aiProviders.github,
      timeoutMs: 5000,
      maxRetries: 0,
      fetchImpl: async (input) => {
        const url =
          typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
        if (url.endsWith('/api/tags')) {
          return new Response(JSON.stringify({ models: [{ name: 'qwen2.5:7b' }] }), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          });
        }
        if (failMode === 'all_fail') {
          return new Response(JSON.stringify({ error: { message: 'All providers down' } }), {
            status: 503,
            headers: { 'Content-Type': 'application/json' },
          });
        }
        if (url.includes('generativelanguage.googleapis.com')) {
          return createMidStreamFailSse('Corrupted half answer...');
        }
        return createOpenAiChatSse('Clean Ollama recovery');
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
      payload: { title: 'Phase 4 Stream Reset & Regen' },
    });
    const convId = convRes.json().conversation.id as string;

    // (d) Stream failover emits stream_reset and persists only the failover answer
    const msgRes = await ctx.app.inject({
      method: 'POST',
      url: `/api/conversations/${convId}/messages`,
      headers: { cookie },
      payload: { content: 'Trigger mid-stream failover' },
    });
    expect(msgRes.statusCode).toBe(200);
    expect(msgRes.body).toContain('event: stream_reset');
    expect(msgRes.body).toContain('Clean Ollama recovery');

    const detail1 = await ctx.app.inject({
      method: 'GET',
      url: `/api/conversations/${convId}`,
      headers: { cookie },
    });
    const msgs1 = detail1.json().messages as Array<{ id: string; content: string; status: string }>;
    expect(msgs1).toHaveLength(2);
    const savedReply = msgs1[1]!;
    expect(savedReply.content).toBe('Clean Ollama recovery');
    expect(savedReply.content).not.toContain('Corrupted half answer');

    // (e) Failed regenerate preserves original assistant message intact
    failMode = 'all_fail';
    const regenRes = await ctx.app.inject({
      method: 'POST',
      url: `/api/conversations/${convId}/regenerate`,
      headers: { cookie },
      payload: {},
    });
    expect(regenRes.statusCode).toBe(200);
    expect(regenRes.body).toContain('event: error');
    expect(regenRes.body).toContain(`"preservedMessageId":"${savedReply.id}"`);

    const detail2 = await ctx.app.inject({
      method: 'GET',
      url: `/api/conversations/${convId}`,
      headers: { cookie },
    });
    const msgs2 = detail2.json().messages as Array<{ id: string; content: string; status: string }>;
    expect(msgs2).toHaveLength(2);
    expect(msgs2[1]!.id).toBe(savedReply.id);
    expect(msgs2[1]!.content).toBe('Clean Ollama recovery');
    expect(msgs2[1]!.status).toBe('completed');
  });

  it('(f) returns minimal { status } JSON on unauthenticated /health and /api/health without leaking internals', async () => {
    const config = loadServerConfig({
      APP_ENV: 'test',
      GEMINI_API_KEY: 'gem-health-secret-key',
      DATABASE_URL: ':memory:',
      AUTH_SECRET: 'test-signing-secret-must-be-at-least-32-bytes-long',
      APP_ACCESS_PASSCODE: 'mj-health-secret-pass',
      CORS_ORIGIN: 'http://localhost:5173',
    });
    const ctx = await buildServer({ config });
    contexts.push(ctx);

    const h1 = await ctx.app.inject({ method: 'GET', url: '/health' });
    expect(h1.statusCode).toBe(200);
    expect(Object.keys(h1.json())).toEqual(['status']);
    expect(h1.json()).toEqual({ status: 'ok' });

    const h2 = await ctx.app.inject({ method: 'GET', url: '/api/health' });
    expect(h2.statusCode).toBe(200);
    expect(Object.keys(h2.json())).toEqual(['status']);
    expect(h2.json()).toEqual({ status: 'ok' });

    const origPing = ctx.dbHandle.ping;
    ctx.dbHandle.ping = () => false;
    try {
      const failUnauth = await ctx.app.inject({ method: 'GET', url: '/health' });
      expect(failUnauth.statusCode).toBe(503);
      expect(Object.keys(failUnauth.json())).toEqual(['status']);
      expect(failUnauth.json()).toEqual({ status: 'error' });
    } finally {
      ctx.dbHandle.ping = origPing;
    }

    const loginRes = await ctx.app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { passcode: 'mj-health-secret-pass' },
    });
    const cookie = String(loginRes.headers['set-cookie']).split(';')[0]!;
    const hAuth = await ctx.app.inject({
      method: 'GET',
      url: '/api/health',
      headers: { cookie },
    });
    expect(hAuth.statusCode).toBe(200);
    expect(hAuth.json()).toMatchObject({
      status: 'online',
      database: 'healthy',
      aiEngine: 'ready',
      voiceEngine: 'ready',
    });
  });

  it('keeps .agents/skills as the single tracked source, checks .claude/skills link only when present, and aligns Node >=22', () => {
    const rootDir = resolve(process.cwd());
    const agentsSkills = resolve(rootDir, '.agents', 'skills');
    const claudeSkills = resolve(rootDir, '.claude', 'skills');
    const staleAgentDir = resolve(rootDir, 'agent');

    expect(existsSync(agentsSkills)).toBe(true);
    expect(existsSync(staleAgentDir)).toBe(false);

    if (existsSync(claudeSkills)) {
      expect(realpathSync(claudeSkills)).toBe(realpathSync(agentsSkills));
    }

    if (existsSync(resolve(rootDir, '.git'))) {
      const duplicateTracked = execFileSync(
        'git',
        ['ls-files', '.claude/skills', 'agent'],
        { cwd: rootDir, encoding: 'utf8' },
      ).trim();
      expect(duplicateTracked).toBe('');

      const canonicalTracked = execFileSync(
        'git',
        ['ls-files', '.agents/skills'],
        { cwd: rootDir, encoding: 'utf8' },
      ).trim();
      expect(canonicalTracked.length).toBeGreaterThan(0);
    }

    const gitignore = readFileSync(resolve(rootDir, '.gitignore'), 'utf8');
    expect(gitignore).toContain('.claude/skills');

    const pkg = JSON.parse(readFileSync(resolve(rootDir, 'package.json'), 'utf8')) as {
      engines?: { node?: string };
      scripts?: Record<string, string>;
    };
    expect(pkg.engines?.node).toBe('>=22');
    expect(pkg.scripts?.['setup:skills']).toBe('node scripts/setup-skills.mjs');

    const readme = readFileSync(resolve(rootDir, 'README.md'), 'utf8');
    expect(readme).toContain('Node.js >= 22');
    expect(readme).toContain('npm run setup:skills');
  });
});
