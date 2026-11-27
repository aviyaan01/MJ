import { afterEach, describe, expect, it } from 'vitest';
import {
  ADMIN_PRIVILEGE_POLICY,
  DEFAULT_PERMISSIONS_STATE,
  ErrorCodes,
  OS_CAPABILITY_KEYS,
  UpdateSinglePermissionSchema,
  isApprovedHttpsUrl,
  isForbiddenShellTarget,
  isProtectedSystemPath,
} from '@mj/shared';
import { XaiResponsesClient } from '@mj/ai';
import { buildServer, type MjServerContext } from '../apps/server/src/app.js';
import { loadServerConfig } from '../apps/server/src/config.js';

function createMockXaiClient(): XaiResponsesClient {
  return new XaiResponsesClient({
    apiKey: 'xai-stage4-test-key-only',
    baseUrl: 'https://api.x.ai/v1',
    defaultModel: 'grok-4.7',
    timeoutMs: 5000,
    fetchImpl: async () =>
      new Response('event: response.completed\ndata: {"type":"response.completed","response":{"id":"r"}}\n\n', {
        status: 200,
        headers: { 'Content-Type': 'text/event-stream' },
      }),
  });
}

async function createAuthedTestServer(): Promise<{ ctx: MjServerContext; cookie: string }> {
  const config = loadServerConfig({
    APP_ENV: 'test',
    XAI_API_KEY: 'xai-stage4-test-key-only',
    XAI_TEXT_MODEL: 'grok-4.7',
    DATABASE_URL: ':memory:',
    AUTH_SECRET: 'test-signing-secret-must-be-at-least-32-bytes-long',
    CORS_ORIGIN: 'http://localhost:5173',
  });
  const ctx = await buildServer({
    config,
    xaiClient: createMockXaiClient(),
  });
  const loginRes = await ctx.app.inject({ method: 'POST', url: '/api/auth/login', payload: {} });
  const cookie = String(loginRes.headers['set-cookie']).split(';')[0]!;
  return { ctx, cookie };
}

