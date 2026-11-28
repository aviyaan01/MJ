import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it } from 'vitest';
import { ErrorCodes } from '@mj/shared';
import { XaiResponsesClient } from '@mj/ai';
import { buildServer, type MjServerContext } from '../apps/server/src/app.js';
import { loadServerConfig } from '../apps/server/src/config.js';
import { WebSourcesBar } from '../apps/web/src/components/WebSourcesBar.js';

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
  geminiApiKey?: string;
  openWeatherApiKey?: string;
  webSearchApiKey?: string;
  toolsFetchImpl?: typeof fetch;
  geminiChatClient?: XaiResponsesClient;
  toolConfirmationTimeoutMs?: number;
}) {
  const config = loadServerConfig({
    APP_ENV: 'test',
    FREE_ONLY_MODE: 'true',
    GEMINI_API_KEY: options?.geminiApiKey ?? 'gemini-secret-tool-key-1234',
    GEMINI_TEXT_MODEL: 'gemini-2.5-flash',
    OPENWEATHER_API_KEY: options?.openWeatherApiKey ?? '',
    WEB_SEARCH_API_KEY: options?.webSearchApiKey ?? '',
    DATABASE_URL: ':memory:',
    AUTH_SECRET: 'test-signing-secret-must-be-at-least-32-bytes-long',
    CORS_ORIGIN: 'http://localhost:5173',
  });

  const ctx = await buildServer({
    config,
    toolsFetchImpl: options?.toolsFetchImpl,
    toolConfirmationTimeoutMs: options?.toolConfirmationTimeoutMs,
  });

  if (options?.geminiChatClient) {
    const internal = ctx.providerRouter as unknown as {
      entries: Map<string, { client: XaiResponsesClient }>;
    };
    const geminiEntry = internal.entries.get('gemini');
    if (geminiEntry) {
      geminiEntry.client = options.geminiChatClient;
    }
  }

  const loginRes = await ctx.app.inject({ method: 'POST', url: '/api/auth/login', payload: {} });
  const cookie = String(loginRes.headers['set-cookie']).split(';')[0]!;
  return { ctx, cookie };
}

