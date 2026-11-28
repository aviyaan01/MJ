import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it } from 'vitest';
import {
  ALLOWLISTED_DESKTOP_SHORTCUTS,
  DEFAULT_PERMISSIONS_STATE,
  ErrorCodes,
  OS_CAPABILITY_KEYS,
  UpdateSinglePermissionSchema,
} from '@mj/shared';
import { createDefaultToolRegistry } from '@mj/ai';
import { buildServer, type MjServerContext } from '../apps/server/src/app.js';
import { loadServerConfig } from '../apps/server/src/config.js';
import { PrivacyCenterView } from '../apps/web/src/components/PrivacyCenterView.js';

const NEW_DESKTOP_PERMISSION_KEYS = [
  'appClosing',
  'volumeControl',
  'brightnessControl',
  'lockScreen',
  'sleepDisplay',
  'windowControl',
  'textTyping',
  'shortcutPress',
  'pcShutdown',
  'pcRestart',
  'pcSleep',
  'pcLogoff',
] as const;

async function createAuthedServer(options?: { toolConfirmationTimeoutMs?: number }) {
  const config = loadServerConfig({
    APP_ENV: 'test',
    FREE_ONLY_MODE: 'true',
    GEMINI_API_KEY: 'gemini-desktop-tools-test-key',
    GEMINI_TEXT_MODEL: 'gemini-2.5-flash',
    DATABASE_URL: ':memory:',
    AUTH_SECRET: 'test-signing-secret-must-be-at-least-32-bytes-long',
    CORS_ORIGIN: 'http://localhost:5173',
  });
  const ctx = await buildServer({
    config,
    toolConfirmationTimeoutMs: options?.toolConfirmationTimeoutMs,
  });
  const loginRes = await ctx.app.inject({ method: 'POST', url: '/api/auth/login', payload: {} });
  const cookie = String(loginRes.headers['set-cookie']).split(';')[0]!;
  return { ctx, cookie };
}