describe('Stage 4 Hardened Defaults, Desktop Companion Guardrails & Privacy Center (Sections 14 & 15)', () => {
  const contexts: MjServerContext[] = [];

  afterEach(async () => {
    while (contexts.length > 0) {
      const ctx = contexts.pop()!;
      await ctx.app.close();
      ctx.dbHandle.close();
    }
  });

  it('ships every OS-level capability class OFF and locks Stage 3 categories OFF', () => {
    for (const key of OS_CAPABILITY_KEYS) {
      expect(DEFAULT_PERMISSIONS_STATE[key]).toBe(false);
    }
    expect(DEFAULT_PERMISSIONS_STATE.wakeWordStandby).toBe(false);
    expect(DEFAULT_PERMISSIONS_STATE.fileRead).toBe(false);
    expect(DEFAULT_PERMISSIONS_STATE.fileWrite).toBe(false);
    expect(DEFAULT_PERMISSIONS_STATE.memoryAccess).toBe(false);
    expect(DEFAULT_PERMISSIONS_STATE.optionalAutomation).toBe(false);
    expect(DEFAULT_PERMISSIONS_STATE.cloudFileProcessing).toBe(false);

    expect(ADMIN_PRIVILEGE_POLICY.requiresAdmin).toBe(false);
    expect(ADMIN_PRIVILEGE_POLICY.executionLevel).toBe('asInvoker');
    expect(ADMIN_PRIVILEGE_POLICY.adminOnlyExceptionName).toContain('C:\\Windows');
  });

  it('forbids arbitrary shells, protected paths, and unapproved URLs in shared validators', () => {
    expect(isForbiddenShellTarget('cmd.exe')).toBe(true);
    expect(isForbiddenShellTarget('powershell.exe')).toBe(true);
    expect(isForbiddenShellTarget('C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe')).toBe(true);
    expect(isForbiddenShellTarget('notepad.exe | whoami')).toBe(true);
    expect(isForbiddenShellTarget('C:\\Users\\ASUS\\AppData\\Local\\Programs\\Code.exe')).toBe(false);

    expect(isProtectedSystemPath('C:\\Windows\\System32')).toBe(true);
    expect(isProtectedSystemPath('C:\\Program Files\\MJ')).toBe(true);
    expect(isProtectedSystemPath('C:\\Users\\ASUS\\..\\Windows')).toBe(true);
    expect(isProtectedSystemPath('C:\\Users\\ASUS\\Documents\\Work')).toBe(false);

    expect(isApprovedHttpsUrl('http://example.com', ['example.com'])).toBeNull();
    expect(isApprovedHttpsUrl('https://evil.example/a', ['docs.x.ai'])).toBeNull();
    expect(isApprovedHttpsUrl('https://docs.x.ai/guides', ['docs.x.ai'])).toBe('https://docs.x.ai/guides');
  });

  it('rejects bundled master-enable permission payloads and separates fileRead vs fileWrite', async () => {
    const { ctx, cookie } = await createAuthedTestServer();
    contexts.push(ctx);

    // Master switch payload must be rejected by strict Zod schema
    expect(
      UpdateSinglePermissionSchema.safeParse({ desktopIntegration: true }).success,
    ).toBe(false);
    expect(
      UpdateSinglePermissionSchema.safeParse({ key: 'memoryAccess', enabled: true }).success,
    ).toBe(false);

    const bundledAttempt = await ctx.app.inject({
      method: 'PATCH',
      url: '/api/privacy/permissions',
      headers: { cookie },
      payload: { enableAllDesktop: true },
    });
    expect(bundledAttempt.statusCode).toBe(400);

    // Initial permissions have all 8 OS classes OFF
    const initialRes = await ctx.app.inject({
      method: 'GET',
      url: '/api/privacy/permissions',
      headers: { cookie },
    });
    expect(initialRes.statusCode).toBe(200);
    const initialPerms = initialRes.json().permissions;
    for (const key of OS_CAPABILITY_KEYS) {
      expect(initialPerms[key]).toBe(false);
    }

    // Enabling fileRead (desktop search) must leave fileWrite (file organization) OFF
    const enableFileRead = await ctx.app.inject({
      method: 'PATCH',
      url: '/api/privacy/permissions',
      headers: { cookie },
      payload: { key: 'fileRead', enabled: true },
    });
    expect(enableFileRead.statusCode).toBe(200);
    expect(enableFileRead.json().permissions.fileRead).toBe(true);
    expect(enableFileRead.json().permissions.fileWrite).toBe(false);
    expect(enableFileRead.json().permissions.appOpening).toBe(false);
    expect(enableFileRead.json().permissions.wakeWordStandby).toBe(false);

    // Revoking all desktop permissions resets every OS capability to OFF and logs the event
    const revokeRes = await ctx.app.inject({
      method: 'POST',
      url: '/api/privacy/revoke-desktop',
      headers: { cookie },
      payload: {},
    });
    expect(revokeRes.statusCode).toBe(200);
    expect(revokeRes.json().permissions.fileRead).toBe(false);
  });

  it('enforces desktop allowlists, blocks shell commands, requires confirmation for fileWrite, and logs all actions', async () => {
    const { ctx, cookie } = await createAuthedTestServer();
    contexts.push(ctx);

    // Shell interpreter rejected from allowlist
    const badShellAllowlist = await ctx.app.inject({
      method: 'POST',
      url: '/api/privacy/allowlist',
      headers: { cookie },
      payload: { kind: 'app', label: 'PowerShell', target: 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe' },
    });
    expect(badShellAllowlist.statusCode).toBe(403);
    expect(badShellAllowlist.json().error.code).toBe(ErrorCodes.SHELL_EXECUTION_FORBIDDEN);

    // Protected system folder rejected from folder allowlist
    const badFolderAllowlist = await ctx.app.inject({
      method: 'POST',
      url: '/api/privacy/allowlist',
      headers: { cookie },
      payload: { kind: 'folder', label: 'WinDir', target: 'C:\\Windows\\System32' },
    });
    expect(badFolderAllowlist.statusCode).toBe(403);
    expect(badFolderAllowlist.json().error.code).toBe(ErrorCodes.UNAPPROVED_TARGET);

    // Add valid user folder, user app, and HTTPS domain
    const addFolder = await ctx.app.inject({
      method: 'POST',
      url: '/api/privacy/allowlist',
      headers: { cookie },
      payload: { kind: 'folder', label: 'Documents', target: 'C:\\Users\\ASUS\\Documents' },
    });
    expect(addFolder.statusCode).toBe(201);

    const addApp = await ctx.app.inject({
      method: 'POST',
      url: '/api/privacy/allowlist',
      headers: { cookie },
      payload: { kind: 'app', label: 'VS Code', target: 'C:\\Users\\ASUS\\AppData\\Local\\Programs\\Microsoft VS Code\\Code.exe' },
    });
    expect(addApp.statusCode).toBe(201);

    const addDomain = await ctx.app.inject({
      method: 'POST',
      url: '/api/privacy/allowlist',
      headers: { cookie },
      payload: { kind: 'web_domain', label: 'xAI Docs', target: 'https://docs.x.ai' },
    });
    expect(addDomain.statusCode).toBe(201);

    // System monitoring denied while OFF, allowed once enabled individually
    const blockedStatus = await ctx.app.inject({
      method: 'GET',
      url: '/api/desktop/system-status',
      headers: { cookie },
    });
    expect(blockedStatus.statusCode).toBe(403);
    expect(blockedStatus.json().error.code).toBe(ErrorCodes.PERMISSION_DENIED);

    await ctx.app.inject({
      method: 'PATCH',
      url: '/api/privacy/permissions',
      headers: { cookie },
      payload: { key: 'systemMonitoring', enabled: true },
    });
    const okStatus = await ctx.app.inject({
      method: 'GET',
      url: '/api/desktop/system-status',
      headers: { cookie },
    });
    expect(okStatus.statusCode).toBe(200);
    const telemetry = okStatus.json().telemetry;
    expect(telemetry.source).toBe('local-windows-host');
    expect(telemetry.adminElevated).toBe(false);
    expect(telemetry.cpuCores).toBeGreaterThan(0);
    expect(telemetry.memoryTotalBytes).toBeGreaterThan(0);
    expect(telemetry.battery).toBeNull();

    // Enable fileRead only — fileRead succeeds, fileWrite still blocked
    await ctx.app.inject({
      method: 'PATCH',
      url: '/api/privacy/permissions',
      headers: { cookie },
      payload: { key: 'fileRead', enabled: true },
    });
    const allowedSearch = await ctx.app.inject({
      method: 'POST',
      url: '/api/desktop/validate-action',
      headers: { cookie },
      payload: {
        capability: 'fileRead',
        action: 'Search local folder',
        target: 'C:\\Users\\ASUS\\Documents',
      },
    });
    expect(allowedSearch.statusCode).toBe(200);

    const deniedWriteWhenOff = await ctx.app.inject({
      method: 'POST',
      url: '/api/desktop/validate-action',
      headers: { cookie },
      payload: {
        capability: 'fileWrite',
        action: 'Organize folder',
        target: 'C:\\Users\\ASUS\\Documents',
        confirmed: true,
      },
    });
    expect(deniedWriteWhenOff.statusCode).toBe(403);

    // Enable fileWrite — must fail with 409 CONFIRMATION_REQUIRED unless confirmed: true
    await ctx.app.inject({
      method: 'PATCH',
      url: '/api/privacy/permissions',
      headers: { cookie },
      payload: { key: 'fileWrite', enabled: true },
    });
    const unconfirmedWrite = await ctx.app.inject({
      method: 'POST',
      url: '/api/desktop/validate-action',
      headers: { cookie },
      payload: {
        capability: 'fileWrite',
        action: 'Organize folder',
        target: 'C:\\Users\\ASUS\\Documents',
        confirmed: false,
      },
    });
    expect(unconfirmedWrite.statusCode).toBe(409);
    expect(unconfirmedWrite.json().error.code).toBe(ErrorCodes.CONFIRMATION_REQUIRED);

    const confirmedWrite = await ctx.app.inject({
      method: 'POST',
      url: '/api/desktop/validate-action',
      headers: { cookie },
      payload: {
        capability: 'fileWrite',
        action: 'Organize folder',
        target: 'C:\\Users\\ASUS\\Documents',
        confirmed: true,
      },
    });
    expect(confirmedWrite.statusCode).toBe(200);

    // Enable appOpening + webLaunch and test guardrails
    await ctx.app.inject({
      method: 'PATCH',
      url: '/api/privacy/permissions',
      headers: { cookie },
      payload: { key: 'appOpening', enabled: true },
    });
    const shellAttempt = await ctx.app.inject({
      method: 'POST',
      url: '/api/desktop/validate-action',
      headers: { cookie },
      payload: { capability: 'appOpening', action: 'Open app', target: 'cmd.exe' },
    });
    expect(shellAttempt.statusCode).toBe(403);
    expect(shellAttempt.json().error.code).toBe(ErrorCodes.SHELL_EXECUTION_FORBIDDEN);

    const unapprovedApp = await ctx.app.inject({
      method: 'POST',
      url: '/api/desktop/validate-action',
      headers: { cookie },
      payload: { capability: 'appOpening', action: 'Open app', target: 'C:\\Tools\\unknown.exe' },
    });
    expect(unapprovedApp.statusCode).toBe(403);
    expect(unapprovedApp.json().error.code).toBe(ErrorCodes.UNAPPROVED_TARGET);

    const approvedApp = await ctx.app.inject({
      method: 'POST',
      url: '/api/desktop/validate-action',
      headers: { cookie },
      payload: { capability: 'appOpening', action: 'Open app', target: 'VS Code' },
    });
    expect(approvedApp.statusCode).toBe(200);

    // Check audit log recorded allowed, denied, and cancelled events
    const auditRes = await ctx.app.inject({
      method: 'GET',
      url: '/api/privacy/audit-log',
      headers: { cookie },
    });
    expect(auditRes.statusCode).toBe(200);
    const entries = auditRes.json().entries as Array<{ outcome: string; capability: string }>;
    expect(entries.some((e) => e.outcome === 'allowed' && e.capability === 'fileRead')).toBe(true);
    expect(entries.some((e) => e.outcome === 'cancelled' && e.capability === 'fileWrite')).toBe(true);
    expect(entries.some((e) => e.outcome === 'denied' && e.capability === 'appOpening')).toBe(true);
  });

  it('enforces microphone/AI service privacy switches, secret-free export, and history clearing without erasing audit logs', async () => {
    const { ctx, cookie } = await createAuthedTestServer();
    contexts.push(ctx);

    // Create a conversation so export & delete have real rows
    const convRes = await ctx.app.inject({
      method: 'POST',
      url: '/api/conversations',
      headers: { cookie },
      payload: { title: 'Privacy Test Thread' },
    });
    const convId = convRes.json().conversation.id as string;

    // Turning wakeWordStandby ON then disabling microphoneAccess must automatically reset wakeWordStandby OFF
    await ctx.app.inject({
      method: 'PATCH',
      url: '/api/privacy/permissions',
      headers: { cookie },
      payload: { key: 'wakeWordStandby', enabled: true },
    });
    const micOffRes = await ctx.app.inject({
      method: 'PATCH',
      url: '/api/privacy/permissions',
      headers: { cookie },
      payload: { key: 'microphoneAccess', enabled: false },
    });
    expect(micOffRes.json().permissions.microphoneAccess).toBe(false);
    expect(micOffRes.json().permissions.wakeWordStandby).toBe(false);

    // Voice client-secret blocked when microphoneAccess is OFF
    const blockedVoice = await ctx.app.inject({
      method: 'POST',
      url: '/api/voice/client-secret',
      headers: { cookie },
      payload: {},
    });
    expect(blockedVoice.statusCode).toBe(403);
    expect(blockedVoice.json().error.code).toBe(ErrorCodes.PERMISSION_DENIED);

    // External Web Services OFF blocks Grok Responses chat endpoint
    await ctx.app.inject({
      method: 'PATCH',
      url: '/api/privacy/permissions',
      headers: { cookie },
      payload: { key: 'externalWebServices', enabled: false },
    });
    const blockedChat = await ctx.app.inject({
      method: 'POST',
      url: `/api/conversations/${convId}/messages`,
      headers: { cookie },
      payload: { content: 'Test while AI web services disabled' },
    });
    expect(blockedChat.statusCode).toBe(403);
    expect(blockedChat.json().error.code).toBe(ErrorCodes.PERMISSION_DENIED);

    // Export excludes API keys and secrets
    const exportRes = await ctx.app.inject({
      method: 'GET',
      url: '/api/privacy/export',
      headers: { cookie },
    });
    expect(exportRes.statusCode).toBe(200);
    expect(exportRes.body).not.toContain('xai-stage4-test-key-only');
    expect(exportRes.body).not.toContain('test-signing-secret-must-be-at-least-32-bytes-long');
    const bundle = exportRes.json();
    expect(bundle.conversations).toHaveLength(1);

    // Clear all conversations — removes threads while preserving audit log integrity
    const clearRes = await ctx.app.inject({
      method: 'DELETE',
      url: '/api/privacy/conversations',
      headers: { cookie },
    });
    expect(clearRes.statusCode).toBe(200);
    expect(clearRes.json().deletedCount).toBe(1);

    const listConvsAfter = await ctx.app.inject({
      method: 'GET',
      url: '/api/conversations',
      headers: { cookie },
    });
    expect(listConvsAfter.json().conversations).toHaveLength(0);

    const auditAfter = await ctx.app.inject({
      method: 'GET',
      url: '/api/privacy/audit-log',
      headers: { cookie },
    });
    expect(auditAfter.json().entries.length).toBeGreaterThan(0);
    expect(
      auditAfter.json().entries.some((e: { capability: string }) => e.capability === 'conversation_history'),
    ).toBe(true);
  });
});
