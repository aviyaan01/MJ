import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it } from 'vitest';
import {
  DEFAULT_PERMISSIONS_STATE,
  ErrorCodes,
  OS_CAPABILITY_KEYS,
  acceleratorFromKeyboardEvent,
  normalizeShortcutAccelerator,
} from '@mj/shared';
import { XaiResponsesClient } from '@mj/ai';
import { buildServer, type MjServerContext } from '../apps/server/src/app.js';
import { loadServerConfig } from '../apps/server/src/config.js';
import { DesktopView } from '../apps/web/src/components/DesktopView.js';
import { PrivacyCenterView } from '../apps/web/src/components/PrivacyCenterView.js';

function createMockXaiClient(): XaiResponsesClient {
  return new XaiResponsesClient({
    apiKey: 'xai-shortcuts-test-key',
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
    XAI_API_KEY: 'xai-shortcuts-test-key',
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

describe('Section 14 Optional Advanced Capability: Configurable Shortcuts', () => {
  const contexts: MjServerContext[] = [];

  afterEach(async () => {
    while (contexts.length > 0) {
      const ctx = contexts.pop()!;
      await ctx.app.close();
      ctx.dbHandle.close();
    }
  });

  it('ships OFF by default and normalizes safe keyboard accelerators cleanly', () => {
    expect(OS_CAPABILITY_KEYS).toContain('configurableShortcuts');
    expect(DEFAULT_PERMISSIONS_STATE.configurableShortcuts).toBe(false);

    expect(normalizeShortcutAccelerator('control + shift + m')).toBe('Ctrl+Shift+M');
    expect(normalizeShortcutAccelerator('alt + space')).toBe('Alt+Space');
    expect(normalizeShortcutAccelerator('meta+k')).toBe('Meta+K');

    // Reject single/unmodified keys and shell characters
    expect(normalizeShortcutAccelerator('m')).toBeNull();
    expect(normalizeShortcutAccelerator('Shift+M')).toBeNull();
    expect(normalizeShortcutAccelerator('Ctrl+M | whoami')).toBeNull();

    expect(
      acceleratorFromKeyboardEvent({
        key: 'm',
        ctrlKey: true,
        shiftKey: true,
        altKey: false,
        metaKey: false,
      }),
    ).toBe('Ctrl+Shift+M');
  });

  it('requires individual opt-in, rejects shells/duplicates, respects appOpening gate, and logs to audit log', async () => {
    const { ctx, cookie } = await createAuthedTestServer();
    contexts.push(ctx);

    // Initially disabled
    const initialList = await ctx.app.inject({
      method: 'GET',
      url: '/api/desktop/shortcuts',
      headers: { cookie },
    });
    expect(initialList.statusCode).toBe(200);
    expect(initialList.json().enabled).toBe(false);
    expect(initialList.json().shortcuts).toEqual([]);

    // Creating a shortcut while configurableShortcuts is OFF returns 403 and writes a denied audit entry
    const deniedCreate = await ctx.app.inject({
      method: 'POST',
      url: '/api/desktop/shortcuts',
      headers: { cookie },
      payload: {
        label: 'Voice Toggle',
        accelerator: 'Ctrl+Shift+M',
        action: 'toggle_voice',
      },
    });
    expect(deniedCreate.statusCode).toBe(403);
    expect(deniedCreate.json().error.code).toBe(ErrorCodes.PERMISSION_DENIED);

    // Enable configurableShortcuts individually — other OS capabilities stay OFF
    const toggleRes = await ctx.app.inject({
      method: 'PATCH',
      url: '/api/privacy/permissions',
      headers: { cookie },
      payload: { key: 'configurableShortcuts', enabled: true },
    });
    expect(toggleRes.statusCode).toBe(200);
    expect(toggleRes.json().permissions.configurableShortcuts).toBe(true);
    expect(toggleRes.json().permissions.appOpening).toBe(false);
    expect(toggleRes.json().permissions.fileRead).toBe(false);

    // Create a voice-toggle shortcut
    const createVoiceShortcut = await ctx.app.inject({
      method: 'POST',
      url: '/api/desktop/shortcuts',
      headers: { cookie },
      payload: {
        label: 'Voice Toggle',
        accelerator: 'ctrl+shift+m',
        action: 'toggle_voice',
      },
    });
    expect(createVoiceShortcut.statusCode).toBe(201);
    const shortcutId = createVoiceShortcut.json().shortcut.id as string;
    expect(createVoiceShortcut.json().shortcut.accelerator).toBe('Ctrl+Shift+M');

    // Reject duplicate accelerator
    const duplicateRes = await ctx.app.inject({
      method: 'POST',
      url: '/api/desktop/shortcuts',
      headers: { cookie },
      payload: {
        label: 'Duplicate',
        accelerator: 'Ctrl+Shift+M',
        action: 'focus_chat',
      },
    });
    expect(duplicateRes.statusCode).toBe(400);

    // Reject binding shortcut to arbitrary shell executable
    const shellShortcut = await ctx.app.inject({
      method: 'POST',
      url: '/api/desktop/shortcuts',
      headers: { cookie },
      payload: {
        label: 'Bad Shell',
        accelerator: 'Ctrl+Alt+S',
        action: 'open_approved_app',
        target: 'powershell.exe',
      },
    });
    expect(shellShortcut.statusCode).toBe(403);
    expect(shellShortcut.json().error.code).toBe(ErrorCodes.SHELL_EXECUTION_FORBIDDEN);

    // Trigger valid shortcut -> allowed audit log recorded
    const triggerVoice = await ctx.app.inject({
      method: 'POST',
      url: `/api/desktop/shortcuts/${shortcutId}/trigger`,
      headers: { cookie },
      payload: { source: 'web' },
    });
    expect(triggerVoice.statusCode).toBe(200);
    expect(triggerVoice.json().executed).toBe(true);

    // Add approved app and bind shortcut to it; triggering fails while appOpening is OFF
    await ctx.app.inject({
      method: 'POST',
      url: '/api/privacy/allowlist',
      headers: { cookie },
      payload: { kind: 'app', label: 'VS Code', target: 'C:\\Users\\ASUS\\AppData\\Local\\Programs\\Microsoft VS Code\\Code.exe' },
    });

    const appShortcutRes = await ctx.app.inject({
      method: 'POST',
      url: '/api/desktop/shortcuts',
      headers: { cookie },
      payload: {
        label: 'Launch Code',
        accelerator: 'Ctrl+Alt+C',
        action: 'open_approved_app',
        target: 'VS Code',
      },
    });
    expect(appShortcutRes.statusCode).toBe(201);
    const appShortcutId = appShortcutRes.json().shortcut.id as string;

    const triggerAppBlocked = await ctx.app.inject({
      method: 'POST',
      url: `/api/desktop/shortcuts/${appShortcutId}/trigger`,
      headers: { cookie },
      payload: {},
    });
    expect(triggerAppBlocked.statusCode).toBe(403);
    expect(triggerAppBlocked.json().error.code).toBe(ErrorCodes.PERMISSION_DENIED);

    // Enable appOpening -> trigger succeeds
    await ctx.app.inject({
      method: 'PATCH',
      url: '/api/privacy/permissions',
      headers: { cookie },
      payload: { key: 'appOpening', enabled: true },
    });
    const triggerAppAllowed = await ctx.app.inject({
      method: 'POST',
      url: `/api/desktop/shortcuts/${appShortcutId}/trigger`,
      headers: { cookie },
      payload: {},
    });
    expect(triggerAppAllowed.statusCode).toBe(200);

    // Revoke all desktop permissions resets configurableShortcuts back to false
    const revokeRes = await ctx.app.inject({
      method: 'POST',
      url: '/api/privacy/revoke-desktop',
      headers: { cookie },
      payload: {},
    });
    expect(revokeRes.statusCode).toBe(200);
    expect(revokeRes.json().permissions.configurableShortcuts).toBe(false);

    // Audit log recorded allowed & denied configurableShortcuts entries
    const auditRes = await ctx.app.inject({
      method: 'GET',
      url: '/api/privacy/audit-log?capability=configurableShortcuts',
      headers: { cookie },
    });
    expect(auditRes.statusCode).toBe(200);
    const entries = auditRes.json().entries as Array<{ outcome: string }>;
    expect(entries.some((e) => e.outcome === 'allowed')).toBe(true);
    expect(entries.some((e) => e.outcome === 'denied')).toBe(true);
  });

  it('renders Configurable Shortcuts toggle in PrivacyCenterView and panel in DesktopView', () => {
    const noopAsync = async () => {};
    const privacyHtml = renderToStaticMarkup(
      <PrivacyCenterView
        permissions={DEFAULT_PERMISSIONS_STATE}
        allowlist={[]}
        auditLogs={[]}
        conversationCount={0}
        session={{ authenticated: true, passcodeRequired: false, mode: 'local-dev', appEnv: 'test' }}
        wakeWordStatusMessage="Wake-word standby is OFF."
        onTogglePermission={noopAsync}
        onRevokeAllDesktop={noopAsync}
        onAddAllowlist={noopAsync}
        onRemoveAllowlist={noopAsync}
        onRefreshAuditLogs={noopAsync}
        onExportData={noopAsync}
        onClearConversations={noopAsync}
        onLogout={noopAsync}
      />,
    );
    expect(privacyHtml).toContain('Toggle Configurable Shortcuts');
    expect(privacyHtml).toContain('aria-label="Toggle Configurable Shortcuts"');

    const desktopHtml = renderToStaticMarkup(
      <DesktopView
        permissions={DEFAULT_PERMISSIONS_STATE}
        allowlist={[]}
        shortcuts={[
          {
            id: 'sc-1',
            label: 'Voice Toggle',
            accelerator: 'Ctrl+Shift+M',
            action: 'toggle_voice',
            createdAt: '2026-11-27T11:00:00.000Z',
          },
        ]}
        onAuditUpdated={noopAsync}
        onShortcutsUpdated={noopAsync}
        onNavigatePrivacy={() => {}}
      />,
    );
    expect(desktopHtml).toContain('Configurable Shortcuts');
    expect(desktopHtml).toContain('Ctrl+Shift+M');
  });
});
