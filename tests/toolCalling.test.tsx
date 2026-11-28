import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it } from 'vitest';
import {
  DEFAULT_PERMISSIONS_STATE,
  ErrorCodes,
  UpdateSinglePermissionSchema,
  parseVoiceConfirmationDecision,
  type PendingToolConfirmationDTO,
} from '@mj/shared';
import {
  XaiResponsesClient,
  createDefaultToolRegistry,
  executeToolCallSafely,
} from '@mj/ai';
import { MjVoiceService, buildGeminiLiveSetupPayload } from '@mj/voice';
import { buildServer, type MjServerContext } from '../apps/server/src/app.js';
import { loadServerConfig } from '../apps/server/src/config.js';
import type { VoiceGateway } from '../apps/server/src/routes/voice.js';
import { PrivacyCenterView } from '../apps/web/src/components/PrivacyCenterView.js';
import { ToolConfirmationBanner } from '../apps/web/src/components/ToolConfirmationBanner.js';

function sseStreamFromChunks(chunks: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) {
        controller.enqueue(encoder.encode(chunk));
      }
      controller.close();
    },
  });
}

async function createAuthedServer(options?: {
  geminiClient?: XaiResponsesClient;
  toolConfirmationTimeoutMs?: number;
}): Promise<{ ctx: MjServerContext; cookie: string }> {
  const config = loadServerConfig({
    APP_ENV: 'test',
    FREE_ONLY_MODE: 'true',
    GEMINI_API_KEY: 'gemini-test-key-123456',
    GEMINI_TEXT_MODEL: 'gemini-2.5-flash',
    DATABASE_URL: ':memory:',
    AUTH_SECRET: 'test-signing-secret-must-be-at-least-32-bytes-long',
    CORS_ORIGIN: 'http://localhost:5173',
  });

  const mockVoiceGateway: VoiceGateway = {
    createClientSecret: async () => ({
      token: 'ephemeral-gemini-live-token',
      expiresAt: Math.floor(Date.now() / 1000) + 300,
      protocol: 'gemini-live',
      realtimeUrl:
        'wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1alpha.GenerativeService.BidiGenerateContentConstrained',
      model: 'gemini-2.5-flash-native-audio-preview-12-2025',
    }),
    synthesizeSpeech: async () => ({
      audio: new Uint8Array([1, 2, 3]).buffer,
      contentType: 'audio/mpeg',
      modelUsed: 'gemini-tts',
      isFree: true,
    }),
    listVoices: async () => [{ id: 'Aoede', label: 'Aoede (Female · Default)', description: 'Warm' }],
    transcribeSpeech: async () => ({ text: 'ok', modelUsed: 'gemini-stt', isFree: true }),
  };

  const ctx = await buildServer({
    config,
    voiceGateway: mockVoiceGateway,
    toolConfirmationTimeoutMs: options?.toolConfirmationTimeoutMs,
    ...(options?.geminiClient ? { xaiClient: options.geminiClient } : {}),
  });

  if (options?.geminiClient) {
    // Wire our mock Gemini OpenAI-compat client into the router's gemini entry too
    const internal = ctx.providerRouter as unknown as {
      entries: Map<string, { client: XaiResponsesClient }>;
    };
    const geminiEntry = internal.entries.get('gemini');
    if (geminiEntry) {
      geminiEntry.client = options.geminiClient;
    }
  }

  const loginRes = await ctx.app.inject({ method: 'POST', url: '/api/auth/login', payload: {} });
  const cookie = String(loginRes.headers['set-cookie']).split(';')[0]!;
  return { ctx, cookie };
}

