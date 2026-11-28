import type {
  AllowlistedDesktopShortcut,
  AllowlistKind,
  AuditOutcome,
  AuditSource,
  DesktopPowerActionKind,
  DesktopWindowActionKind,
  HostTelemetryDTO,
  PermissionsStateDTO,
} from '@mj/shared';

interface TauriInternals {
  invoke: <T = unknown>(cmd: string, args?: Record<string, unknown>) => Promise<T>;
}

function getTauri(): TauriInternals | null {
  if (typeof window === 'undefined') return null;
  const w = window as unknown as { __TAURI_INTERNALS__?: TauriInternals };
  return w.__TAURI_INTERNALS__ ?? null;
}

export function isTauriDesktop(): boolean {
  return getTauri() !== null;
}

export async function invokeTauri<T = unknown>(
  cmd: string,
  args?: Record<string, unknown>,
): Promise<T> {
  const tauri = getTauri();
  if (!tauri) {
    throw new Error('This operation requires the MJ Assistant Windows Tauri Desktop Companion.');
  }
  return tauri.invoke<T>(cmd, args);
}

export async function syncTauriMicTray(
  active: boolean,
  wakeWordStandby: boolean,
): Promise<void> {
  const tauri = getTauri();
  if (!tauri) return;
  try {
    await tauri.invoke('desktop_sync_mic_tray', { active, wakeWordStandby });
  } catch {
    // ignore tray sync errors
  }
}

export async function tauriSetSinglePermission(
  key: string,
  enabled: boolean,
): Promise<void> {
  const tauri = getTauri();
  if (!tauri) return;
  await tauri.invoke('desktop_set_permission', { key, enabled });
}

export async function tauriGetPermissions(): Promise<Partial<PermissionsStateDTO> | null> {
  const tauri = getTauri();
  if (!tauri) return null;
  try {
    return await tauri.invoke<Partial<PermissionsStateDTO>>('desktop_get_permissions');
  } catch {
    return null;
  }
}

export async function tauriRevokeAllPermissions(): Promise<void> {
  const tauri = getTauri();
  if (!tauri) return;
  await tauri.invoke('desktop_revoke_all');
}

export async function tauriGetNativeTelemetry(): Promise<HostTelemetryDTO | null> {
  const tauri = getTauri();
  if (!tauri) return null;
  return tauri.invoke<HostTelemetryDTO>('desktop_get_system_status');
}

export interface NativeDesktopAllowlist {
  approvedApps: string[];
  approvedDomains: string[];
  approvedFolders: string[];
}

export async function tauriGetNativeAllowlist(): Promise<NativeDesktopAllowlist> {
  return invokeTauri<NativeDesktopAllowlist>('desktop_get_allowlist');
}

export async function tauriNativePickApprovedApp(): Promise<string | null> {
  return invokeTauri<string | null>('desktop_pick_and_approve_app');
}

export async function tauriNativePickApprovedFolder(): Promise<string | null> {
  return invokeTauri<string | null>('desktop_pick_and_approve_folder');
}

export async function tauriNativeApproveDomain(domain: string): Promise<boolean> {
  return invokeTauri<boolean>('desktop_approve_domain_native', { domain });
}

export async function tauriRemoveNativeAllowlistEntry(
  kind: AllowlistKind,
  target: string,
): Promise<NativeDesktopAllowlist> {
  return invokeTauri<NativeDesktopAllowlist>('desktop_remove_allowlist_entry', { kind, target });
}

export async function tauriOpenApprovedApp(executablePath: string): Promise<void> {
  await invokeTauri('desktop_open_app', {
    executablePath,
  });
}

export async function tauriOpenApprovedUrl(url: string): Promise<void> {
  await invokeTauri('desktop_open_url', {
    url,
  });
}

export async function tauriSearchApprovedFiles(
  folderPath: string,
  query: string,
): Promise<Array<{ name: string; path: string; sizeBytes: number }>> {
  return invokeTauri('desktop_search_files', {
    folderPath,
    query,
  });
}

