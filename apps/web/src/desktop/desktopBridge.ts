import type {
  AllowlistKind,
  AuditOutcome,
  AuditSource,
  HostTelemetryDTO,
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

export async function tauriOpenApprovedApp(
  executablePath: string,
  approvedApps: string[],
): Promise<void> {
  await invokeTauri('desktop_open_app', {
    executablePath,
    approvedApps,
  });
}

export async function tauriOpenApprovedUrl(
  url: string,
  approvedDomains: string[],
): Promise<void> {
  await invokeTauri('desktop_open_url', {
    url,
    approvedDomains,
  });
}

export async function tauriSearchApprovedFiles(
  folderPath: string,
  query: string,
  approvedFolders: string[],
): Promise<Array<{ name: string; path: string; sizeBytes: number }>> {
  return invokeTauri('desktop_search_files', {
    folderPath,
    query,
    approvedFolders,
  });
}

export async function tauriOrganizeApprovedFolder(
  folderPath: string,
  approvedFolders: string[],
  confirmed: boolean,
): Promise<{ movedCount: number; skippedCount: number; details: string[] }> {
  return invokeTauri('desktop_organize_files', {
    folderPath,
    approvedFolders,
    confirmed,
  });
}

export async function tauriSendNotification(title: string, body: string): Promise<void> {
  await invokeTauri('desktop_send_notification', { title, body });
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