describe('Safe Gemini Function Calling & Permissions Gate', () => {
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

  it('ships toolCalling OFF by default, exposes Zod-derived schemas, and hides blocked tools', () => {
    expect(DEFAULT_PERMISSIONS_STATE.toolCalling).toBe(false);
    expect(
      UpdateSinglePermissionSchema.safeParse({ key: 'toolCalling', enabled: true }).success,
    ).toBe(true);

    const registry = createDefaultToolRegistry();
    expect(registry.toOpenAiTools(DEFAULT_PERMISSIONS_STATE)).toEqual([]);
    expect(registry.toGeminiLiveFunctionDeclarations(DEFAULT_PERMISSIONS_STATE)).toEqual([]);

    const enabledPerms = {
      ...DEFAULT_PERMISSIONS_STATE,
      toolCalling: true,
      systemMonitoring: true,
      fileWrite: true,
    };
    const openAiTools = registry.toOpenAiTools(enabledPerms);
    const liveDecls = registry.toGeminiLiveFunctionDeclarations(enabledPerms);

    const openAiNames = openAiTools.map((t) => t.function.name);
    expect(openAiNames).toContain('get_current_time');
    expect(openAiNames).toContain('get_system_status');
    expect(openAiNames).toContain('write_approved_note');
    expect(openAiNames).not.toContain('open_approved_app'); // appOpening is still OFF
    expect(openAiNames).not.toContain('run_shell_command'); // blocked tools never exposed

    const writeLiveDecl = liveDecls.find((d) => d.name === 'write_approved_note') as
      | { parameters?: Record<string, unknown> }
      | undefined;
    expect(writeLiveDecl?.parameters?.type).toBe('OBJECT');
    expect(writeLiveDecl?.parameters?.$schema).toBeUndefined();
    expect(writeLiveDecl?.parameters?.additionalProperties).toBeUndefined();
  });

  it('parses Bangla, English, Hindi, Banglish, and Hinglish voice confirmations safely', () => {
    expect(parseVoiceConfirmationDecision('yes')).toBe('approve');
    expect(parseVoiceConfirmationDecision('haan')).toBe('approve');
    expect(parseVoiceConfirmationDecision('ha')).toBe('approve');
    expect(parseVoiceConfirmationDecision('করো')).toBe('approve');
    expect(parseVoiceConfirmationDecision('হ্যাঁ, করে দাও')).toBe('approve');
    expect(parseVoiceConfirmationDecision('हाँ')).toBe('approve');
    expect(parseVoiceConfirmationDecision('हां करो')).toBe('approve');

    expect(parseVoiceConfirmationDecision('no')).toBe('cancel');
    expect(parseVoiceConfirmationDecision('na')).toBe('cancel');
    expect(parseVoiceConfirmationDecision('না')).toBe('cancel');
    expect(parseVoiceConfirmationDecision('করো না')).toBe('cancel');
    expect(parseVoiceConfirmationDecision('नहीं')).toBe('cancel');
    expect(parseVoiceConfirmationDecision('मत करो')).toBe('cancel');

    expect(parseVoiceConfirmationDecision('what is the weather right now')).toBeNull();
  });

  it('denies tool execution when OFF and rejects unknown or blocked tool names with audit logs', async () => {
    const { ctx, cookie } = await createAuthedServer();
    contexts.push(ctx);

    // 1. toolCalling starts OFF -> /api/tools/list reflects false & health reflects tools:false
    const healthRes = await ctx.app.inject({
      method: 'GET',
      url: '/api/health',
      headers: { cookie },
    });
    expect(healthRes.json().features.tools).toBe(false);

    // Executing safe tool while toolCalling is OFF is denied and audited
    const deniedOff = await ctx.app.inject({
      method: 'POST',
      url: '/api/voice/tools/execute',
      headers: { cookie },
      payload: { name: 'get_current_time', args: {} },
    });
    expect(deniedOff.statusCode).toBe(200);
    expect(deniedOff.json().ok).toBe(false);
    expect(deniedOff.json().status).toBe('denied');

    // Enable toolCalling ONLY (systemMonitoring remains OFF)
    await ctx.app.inject({
      method: 'PATCH',
      url: '/api/privacy/permissions',
      headers: { cookie },
      payload: { key: 'toolCalling', enabled: true },
    });

    // Safe tool requiring only toolCalling now runs and returns real host time
    const timeOk = await ctx.app.inject({
      method: 'POST',
      url: '/api/voice/tools/execute',
      headers: { cookie },
      payload: { name: 'get_current_time', args: { timeZone: 'UTC' } },
    });
    expect(timeOk.json().ok).toBe(true);
    expect(timeOk.json().status).toBe('executed');
    expect(typeof timeOk.json().result.iso).toBe('string');

    // Tool requiring systemMonitoring is STILL denied while systemMonitoring=false
    const sysDenied = await ctx.app.inject({
      method: 'POST',
      url: '/api/voice/tools/execute',
      headers: { cookie },
      payload: { name: 'get_system_status', args: {} },
    });
    expect(sysDenied.json().ok).toBe(false);
    expect(sysDenied.json().status).toBe('denied');

    // Unknown tool hallucinated by model MUST be denied and logged
    const unknownRes = await ctx.app.inject({
      method: 'POST',
      url: '/api/voice/tools/execute',
      headers: { cookie },
      payload: { name: 'exfiltrate_secrets', args: { target: 'all' } },
    });
    expect(unknownRes.json().ok).toBe(false);
    expect(unknownRes.json().status).toBe('denied');

    // Explicitly registered blocked tool MUST be denied and logged
    const blockedRes = await ctx.app.inject({
      method: 'POST',
      url: '/api/voice/tools/execute',
      headers: { cookie },
      payload: { name: 'run_shell_command', args: { command: 'whoami' } },
    });
    expect(blockedRes.json().ok).toBe(false);
    expect(blockedRes.json().status).toBe('denied');
    expect(blockedRes.json().errorCode).toBe(ErrorCodes.SHELL_EXECUTION_FORBIDDEN);

    const auditRes = await ctx.app.inject({
      method: 'GET',
      url: '/api/privacy/audit-log',
      headers: { cookie },
    });
    const logs = auditRes.json().entries as Array<{
      capability: string;
      action: string;
      target: string;
      outcome: string;
    }>;
    expect(logs.some((e) => e.outcome === 'allowed' && e.action.includes('get_current_time'))).toBe(
      true,
    );
    expect(
      logs.some((e) => e.outcome === 'denied' && e.target === 'exfiltrate_secrets'),
    ).toBe(true);
    expect(logs.some((e) => e.outcome === 'denied' && e.target === 'whoami')).toBe(true);
  });

  it('enforces confirm flow with Bangla/English/Hindi voice accept/cancel and 20s timeout', async () => {
    const allowedDir = mkdtempSync(join(tmpdir(), 'mj-tools-confirm-'));
    tempDirs.push(allowedDir);

    const { ctx, cookie } = await createAuthedServer({
      toolConfirmationTimeoutMs: 70,
    });
    contexts.push(ctx);

    await ctx.app.inject({
      method: 'PATCH',
      url: '/api/privacy/permissions',
      headers: { cookie },
      payload: { key: 'toolCalling', enabled: true },
    });
    await ctx.app.inject({
      method: 'PATCH',
      url: '/api/privacy/permissions',
      headers: { cookie },
      payload: { key: 'fileWrite', enabled: true },
    });
    await ctx.app.inject({
      method: 'POST',
      url: '/api/privacy/allowlist',
      headers: { cookie },
      payload: { kind: 'folder', label: 'Temp Notes', target: allowedDir },
    });

    // 1. Voice approve in Bangla ("করো") writes real file & records 'allowed'
    const pendingApproveRes = await ctx.app.inject({
      method: 'POST',
      url: '/api/voice/tools/execute',
      headers: { cookie },
      payload: {
        callId: 'live_call_1',
        name: 'write_approved_note',
        args: {
          folderPath: allowedDir,
          fileName: 'note-bn.md',
          content: 'Hello MJ Tool Calling!',
        },
      },
    });
    expect(pendingApproveRes.json().status).toBe('confirmation_required');
    const confirmId1 = pendingApproveRes.json().pendingConfirmation.confirmationId as string;
    expect(existsSync(join(allowedDir, 'note-bn.md'))).toBe(false);

    const confirmBnRes = await ctx.app.inject({
      method: 'POST',
      url: '/api/tools/confirm',
      headers: { cookie },
      payload: { confirmationId: confirmId1, spokenText: 'করো' },
    });
    expect(confirmBnRes.json().ok).toBe(true);
    expect(confirmBnRes.json().status).toBe('executed');
    expect(readFileSync(join(allowedDir, 'note-bn.md'), 'utf8')).toBe('Hello MJ Tool Calling!');

    // 2. Voice cancel in Hindi ("नहीं") skips write & records 'cancelled'
    const pendingCancelRes = await ctx.app.inject({
      method: 'POST',
      url: '/api/voice/tools/execute',
      headers: { cookie },
      payload: {
        callId: 'live_call_2',
        name: 'write_approved_note',
        args: {
          folderPath: allowedDir,
          fileName: 'note-cancelled.md',
          content: 'Should never be created',
        },
      },
    });
    const confirmId2 = pendingCancelRes.json().pendingConfirmation.confirmationId as string;
    const cancelHiRes = await ctx.app.inject({
      method: 'POST',
      url: '/api/tools/confirm',
      headers: { cookie },
      payload: { confirmationId: confirmId2, spokenText: 'नहीं' },
    });
    expect(cancelHiRes.json().ok).toBe(false);
    expect(cancelHiRes.json().status).toBe('cancelled');
    expect(existsSync(join(allowedDir, 'note-cancelled.md'))).toBe(false);

    // 3. Confirmation timeout expires automatically & denies execution with audit entry
    const pendingTimeoutRes = await ctx.app.inject({
      method: 'POST',
      url: '/api/voice/tools/execute',
      headers: { cookie },
      payload: {
        callId: 'live_call_3',
        name: 'write_approved_note',
        args: {
          folderPath: allowedDir,
          fileName: 'note-timeout.md',
          content: 'Should expire',
        },
      },
    });
    const confirmId3 = pendingTimeoutRes.json().pendingConfirmation.confirmationId as string;
    await new Promise((r) => setTimeout(r, 110));

    const lateConfirm = await ctx.app.inject({
      method: 'POST',
      url: '/api/tools/confirm',
      headers: { cookie },
      payload: { confirmationId: confirmId3, decision: 'approve' },
    });
    expect(lateConfirm.json().ok).toBe(false);
    expect(lateConfirm.json().status).toBe('timed_out');
    expect(existsSync(join(allowedDir, 'note-timeout.md'))).toBe(false);

    const auditLogs = (
      await ctx.app.inject({ method: 'GET', url: '/api/privacy/audit-log', headers: { cookie } })
    ).json().entries as Array<{ outcome: string; detail?: string }>;
    expect(auditLogs.some((e) => e.outcome === 'allowed')).toBe(true);
    expect(auditLogs.some((e) => e.outcome === 'cancelled' && e.detail?.includes('timed out'))).toBe(
      true,
    );
  });

  it('wires Gemini OpenAI-compat streaming tool_calls & SSE UI confirmation end-to-end', async () => {
    const allowedDir = mkdtempSync(join(tmpdir(), 'mj-chat-tools-'));
    tempDirs.push(allowedDir);

    const seenPayloads: Array<Record<string, unknown>> = [];
    let callTurn = 0;

    const mockGeminiClient = new XaiResponsesClient({
      apiKey: 'gemini-test-key-123456',
      baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai',
      defaultModel: 'gemini-2.5-flash',
      timeoutMs: 5000,
      providerId: 'gemini',
      apiFormat: 'openai-chat',
      fetchImpl: async (_url, init) => {
        const parsedBody = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>;
        seenPayloads.push(parsedBody);
        callTurn += 1;

        if (callTurn === 1) {
          // Simulates Gemini un-indexed delta.tool_calls + finish_reason="stop" quirk
          return new Response(
            sseStreamFromChunks([
              `data: ${JSON.stringify({
                id: 'chat_round_1',
                choices: [
                  {
                    delta: {
                      tool_calls: [
                        {
                          id: 'call_write_1',
                          type: 'function',
                          function: {
                            name: 'write_approved_note',
                            arguments: JSON.stringify({
                              folderPath: allowedDir,
                              fileName: 'from-chat.txt',
                              content: 'Written via confirmed Gemini chat tool',
                            }),
                          },
                        },
                      ],
                    },
                    finish_reason: 'stop',
                  },
                ],
              })}\n\n`,
              'data: [DONE]\n\n',
            ]),
            { status: 200, headers: { 'Content-Type': 'text/event-stream' } },
          );
        }

        const msgs = parsedBody.messages as Array<{ role: string; content?: string }>;
        const toolMsg = msgs.find((m) => m.role === 'tool');
        const toolPayload = JSON.parse(toolMsg?.content ?? '{}') as {
          ok?: boolean;
          output?: { path?: string };
        };
        const replyText = toolPayload.ok
          ? `Done! Saved note to ${toolPayload.output?.path}.`
          : 'Could not save the note.';

        return new Response(
          sseStreamFromChunks([
            `data: ${JSON.stringify({
              id: 'chat_round_2',
              choices: [{ delta: { content: replyText }, finish_reason: 'stop' }],
            })}\n\n`,
            'data: [DONE]\n\n',
          ]),
          { status: 200, headers: { 'Content-Type': 'text/event-stream' } },
        );
      },
    });

    const { ctx, cookie } = await createAuthedServer({
      geminiClient: mockGeminiClient,
      toolConfirmationTimeoutMs: 5000,
    });
    contexts.push(ctx);

    await ctx.app.inject({
      method: 'PATCH',
      url: '/api/privacy/permissions',
      headers: { cookie },
      payload: { key: 'toolCalling', enabled: true },
    });
    await ctx.app.inject({
      method: 'PATCH',
      url: '/api/privacy/permissions',
      headers: { cookie },
      payload: { key: 'fileWrite', enabled: true },
    });
    await ctx.app.inject({
      method: 'POST',
      url: '/api/privacy/allowlist',
      headers: { cookie },
      payload: { kind: 'folder', label: 'Chat Notes', target: allowedDir },
    });

    const convRes = await ctx.app.inject({
      method: 'POST',
      url: '/api/conversations',
      headers: { cookie },
      payload: { title: 'Tool Chat' },
    });
    const convId = convRes.json().conversation.id as string;

    const address = await ctx.app.listen({ port: 0, host: '127.0.0.1' });
    const res = await fetch(`${address}/api/conversations/${convId}/messages`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Cookie: cookie,
      },
      body: JSON.stringify({ content: 'Please save a note in Chat Notes.' }),
    });
    expect(res.status).toBe(200);

    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    const events: Array<{ type: string; [k: string]: unknown }> = [];
    let sentConfirm = false;

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const blocks = buffer.replace(/\r\n/g, '\n').split('\n\n');
      buffer = blocks.pop() ?? '';
      for (const block of blocks) {
        const dataLine = block
          .split('\n')
          .find((l) => l.startsWith('data:'))
          ?.slice(5)
          .trim();
        if (!dataLine) continue;
        const ev = JSON.parse(dataLine) as {
          type: string;
          status?: string;
          confirmation?: PendingToolConfirmationDTO;
          message?: { content: string };
        };
        events.push(ev);
        if (
          ev.type === 'tool_status' &&
          ev.status === 'confirmation_required' &&
          ev.confirmation &&
          !sentConfirm
        ) {
          sentConfirm = true;
          // Approve using spoken Hinglish phrase while SSE stream is open!
          await fetch(`${address}/api/tools/confirm`, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              Cookie: cookie,
            },
            body: JSON.stringify({
              confirmationId: ev.confirmation.confirmationId,
              spokenText: 'haan',
            }),
          });
        }
      }
    }

    expect(sentConfirm).toBe(true);
    expect(existsSync(join(allowedDir, 'from-chat.txt'))).toBe(true);
    expect(seenPayloads[0]?.tools).toBeDefined();
    const doneEv = events.find((e) => e.type === 'done') as
      | { message?: { content: string } }
      | undefined;
    expect(doneEv?.message?.content).toContain('Done! Saved note to');
  });

  it('wires Gemini Live functionDeclarations in client-secret/setup and sends toolResponse over WebSocket', async () => {
    const { ctx, cookie } = await createAuthedServer();
    contexts.push(ctx);

    // Default OFF -> client-secret omits toolsEnabled / toolDeclarations
    const secretOff = (
      await ctx.app.inject({
        method: 'POST',
        url: '/api/voice/client-secret',
        headers: { cookie },
        payload: {},
      })
    ).json();
    expect(secretOff.toolsEnabled).toBe(false);
    expect(secretOff.toolDeclarations).toBeUndefined();

    // Enable toolCalling -> client-secret emits permitted toolDeclarations
    await ctx.app.inject({
      method: 'PATCH',
      url: '/api/privacy/permissions',
      headers: { cookie },
      payload: { key: 'toolCalling', enabled: true },
    });

    const secretOn = (
      await ctx.app.inject({
        method: 'POST',
        url: '/api/voice/client-secret',
        headers: { cookie },
        payload: {},
      })
    ).json();
    expect(secretOn.toolsEnabled).toBe(true);
    expect(Array.isArray(secretOn.toolDeclarations)).toBe(true);
    expect(
      (secretOn.toolDeclarations as Array<{ name: string }>).some(
        (d) => d.name === 'get_current_time',
      ),
    ).toBe(true);

    const setupPayload = buildGeminiLiveSetupPayload({
      model: secretOn.model,
      voiceId: secretOn.voice,
      instructions: secretOn.instructions,
      functionDeclarations: secretOn.toolDeclarations,
    }) as { setup: { tools?: Array<{ functionDeclarations: unknown[] }> } };
    expect(setupPayload.setup.tools?.[0]?.functionDeclarations.length).toBeGreaterThan(0);

    // Exercise MjVoiceService end-to-end toolCall -> toolResponse over WebSocket
    const sentFrames: string[] = [];
    const cancelledIds: string[][] = [];
    let activeMockWs: MockWs | null = null;

    class MockWs {
      public static OPEN = 1;
      public static CLOSED = 3;
      public readyState = 1;
      public onopen: (() => void) | null = null;
      public onmessage: ((ev: { data: string }) => void) | null = null;
      public onerror: (() => void) | null = null;
      public onclose: ((ev: { code: number; reason: string }) => void) | null = null;
      constructor(public url: string) {
        activeMockWs = this;
        setTimeout(() => this.onopen?.(), 0);
      }
      send(data: string) {
        sentFrames.push(data);
      }
      close() {
        this.readyState = 3;
      }
    }

    const origGlobals = {
      WebSocket: globalThis.WebSocket,
      window: (globalThis as { window?: unknown }).window,
      navigator: (globalThis as { navigator?: unknown }).navigator,
    };

    try {
      const noopNode = { connect: () => {}, disconnect: () => {}, gain: { value: 1, setTargetAtTime: () => {} } };
      const fakeAudioCtx = {
        state: 'running',
        sampleRate: 16000,
        destination: {},
        resume: async () => {},
        close: async () => {},
        createGain: () => noopNode,
        createAnalyser: () => ({ fftSize: 256, connect: () => {}, disconnect: () => {}, getByteFrequencyData: () => {} }),
        createMediaStreamSource: () => noopNode,
        createScriptProcessor: () => ({ ...noopNode, onaudioprocess: null }),
      };

      Object.defineProperty(globalThis, 'WebSocket', { value: MockWs, configurable: true });
      Object.defineProperty(globalThis, 'window', {
        value: {
          AudioContext: function () {
            return fakeAudioCtx;
          },
          requestAnimationFrame: () => 1,
          cancelAnimationFrame: () => {},
        },
        configurable: true,
      });
      Object.defineProperty(globalThis, 'navigator', {
        value: {
          mediaDevices: {
            getUserMedia: async () => ({
              getTracks: () => [{ enabled: true, stop: () => {} }],
              getAudioTracks: () => [{ enabled: true, stop: () => {} }],
            }),
          },
        },
        configurable: true,
      });

      const svc = new MjVoiceService(
        {
          fetchClientSecret: async () => secretOn,
          onToolCall: async (calls) =>
            calls.map((c) => ({
              id: c.id,
              name: c.name,
              response: { output: { iso: '2026-11-28T00:00:00.000Z', timeZone: 'UTC' } },
            })),
          onToolCallCancellation: (ids) => cancelledIds.push(ids),
        },
        {
          voiceId: 'Aoede',
          languageMode: 'auto',
          speakingRate: 1.0,
          volume: 0.9,
          voiceOutputEnabled: true,
        },
      );

      await svc.startSession();
      await new Promise((r) => setTimeout(r, 20));
      expect(sentFrames.length).toBeGreaterThanOrEqual(1);
      expect(JSON.parse(sentFrames[0]!).setup.tools[0].functionDeclarations.length).toBeGreaterThan(0);

      activeMockWs!.onmessage?.({
        data: JSON.stringify({ setupComplete: {} }),
      });
      activeMockWs!.onmessage?.({
        data: JSON.stringify({
          toolCall: {
            functionCalls: [{ id: 'gemini_live_tc_1', name: 'get_current_time', args: {} }],
          },
        }),
      });
      await new Promise((r) => setTimeout(r, 20));

      const toolRespFrame = sentFrames
        .map((s) => JSON.parse(s) as { toolResponse?: { functionResponses: Array<Record<string, unknown>> } })
        .find((f) => f.toolResponse);
      expect(toolRespFrame?.toolResponse?.functionResponses[0]).toEqual({
        id: 'gemini_live_tc_1',
        name: 'get_current_time',
        response: { output: { iso: '2026-11-28T00:00:00.000Z', timeZone: 'UTC' } },
      });

      activeMockWs!.onmessage?.({
        data: JSON.stringify({ toolCallCancellation: { ids: ['gemini_live_tc_9'] } }),
      });
      expect(cancelledIds).toEqual([['gemini_live_tc_9']]);

      await svc.stopSession('manual');
    } finally {
      Object.defineProperty(globalThis, 'WebSocket', {
        value: origGlobals.WebSocket,
        configurable: true,
      });
      Object.defineProperty(globalThis, 'window', {
        value: origGlobals.window,
        configurable: true,
      });
      Object.defineProperty(globalThis, 'navigator', {
        value: origGlobals.navigator,
        configurable: true,
      });
    }
  });

  it('prevents direct executor bypass for unknown tools even with mocked context', async () => {
    const registry = createDefaultToolRegistry();
    const audits: Array<{ outcome: string; target: string }> = [];
    const res = await executeToolCallSafely(
      registry,
      { name: 'not_a_real_tool', args: {} },
      {
        source: 'server',
        channel: 'chat',
        getPermissions: async () => ({ ...DEFAULT_PERMISSIONS_STATE, toolCalling: true }),
        recordAuditLog: async (e) => {
          audits.push({ outcome: e.outcome, target: e.target });
        },
        listAllowlist: async () => [],
        getUsageSummary: async () => {
          throw new Error('unused');
        },
        searchConversations: async () => [],
        getSystemTelemetry: async () => {
          throw new Error('unused');
        },
      },
    );
    expect(res.ok).toBe(false);
    expect(res.status).toBe('denied');
    expect(audits).toEqual([{ outcome: 'denied', target: 'not_a_real_tool' }]);
  });

  it('renders toolCalling permission switch in PrivacyCenterView and confirmation banner UI', () => {
    const privacyHtml = renderToStaticMarkup(
      <PrivacyCenterView
        permissions={DEFAULT_PERMISSIONS_STATE}
        allowlist={[]}
        auditLogs={[]}
        conversationCount={0}
        session={{ authenticated: true, passcodeRequired: false, mode: 'local-dev', appEnv: 'test' }}
        wakeWordStatusMessage="Wake-word standby is OFF."
        onTogglePermission={async () => {}}
        onRevokeAllDesktop={async () => {}}
        onAddAllowlist={async () => {}}
        onRemoveAllowlist={async () => {}}
        onRefreshAuditLogs={async () => {}}
        onExportData={async () => {}}
        onClearConversations={async () => {}}
        onLogout={async () => {}}
      />,
    );
    expect(privacyHtml).toContain('AI Tool &amp; Function Calling');
    expect(privacyHtml).toContain('Toggle AI Tool &amp; Function Calling');

    const confirmationHtml = renderToStaticMarkup(
      <ToolConfirmationBanner
        confirmation={{
          confirmationId: 'conf_1',
          toolName: 'write_approved_note',
          args: { fileName: 'todo.md' },
          summary: 'Write note "todo.md" inside Notes (24 chars)',
          requiredPermission: 'fileWrite',
          channel: 'chat',
          createdAt: new Date().toISOString(),
          expiresAt: new Date(Date.now() + 20_000).toISOString(),
          timeoutSeconds: 20,
        }}
        onConfirm={() => {}}
        onCancel={() => {}}
      />,
    );
    expect(confirmationHtml).toContain('write_approved_note');
    expect(confirmationHtml).toContain('20s');
    expect(confirmationHtml).toContain('করো');
    expect(confirmationHtml).toContain('हाँ');
    expect(confirmationHtml).toContain('Confirm');
    expect(confirmationHtml).toContain('Cancel');
  });
});