describe('Web Search, Weather, YouTube, Approved Folder & In-App Clipboard Tools', () => {
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

  it('requires externalWebServices for web_search and weather_report, returns grounded sources, and keeps keys on server', async () => {
    const capturedCalls: Array<{ url: string; headers?: Record<string, string> }> = [];
    const mockToolsFetch: typeof fetch = async (input, init) => {
      const url = String(input);
      const headers = (init?.headers ?? {}) as Record<string, string>;
      capturedCalls.push({ url, headers });

      if (url.includes('generativelanguage.googleapis.com')) {
        return new Response(
          JSON.stringify({
            candidates: [
              {
                content: {
                  parts: [{ text: 'TypeScript 5.9 includes deferred module evaluation updates.' }],
                },
                groundingMetadata: {
                  webSearchQueries: ['typescript 5.9 release'],
                  groundingChunks: [
                    { web: { uri: 'https://devblogs.microsoft.com/typescript/', title: 'Microsoft TypeScript Blog' } },
                    { web: { uri: 'https://www.typescriptlang.org/docs/', title: 'TypeScript Docs' } },
                  ],
                },
              },
            ],
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        );
      }

      if (url.includes('api.openweathermap.org')) {
        return new Response(
          JSON.stringify({
            name: 'Dhaka',
            sys: { country: 'BD' },
            weather: [{ main: 'Clear', description: 'clear sky' }],
            main: { temp: 27.4, feels_like: 28.1, humidity: 62 },
            wind: { speed: 3.1 },
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        );
      }

      return new Response('not found', { status: 404 });
    };

    const { ctx, cookie } = await createAuthedServer({
      openWeatherApiKey: 'owm-secret-key-999999',
      toolsFetchImpl: mockToolsFetch,
    });
    contexts.push(ctx);

    // Public settings NEVER expose OPENWEATHER_API_KEY
    const settingsText = (
      await ctx.app.inject({ method: 'GET', url: '/api/settings', headers: { cookie } })
    ).body;
    expect(settingsText).not.toContain('owm-secret-key-999999');

    // Enable toolCalling, disable externalWebServices -> web_search & weather_report MUST be denied
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
      payload: { key: 'externalWebServices', enabled: false },
    });

    const webDenied = (
      await ctx.app.inject({
        method: 'POST',
        url: '/api/voice/tools/execute',
        headers: { cookie },
        payload: { name: 'web_search', args: { query: 'typescript 5.9' } },
      })
    ).json();
    expect(webDenied.ok).toBe(false);
    expect(webDenied.status).toBe('denied');
    expect(capturedCalls).toHaveLength(0);

    const weatherDenied = (
      await ctx.app.inject({
        method: 'POST',
        url: '/api/voice/tools/execute',
        headers: { cookie },
        payload: { name: 'weather_report', args: { location: 'Dhaka' } },
      })
    ).json();
    expect(weatherDenied.ok).toBe(false);
    expect(weatherDenied.status).toBe('denied');

    // Turn externalWebServices ON -> web_search uses Gemini Google Search grounding with sources
    await ctx.app.inject({
      method: 'PATCH',
      url: '/api/privacy/permissions',
      headers: { cookie },
      payload: { key: 'externalWebServices', enabled: true },
    });

    const webOk = (
      await ctx.app.inject({
        method: 'POST',
        url: '/api/voice/tools/execute',
        headers: { cookie },
        payload: { name: 'web_search', args: { query: 'typescript 5.9' } },
      })
    ).json();
    expect(webOk.ok).toBe(true);
    expect(webOk.result.provider).toBe('gemini-google-search-grounding');
    expect(webOk.result.spokenBrief).toContain('TypeScript 5.9');
    expect(webOk.sources).toEqual([
      { title: 'Microsoft TypeScript Blog', url: 'https://devblogs.microsoft.com/typescript/' },
      { title: 'TypeScript Docs', url: 'https://www.typescriptlang.org/docs/' },
    ]);
    // Gemini key sent in header, never in query string
    const geminiCall = capturedCalls.find((c) => c.url.includes('generativelanguage.googleapis.com'));
    expect(geminiCall?.url).not.toContain('gemini-secret-tool-key-1234');
    expect(geminiCall?.headers?.['x-goog-api-key']).toBe('gemini-secret-tool-key-1234');

    const weatherOk = (
      await ctx.app.inject({
        method: 'POST',
        url: '/api/voice/tools/execute',
        headers: { cookie },
        payload: { name: 'weather_report', args: { location: 'Dhaka', units: 'metric' } },
      })
    ).json();
    expect(weatherOk.ok).toBe(true);
    expect(weatherOk.result.location).toBe('Dhaka');
    expect(weatherOk.result.temp).toBe(27.4);
    expect(weatherOk.result.spokenBrief).toContain('Dhaka, BD');
    expect(JSON.stringify(weatherOk)).not.toContain('owm-secret-key-999999');

    const sourcesHtml = renderToStaticMarkup(<WebSourcesBar sources={webOk.sources} />);
    expect(sourcesHtml).toContain('Web Sources');
    expect(sourcesHtml).toContain('Microsoft TypeScript Blog');
    expect(sourcesHtml).toContain('https://devblogs.microsoft.com/typescript/');
  });

  it('supports WEB_SEARCH_API_KEY override and emits web_search sources over chat SSE', async () => {
    const mockSearchFetch: typeof fetch = async (input) => {
      expect(String(input)).toContain('api.tavily.com/search');
      return new Response(
        JSON.stringify({
          answer: 'MJ Assistant runs locally on Fastify + React + Tauri.',
          results: [{ title: 'Tauri v2', url: 'https://v2.tauri.app/' }],
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      );
    };

    let round = 0;
    const mockGeminiChat = new XaiResponsesClient({
      apiKey: 'gemini-secret-tool-key-1234',
      baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai',
      defaultModel: 'gemini-2.5-flash',
      timeoutMs: 5000,
      providerId: 'gemini',
      apiFormat: 'openai-chat',
      fetchImpl: async () => {
        round += 1;
        if (round === 1) {
          return new Response(
            sseStreamFromChunks([
              `data: ${JSON.stringify({
                id: 'ws_r1',
                choices: [
                  {
                    delta: {
                      tool_calls: [
                        {
                          id: 'tc_ws_1',
                          type: 'function',
                          function: { name: 'web_search', arguments: '{"query":"tauri v2"}' },
                        },
                      ],
                    },
                    finish_reason: 'tool_calls',
                  },
                ],
              })}\n\n`,
              'data: [DONE]\n\n',
            ]),
            { status: 200, headers: { 'Content-Type': 'text/event-stream' } },
          );
        }
        return new Response(
          sseStreamFromChunks([
            `data: ${JSON.stringify({
              id: 'ws_r2',
              choices: [{ delta: { content: 'Tauri v2 summary ready.' }, finish_reason: 'stop' }],
            })}\n\n`,
            'data: [DONE]\n\n',
          ]),
          { status: 200, headers: { 'Content-Type': 'text/event-stream' } },
        );
      },
    });

    const { ctx, cookie } = await createAuthedServer({
      webSearchApiKey: 'tvly-secret-key-888',
      toolsFetchImpl: mockSearchFetch,
      geminiChatClient: mockGeminiChat,
    });
    contexts.push(ctx);

    await ctx.app.inject({
      method: 'PATCH',
      url: '/api/privacy/permissions',
      headers: { cookie },
      payload: { key: 'toolCalling', enabled: true },
    });

    const convId = (
      await ctx.app.inject({
        method: 'POST',
        url: '/api/conversations',
        headers: { cookie },
        payload: { title: 'Web Search Test' },
      })
    ).json().conversation.id as string;

    const sseRes = await ctx.app.inject({
      method: 'POST',
      url: `/api/conversations/${convId}/messages`,
      headers: { cookie },
      payload: { content: 'Search tauri v2' },
    });
    expect(sseRes.statusCode).toBe(200);
    expect(sseRes.body).toContain('"sources":[{"title":"Tauri v2","url":"https://v2.tauri.app/"}]');
  });

  it('gates youtube_search/play and open_url behind webLaunch, externalWebServices, and web_domain allowlist', async () => {
    const { ctx, cookie } = await createAuthedServer();
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
      payload: { key: 'webLaunch', enabled: true },
    });

    // youtube.com is NOT allowlisted yet -> denied
    const unapprovedYt = (
      await ctx.app.inject({
        method: 'POST',
        url: '/api/voice/tools/execute',
        headers: { cookie },
        payload: { name: 'youtube_search', args: { query: 'lofi beats' } },
      })
    ).json();
    expect(unapprovedYt.ok).toBe(false);
    expect(unapprovedYt.status).toBe('denied');
    expect(unapprovedYt.errorCode).toBe(ErrorCodes.UNAPPROVED_TARGET);

    // Allowlist youtube.com and verify externalWebServices gate + allowlisted opener payload
    await ctx.app.inject({
      method: 'POST',
      url: '/api/privacy/allowlist',
      headers: { cookie },
      payload: { kind: 'web_domain', label: 'YouTube', target: 'youtube.com' },
    });

    await ctx.app.inject({
      method: 'PATCH',
      url: '/api/privacy/permissions',
      headers: { cookie },
      payload: { key: 'externalWebServices', enabled: false },
    });
    const ytOffline = (
      await ctx.app.inject({
        method: 'POST',
        url: '/api/voice/tools/execute',
        headers: { cookie },
        payload: { name: 'youtube_play', args: { queryOrVideoId: 'dQw4w9WgXcQ' } },
      })
    ).json();
    expect(ytOffline.ok).toBe(false);
    expect(ytOffline.status).toBe('denied');

    await ctx.app.inject({
      method: 'PATCH',
      url: '/api/privacy/permissions',
      headers: { cookie },
      payload: { key: 'externalWebServices', enabled: true },
    });

    const ytSearchOk = (
      await ctx.app.inject({
        method: 'POST',
        url: '/api/voice/tools/execute',
        headers: { cookie },
        payload: { name: 'youtube_search', args: { query: 'lofi beats' } },
      })
    ).json();
    expect(ytSearchOk.ok).toBe(true);
    expect(ytSearchOk.clientAction).toEqual({
      kind: 'open_approved_url',
      target: 'https://www.youtube.com/results?search_query=lofi%20beats',
    });

    const ytPlayOk = (
      await ctx.app.inject({
        method: 'POST',
        url: '/api/voice/tools/execute',
        headers: { cookie },
        payload: { name: 'youtube_play', args: { queryOrVideoId: 'dQw4w9WgXcQ' } },
      })
    ).json();
    expect(ytPlayOk.ok).toBe(true);
    expect(ytPlayOk.clientAction).toEqual({
      kind: 'open_approved_url',
      target: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
    });

    // open_url uses risk=confirm & routes via open_approved_url
    const openPending = (
      await ctx.app.inject({
        method: 'POST',
        url: '/api/voice/tools/execute',
        headers: { cookie },
        payload: { name: 'open_url', args: { url: 'https://www.youtube.com/@GoogleDevelopers' } },
      })
    ).json();
    expect(openPending.status).toBe('confirmation_required');

    const openConfirmed = (
      await ctx.app.inject({
        method: 'POST',
        url: '/api/tools/confirm',
        headers: { cookie },
        payload: { confirmationId: openPending.pendingConfirmation.confirmationId, spokenText: 'yes' },
      })
    ).json();
    expect(openConfirmed.ok).toBe(true);
    expect(openConfirmed.clientAction).toEqual({
      kind: 'open_approved_url',
      target: 'https://www.youtube.com/@GoogleDevelopers',
    });
  });

  it('restricts file_search, open_folder, and organize_files to approved folders with confirm=true for moves, and validates desktop_actions.rs', () => {
    const desktopRs = readFileSync(
      resolve(process.cwd(), 'apps', 'desktop', 'src-tauri', 'src', 'desktop_actions.rs'),
      'utf8',
    );
    const libRs = readFileSync(
      resolve(process.cwd(), 'apps', 'desktop', 'src-tauri', 'src', 'lib.rs'),
      'utf8',
    );
    expect(desktopRs).toContain('pub fn desktop_open_folder');
    expect(desktopRs).toContain('approved_folders');
    expect(desktopRs).toContain('confirmed: bool');
    expect(libRs).toContain('desktop_actions::desktop_open_folder');
  });

  it('runs real file_search, open_folder, and confirmed organize_files + in-app clipboard copy & summary', async () => {
    const allowedDir = mkdtempSync(join(tmpdir(), 'mj-files-tools-'));
    const unapprovedDir = mkdtempSync(join(tmpdir(), 'mj-unapproved-'));
    tempDirs.push(allowedDir, unapprovedDir);

    writeFileSync(join(allowedDir, 'report.pdf'), 'pdf-data', 'utf8');
    writeFileSync(join(allowedDir, 'avatar.png'), 'png-data', 'utf8');
    mkdirSync(join(allowedDir, 'nested'));
    writeFileSync(join(allowedDir, 'nested', 'notes-alpha.txt'), 'alpha', 'utf8');

    const { ctx, cookie } = await createAuthedServer();
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
      payload: { key: 'fileRead', enabled: true },
    });
    await ctx.app.inject({
      method: 'PATCH',
      url: '/api/privacy/permissions',
      headers: { cookie },
      payload: { key: 'fileWrite', enabled: true },
    });
    await ctx.app.inject({
      method: 'PATCH',
      url: '/api/privacy/permissions',
      headers: { cookie },
      payload: { key: 'clipboardWrite', enabled: true },
    });
    await ctx.app.inject({
      method: 'POST',
      url: '/api/privacy/allowlist',
      headers: { cookie },
      payload: { kind: 'folder', label: 'Workspace', target: allowedDir },
    });

    // Unapproved folder MUST be rejected for file_search, open_folder, organize_files
    for (const tool of ['file_search', 'open_folder', 'organize_files']) {
      const denied = (
        await ctx.app.inject({
          method: 'POST',
          url: '/api/voice/tools/execute',
          headers: { cookie },
          payload: { name: tool, args: { folderPath: unapprovedDir } },
        })
      ).json();
      expect(denied.ok).toBe(false);
      expect(denied.status).toBe('denied');
    }

    // file_search in approved folder finds nested file
    const searchOk = (
      await ctx.app.inject({
        method: 'POST',
        url: '/api/voice/tools/execute',
        headers: { cookie },
        payload: { name: 'file_search', args: { folderPath: allowedDir, query: 'alpha' } },
      })
    ).json();
    expect(searchOk.ok).toBe(true);
    expect(searchOk.result.matchCount).toBe(1);
    expect(searchOk.result.matches[0].name).toBe('notes-alpha.txt');

    // open_folder emits open_approved_folder clientAction
    const folderOk = (
      await ctx.app.inject({
        method: 'POST',
        url: '/api/voice/tools/execute',
        headers: { cookie },
        payload: { name: 'open_folder', args: { folderPath: allowedDir } },
      })
    ).json();
    expect(folderOk.ok).toBe(true);
    expect(folderOk.clientAction).toEqual({
      kind: 'open_approved_folder',
      target: allowedDir,
    });

    // organize_files requires confirm=true before moving files
    const orgPending = (
      await ctx.app.inject({
        method: 'POST',
        url: '/api/voice/tools/execute',
        headers: { cookie },
        payload: { name: 'organize_files', args: { folderPath: allowedDir } },
      })
    ).json();
    expect(orgPending.status).toBe('confirmation_required');
    expect(existsSync(join(allowedDir, 'report.pdf'))).toBe(true);

    const orgDone = (
      await ctx.app.inject({
        method: 'POST',
        url: '/api/tools/confirm',
        headers: { cookie },
        payload: { confirmationId: orgPending.pendingConfirmation.confirmationId, spokenText: 'haan' },
      })
    ).json();
    expect(orgDone.ok).toBe(true);
    expect(orgDone.result.movedCount).toBe(2);
    expect(existsSync(join(allowedDir, 'Documents', 'report.pdf'))).toBe(true);
    expect(existsSync(join(allowedDir, 'Images', 'avatar.png'))).toBe(true);

    // In-app clipboard copy & paste summary
    const copyRes = (
      await ctx.app.inject({
        method: 'POST',
        url: '/api/voice/tools/execute',
        headers: { cookie },
        payload: {
          name: 'clipboard_copy',
          args: {
            text: 'First architecture invariant. Second performance checkpoint. Third privacy boundary.',
            label: 'Notes',
          },
        },
      })
    ).json();
    expect(copyRes.ok).toBe(true);
    expect(copyRes.clientAction).toEqual({
      kind: 'clipboard_copy',
      text: 'First architecture invariant. Second performance checkpoint. Third privacy boundary.',
      label: 'Notes',
    });

    const summaryRes = (
      await ctx.app.inject({
        method: 'POST',
        url: '/api/voice/tools/execute',
        headers: { cookie },
        payload: { name: 'clipboard_paste_summary', args: { maxBullets: 2 } },
      })
    ).json();
    expect(summaryRes.ok).toBe(true);
    expect(summaryRes.result.hasContent).toBe(true);
    expect(summaryRes.result.summaryPoints).toHaveLength(2);
    expect(summaryRes.result.spokenBrief).toContain('First architecture invariant.');
  });
});