export async function tauriOrganizeApprovedFolder(
  folderPath: string,
  confirmed: boolean,
): Promise<{ movedCount: number; skippedCount: number; details: string[] }> {
  return invokeTauri('desktop_organize_files', {
    folderPath,
    confirmed,
  });
}

export async function tauriSendNotification(title: string, body: string): Promise<void> {
  await invokeTauri('desktop_send_notification', { title, body });
}

export async function tauriValidateShortcutTrigger(
  accelerator: string,
  action: string,
): Promise<void> {
  await invokeTauri('desktop_validate_shortcut_trigger', { accelerator, action });
}

export async function tauriGetBatteryCpuRamStatus(): Promise<Record<string, unknown> | null> {
  const tauri = getTauri();
  if (!tauri) return null;
  return tauri.invoke<Record<string, unknown>>('desktop_get_battery_cpu_ram_status');
}

export async function tauriSetVolume(level: number): Promise<number> {
  return invokeTauri<number>('desktop_volume_set', { level });
}

export async function tauriMuteVolume(muted?: boolean): Promise<void> {
  await invokeTauri('desktop_volume_mute', muted !== undefined ? { muted } : {});
}

export async function tauriSetBrightness(level: number): Promise<number> {
  return invokeTauri<number>('desktop_brightness_set', { level });
}

export async function tauriLockScreen(): Promise<void> {
  await invokeTauri('desktop_lock_screen');
}

export async function tauriSleepDisplay(): Promise<void> {
  await invokeTauri('desktop_sleep_display');
}

export async function tauriWindowAction(action: DesktopWindowActionKind): Promise<string> {
  return invokeTauri<string>('desktop_window_action', { action });
}

export async function tauriCloseApprovedApp(
  executablePath: string,
): Promise<{ target: string; closedCount: number }> {
  return invokeTauri<{ target: string; closedCount: number }>('desktop_close_app', {
    executablePath,
  });
}

export async function tauriTypeText(text: string, confirmed: boolean): Promise<number> {
  return invokeTauri<number>('desktop_type_text', { text, confirmed });
}

export async function tauriPressShortcut(
  shortcut: AllowlistedDesktopShortcut,
): Promise<string> {
  return invokeTauri<string>('desktop_press_shortcut', { shortcut });
}

export async function tauriPowerAction(
  action: DesktopPowerActionKind,
  confirmed: boolean,
): Promise<string> {
  return invokeTauri<string>('desktop_power_action', { action, confirmed });
}

export interface BrowserTelemetrySnapshot {
  source: 'browser-sandbox';
  online: boolean;
  hardwareConcurrency: number | null;
  deviceMemoryGb: number | null;
  platform: string;
  language: string;
  userAgent: string;
}

export function readBrowserTelemetry(): BrowserTelemetrySnapshot {
  if (typeof navigator === 'undefined') {
    return {
      source: 'browser-sandbox',
      online: true,
      hardwareConcurrency: null,
      deviceMemoryGb: null,
      platform: 'Browser',
      language: 'en-US',
      userAgent: 'ServerRender',
    };
  }
  const nav = navigator as Navigator & {
    deviceMemory?: number;
    userAgentData?: { platform?: string };
  };
  return {
    source: 'browser-sandbox',
    online: typeof navigator.onLine === 'boolean' ? navigator.onLine : true,
    hardwareConcurrency:
      typeof navigator.hardwareConcurrency === 'number' ? navigator.hardwareConcurrency : null,
    deviceMemoryGb: typeof nav.deviceMemory === 'number' ? nav.deviceMemory : null,
    platform: nav.userAgentData?.platform || navigator.platform || 'Browser',
    language: navigator.language || 'en-US',
    userAgent: navigator.userAgent || 'Browser',
  };
}

export type AuditSink = (entry: {
  capability: string;
  action: string;
  target: string;
  outcome: AuditOutcome;
  source: AuditSource;
  detail?: string;
}) => Promise<void>;

export type { AllowlistKind };