describe('Desktop Tools, Granular Permissions & Tauri Rust Hardening', () => {
  const contexts: MjServerContext[] = [];

  afterEach(async () => {
    while (contexts.length > 0) {
      const ctx = contexts.pop()!;
      await ctx.app.close();
      ctx.dbHandle.close();
    }
  });

  it('ships every desktop control and power permission OFF and supports individual toggles + revoke-all', async () => {
    for (const key of NEW_DESKTOP_PERMISSION_KEYS) {
      expect(OS_CAPABILITY_KEYS).toContain(key);
      expect(DEFAULT_PERMISSIONS_STATE[key]).toBe(false);
      expect(UpdateSinglePermissionSchema.safeParse({ key, enabled: true }).success).toBe(true);
    }

    const { ctx, cookie } = await createAuthedServer();
    contexts.push(ctx);

    const enableSleep = await ctx.app.inject({
      method: 'PATCH',
      url: '/api/privacy/permissions',
      headers: { cookie },
      payload: { key: 'pcSleep', enabled: true },
    });
    expect(enableSleep.statusCode).toBe(200);
    expect(enableSleep.json().permissions.pcSleep).toBe(true);
    expect(enableSleep.json().permissions.pcShutdown).toBe(false);
    expect(enableSleep.json().permissions.pcRestart).toBe(false);
    expect(enableSleep.json().permissions.pcLogoff).toBe(false);

    const revokeRes = await ctx.app.inject({
      method: 'POST',
      url: '/api/privacy/revoke-desktop',
      headers: { cookie },
      payload: {},
    });
    expect(revokeRes.statusCode).toBe(200);
    expect(revokeRes.json().permissions.pcSleep).toBe(false);
  });

  it('gates volume, brightness, lock, sleep display, window actions, close app, shortcut, and telemetry behind individual permissions & bounds', async () => {
    const { ctx, cookie } = await createAuthedServer();
    contexts.push(ctx);

    await ctx.app.inject({
      method: 'PATCH',
      url: '/api/privacy/permissions',
      headers: { cookie },
      payload: { key: 'toolCalling', enabled: true },
    });

    // All hardware/window/shortcut/close tools MUST remain denied while their toggles are OFF
    for (const call of [
      { name: 'volume_set', args: { level: 40 } },
      { name: 'volume_mute', args: {} },
      { name: 'brightness_set', args: { level: 70 } },
      { name: 'lock_screen', args: {} },
      { name: 'sleep_display', args: {} },
      { name: 'window_action', args: { action: 'minimize_all' } },
      { name: 'close_approved_app', args: { target: 'C:\\Users\\ASUS\\Apps\\Code.exe' } },
      { name: 'press_shortcut', args: { shortcut: 'Ctrl+C' } },
      { name: 'get_battery_cpu_ram_status', args: {} },
    ]) {
      const denied = (
        await ctx.app.inject({
          method: 'POST',
          url: '/api/voice/tools/execute',
          headers: { cookie },
          payload: call,
        })
      ).json();
      expect(denied.ok).toBe(false);
      expect(denied.status).toBe('denied');
    }

    // Enable safe desktop capability toggles individually
    for (const key of [
      'volumeControl',
      'brightnessControl',
      'lockScreen',
      'sleepDisplay',
      'windowControl',
      'shortcutPress',
      'appClosing',
      'systemMonitoring',
    ]) {
      await ctx.app.inject({
        method: 'PATCH',
        url: '/api/privacy/permissions',
        headers: { cookie },
        payload: { key, enabled: true },
      });
    }

    // Rejects out-of-range volume / brightness and dangerous shortcuts / unallowlisted apps
    const badVolume = (
      await ctx.app.inject({
        method: 'POST',
        url: '/api/voice/tools/execute',
        headers: { cookie },
        payload: { name: 'volume_set', args: { level: 150 } },
      })
    ).json();
    expect(badVolume.ok).toBe(false);
    expect(badVolume.status).toBe('error');

    const badShortcut = (
      await ctx.app.inject({
        method: 'POST',
        url: '/api/voice/tools/execute',
        headers: { cookie },
        payload: { name: 'press_shortcut', args: { shortcut: 'Alt+F4' } },
      })
    ).json();
    expect(badShortcut.ok).toBe(false);
    expect(badShortcut.status).toBe('error');

    const badShellClose = (
      await ctx.app.inject({
        method: 'POST',
        url: '/api/voice/tools/execute',
        headers: { cookie },
        payload: { name: 'close_approved_app', args: { target: 'C:\\Windows\\System32\\cmd.exe' } },
      })
    ).json();
    expect(badShellClose.ok).toBe(false);
    expect(badShellClose.status).toBe('denied');
    expect(badShellClose.errorCode).toBe(ErrorCodes.SHELL_EXECUTION_FORBIDDEN);

    const unapprovedClose = (
      await ctx.app.inject({
        method: 'POST',
        url: '/api/voice/tools/execute',
        headers: { cookie },
        payload: { name: 'close_approved_app', args: { target: 'C:\\Users\\ASUS\\Apps\\Code.exe' } },
      })
    ).json();
    expect(unapprovedClose.ok).toBe(false);
    expect(unapprovedClose.status).toBe('denied');

    // Allowlist Code.exe and execute all safe desktop tools cleanly
    await ctx.app.inject({
      method: 'POST',
      url: '/api/privacy/allowlist',
      headers: { cookie },
      payload: { kind: 'app', label: 'VS Code', target: 'C:\\Users\\ASUS\\Apps\\Code.exe' },
    });

    const volOk = (
      await ctx.app.inject({
        method: 'POST',
        url: '/api/voice/tools/execute',
        headers: { cookie },
        payload: { name: 'volume_set', args: { level: 55 } },
      })
    ).json();
    expect(volOk.ok).toBe(true);
    expect(volOk.clientAction).toEqual({ kind: 'volume_set', level: 55 });

    const brightOk = (
      await ctx.app.inject({
        method: 'POST',
        url: '/api/voice/tools/execute',
        headers: { cookie },
        payload: { name: 'brightness_set', args: { level: 80 } },
      })
    ).json();
    expect(brightOk.ok).toBe(true);
    expect(brightOk.clientAction).toEqual({ kind: 'brightness_set', level: 80 });

    const winOk = (
      await ctx.app.inject({
        method: 'POST',
        url: '/api/voice/tools/execute',
        headers: { cookie },
        payload: { name: 'window_action', args: { action: 'close_tab' } },
      })
    ).json();
    expect(winOk.ok).toBe(true);
    expect(winOk.clientAction).toEqual({ kind: 'window_action', action: 'close_tab' });

    const shortcutOk = (
      await ctx.app.inject({
        method: 'POST',
        url: '/api/voice/tools/execute',
        headers: { cookie },
        payload: { name: 'press_shortcut', args: { shortcut: 'Ctrl+W' } },
      })
    ).json();
    expect(shortcutOk.ok).toBe(true);
    expect(shortcutOk.clientAction).toEqual({ kind: 'press_shortcut', shortcut: 'Ctrl+W' });

    const closeOk = (
      await ctx.app.inject({
        method: 'POST',
        url: '/api/voice/tools/execute',
        headers: { cookie },
        payload: { name: 'close_approved_app', args: { target: 'VS Code' } },
      })
    ).json();
    expect(closeOk.ok).toBe(true);
    expect(closeOk.clientAction).toEqual({
      kind: 'close_approved_app',
      target: 'C:\\Users\\ASUS\\Apps\\Code.exe',
    });

    const statsOk = (
      await ctx.app.inject({
        method: 'POST',
        url: '/api/voice/tools/execute',
        headers: { cookie },
        payload: { name: 'get_battery_cpu_ram_status', args: {} },
      })
    ).json();
    expect(statsOk.ok).toBe(true);
    expect(statsOk.result.cpu.cores).toBeGreaterThanOrEqual(1);
    expect(statsOk.result.ram.totalBytes).toBeGreaterThan(0);
  });

  it('requires risk=confirm with voice/UI confirmation & 20s timeout for type_text and power actions', async () => {
    const { ctx, cookie } = await createAuthedServer({ toolConfirmationTimeoutMs: 70 });
    contexts.push(ctx);

    const registry = createDefaultToolRegistry();
    expect(registry.get('type_text')?.risk).toBe('confirm');
    expect(registry.get('pc_shutdown')?.risk).toBe('confirm');
    expect(registry.get('pc_restart')?.risk).toBe('confirm');
    expect(registry.get('pc_sleep')?.risk).toBe('confirm');
    expect(registry.get('pc_logoff')?.risk).toBe('confirm');

    for (const key of ['toolCalling', 'textTyping', 'pcSleep', 'pcShutdown', 'pcLogoff']) {
      await ctx.app.inject({
        method: 'PATCH',
        url: '/api/privacy/permissions',
        headers: { cookie },
        payload: { key, enabled: true },
      });
    }

    // pcRestart was NOT enabled -> still denied cleanly
    const restartDenied = (
      await ctx.app.inject({
        method: 'POST',
        url: '/api/voice/tools/execute',
        headers: { cookie },
        payload: { name: 'pc_restart', args: {} },
      })
    ).json();
    expect(restartDenied.ok).toBe(false);
    expect(restartDenied.status).toBe('denied');

    // type_text rejects control characters (e.g. newlines/ESC) before prompting confirmation
    const unsafeText = (
      await ctx.app.inject({
        method: 'POST',
        url: '/api/voice/tools/execute',
        headers: { cookie },
        payload: { name: 'type_text', args: { text: 'whoami\r\n' } },
      })
    ).json();
    expect(unsafeText.ok).toBe(false);
    expect(unsafeText.status).toBe('denied');

    // type_text valid payload -> prompts confirmation, approved via English/Bangla voice "haan"
    const pendingType = (
      await ctx.app.inject({
        method: 'POST',
        url: '/api/voice/tools/execute',
        headers: { cookie },
        payload: { name: 'type_text', args: { text: 'Hello from MJ!' } },
      })
    ).json();
    expect(pendingType.status).toBe('confirmation_required');

    const typeConfirmed = (
      await ctx.app.inject({
        method: 'POST',
        url: '/api/tools/confirm',
        headers: { cookie },
        payload: {
          confirmationId: pendingType.pendingConfirmation.confirmationId,
          spokenText: 'haan',
        },
      })
    ).json();
    expect(typeConfirmed.ok).toBe(true);
    expect(typeConfirmed.status).toBe('executed');
    expect(typeConfirmed.clientAction).toEqual({ kind: 'type_text', text: 'Hello from MJ!' });

    // pc_sleep confirmed via Bangla "করো"
    const pendingSleep = (
      await ctx.app.inject({
        method: 'POST',
        url: '/api/voice/tools/execute',
        headers: { cookie },
        payload: { name: 'pc_sleep', args: {} },
      })
    ).json();
    expect(pendingSleep.status).toBe('confirmation_required');

    const sleepConfirmed = (
      await ctx.app.inject({
        method: 'POST',
        url: '/api/tools/confirm',
        headers: { cookie },
        payload: {
          confirmationId: pendingSleep.pendingConfirmation.confirmationId,
          spokenText: 'করো',
        },
      })
    ).json();
    expect(sleepConfirmed.ok).toBe(true);
    expect(sleepConfirmed.clientAction).toEqual({ kind: 'power_action', action: 'sleep' });

    // pc_shutdown cancelled via Bangla "না"
    const pendingShutdown = (
      await ctx.app.inject({
        method: 'POST',
        url: '/api/voice/tools/execute',
        headers: { cookie },
        payload: { name: 'pc_shutdown', args: {} },
      })
    ).json();
    const shutdownCancelled = (
      await ctx.app.inject({
        method: 'POST',
        url: '/api/tools/confirm',
        headers: { cookie },
        payload: {
          confirmationId: pendingShutdown.pendingConfirmation.confirmationId,
          spokenText: 'না',
        },
      })
    ).json();
    expect(shutdownCancelled.ok).toBe(false);
    expect(shutdownCancelled.status).toBe('cancelled');

    // pc_logoff expires after timeout -> timed_out
    const pendingLogoff = (
      await ctx.app.inject({
        method: 'POST',
        url: '/api/voice/tools/execute',
        headers: { cookie },
        payload: { name: 'pc_logoff', args: {} },
      })
    ).json();
    await new Promise((r) => setTimeout(r, 110));
    const logoffTimeout = (
      await ctx.app.inject({
        method: 'POST',
        url: '/api/tools/confirm',
        headers: { cookie },
        payload: {
          confirmationId: pendingLogoff.pendingConfirmation.confirmationId,
          decision: 'approve',
        },
      })
    ).json();
    expect(logoffTimeout.ok).toBe(false);
    expect(logoffTimeout.status).toBe('timed_out');
  });

  it('keeps Tauri Rust desktop commands, allowlists, and permission toggles synchronized and free of shell invocations', () => {
    const tauriRoot = resolve(process.cwd(), 'apps', 'desktop', 'src-tauri');
    const permsRs = readFileSync(resolve(tauriRoot, 'src', 'permissions.rs'), 'utf8');
    const controlsRs = readFileSync(resolve(tauriRoot, 'src', 'desktop_controls.rs'), 'utf8');
    const monitorRs = readFileSync(resolve(tauriRoot, 'src', 'system_monitor.rs'), 'utf8');
    const libRs = readFileSync(resolve(tauriRoot, 'src', 'lib.rs'), 'utf8');

    for (const key of NEW_DESKTOP_PERMISSION_KEYS) {
      expect(permsRs).toContain(`"${key}"`);
    }

    // No shell binary/command invocation anywhere in desktop_controls.rs (outside test fixture strings)
    const controlsNonTest = controlsRs.split('#[cfg(test)]')[0] ?? controlsRs;
    expect(controlsNonTest).not.toContain('Command::new');
    expect(controlsNonTest).not.toContain('powershell');
    expect(controlsNonTest).not.toContain('taskkill');
    expect(controlsNonTest).not.toContain('shutdown.exe');

    for (const shortcut of ALLOWLISTED_DESKTOP_SHORTCUTS) {
      expect(controlsRs).toContain(`"${shortcut}"`);
    }

    for (const cmd of [
      'desktop_controls::desktop_get_battery_cpu_ram_status',
      'desktop_controls::desktop_volume_set',
      'desktop_controls::desktop_volume_mute',
      'desktop_controls::desktop_brightness_set',
      'desktop_controls::desktop_lock_screen',
      'desktop_controls::desktop_sleep_display',
      'desktop_controls::desktop_window_action',
      'desktop_controls::desktop_close_app',
      'desktop_controls::desktop_type_text',
      'desktop_controls::desktop_press_shortcut',
      'desktop_controls::desktop_power_action',
    ]) {
      expect(libRs).toContain(cmd);
    }

    expect(monitorRs).toContain('collect_battery_cpu_ram_status');
    expect(monitorRs).toContain('GetSystemPowerStatus');

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
    expect(privacyHtml).toContain('System Volume &amp; Mute Control');
    expect(privacyHtml).toContain('Power Action: Shut Down PC');
    expect(privacyHtml).toContain('Power Action: Sleep PC');
  });
});
