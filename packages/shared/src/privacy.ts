import { z } from 'zod';

export type OsCapabilityKey =
  | 'appOpening'
  | 'fileRead'
  | 'fileWrite'
  | 'systemMonitoring'
  | 'notifications'
  | 'clipboardWrite'
  | 'webLaunch'
  | 'wakeWordStandby';

export type PrivacyControlKey =
  | 'microphoneAccess'
  | 'voiceSessionAccess'
  | 'externalWebServices';

export type ControllablePermissionKey = OsCapabilityKey | PrivacyControlKey;

export type AuditOutcome = 'allowed' | 'denied' | 'cancelled' | 'error';
export type AuditSource = 'web' | 'server' | 'desktop-tauri';

export interface PermissionsStateDTO {
  // OS-level capability classes (Section 14) — ALL ship OFF, enabled individually
  appOpening: boolean;
  fileRead: boolean;
  fileWrite: boolean;
  systemMonitoring: boolean;
  notifications: boolean;
  clipboardWrite: boolean;
  webLaunch: boolean;
  wakeWordStandby: boolean;

  // Privacy & service controls (Section 15)
  microphoneAccess: boolean;
  voiceSessionAccess: boolean;
  externalWebServices: boolean;

  // Stage 3 deferred categories — strictly OFF and non-activatable in Stage 4
  memoryAccess: false;
  optionalAutomation: false;
  cloudFileProcessing: false;
}

export const DEFAULT_PERMISSIONS_STATE: PermissionsStateDTO = {
  appOpening: false,
  fileRead: false,
  fileWrite: false,
  systemMonitoring: false,
  notifications: false,
  clipboardWrite: false,
  webLaunch: false,
  wakeWordStandby: false,
  microphoneAccess: true,
  voiceSessionAccess: true,
  externalWebServices: true,
  memoryAccess: false,
  optionalAutomation: false,
  cloudFileProcessing: false,
};

export const OS_CAPABILITY_KEYS: readonly OsCapabilityKey[] = [
  'appOpening',
  'fileRead',
  'fileWrite',
  'systemMonitoring',
  'notifications',
  'clipboardWrite',
  'webLaunch',
  'wakeWordStandby',
];

export const ControllablePermissionKeySchema = z.enum([
  'appOpening',
  'fileRead',
  'fileWrite',
  'systemMonitoring',
  'notifications',
  'clipboardWrite',
  'webLaunch',
  'wakeWordStandby',
  'microphoneAccess',
  'voiceSessionAccess',
  'externalWebServices',
]);

/**
 * Enforces individual per-capability opt-in (no bundled master switch).
 * `.strict()` rejects any unexpected bundled keys such as `desktopIntegration`.
 */
export const UpdateSinglePermissionSchema = z
  .object({
    key: ControllablePermissionKeySchema,
    enabled: z.boolean(),
  })
  .strict();

export type AllowlistKind = 'app' | 'folder' | 'web_domain';

export interface AllowlistEntryDTO {
  id: string;
  kind: AllowlistKind;
  label: string;
  target: string;
  createdAt: string;
}

export const CreateAllowlistEntrySchema = z
  .object({
    kind: z.enum(['app', 'folder', 'web_domain']),
    label: z.string().trim().min(1, 'Label is required').max(80),
    target: z.string().trim().min(1, 'Target path or domain is required').max(300),
  })
  .strict();

export interface AuditLogEntryDTO {
  id: string;
  timestamp: string;
  capability: string;
  action: string;
  target: string;
  outcome: AuditOutcome;
  source: AuditSource;
  detail?: string | null;
}

export const CreateAuditLogSchema = z
  .object({
    capability: z.string().trim().min(1).max(60),
    action: z.string().trim().min(1).max(120),
    target: z.string().trim().min(1).max(240),
    outcome: z.enum(['allowed', 'denied', 'cancelled', 'error']),
    source: z.enum(['web', 'server', 'desktop-tauri']),
    detail: z.string().trim().max(400).optional(),
  })
  .strict();

export const ValidateDesktopActionSchema = z
  .object({
    capability: z.enum([
      'appOpening',
      'fileRead',
      'fileWrite',
      'systemMonitoring',
      'notifications',
      'clipboardWrite',
      'webLaunch',
    ]),
    action: z.string().trim().min(1).max(120),
    target: z.string().trim().min(1).max(400),
    confirmed: z.boolean().optional(),
    source: z.enum(['web', 'desktop-tauri']).optional(),
  })
  .strict();

export interface HostTelemetryDTO {
  source: 'local-windows-host' | 'windows-tauri-os';
  platform: string;
  osRelease: string;
  arch: string;
  cpuModel: string;
  cpuCores: number;
  cpuUsagePercent: number | null;
  memoryTotalBytes: number;
  memoryUsedBytes: number;
  memoryUsagePercent: number;
  uptimeSeconds: number;
  storage: Array<{
    mount: string;
    totalBytes: number;
    availableBytes: number;
  }>;
  battery: {
    percent: number | null;
    charging: boolean | null;
    sourceNote: string;
  } | null;
  networkConnected: boolean | null;
  adminElevated: false;
  collectedAt: string;
}

export const ADMIN_PRIVILEGE_POLICY = {
  requiresAdmin: false,
  executionLevel: 'asInvoker' as const,
  summary:
    'MJ Assistant runs strictly with standard user privileges (asInvoker) and never requests Windows UAC elevation.',
  adminOnlyExceptionName:
    'System-wide machine administration (writing under C:\\Windows or C:\\Program Files, installing machine-wide software, or reading protected system/other-user directories) — intentionally NOT implemented in MJ Assistant.',
};

const FORBIDDEN_SHELL_EXECUTABLES = new Set([
  'cmd',
  'cmd.exe',
  'powershell',
  'powershell.exe',
  'pwsh',
  'pwsh.exe',
  'bash',
  'bash.exe',
  'sh',
  'sh.exe',
  'wsl',
  'wsl.exe',
  'wscript',
  'wscript.exe',
  'cscript',
  'cscript.exe',
  'mshta',
  'mshta.exe',
  'rundll32',
  'rundll32.exe',
  'regsvr32',
  'regsvr32.exe',
  'conhost',
  'conhost.exe',
]);

const SHELL_METACHAR_REGEX = /[|&;`$><\r\n"']/;

export function isForbiddenShellTarget(target: string): boolean {
  const trimmed = target.trim();
  if (!trimmed || SHELL_METACHAR_REGEX.test(trimmed)) return true;
  const normalized = trimmed.replace(/\\/g, '/').toLowerCase();
  const baseName = normalized.split('/').pop() ?? normalized;
  return FORBIDDEN_SHELL_EXECUTABLES.has(baseName);
}

export function isProtectedSystemPath(targetPath: string): boolean {
  const normalized = targetPath.trim().replace(/\\/g, '/').toLowerCase();
  if (normalized.includes('..')) return true;
  const blockedPrefixes = [
    'c:/windows',
    'c:/program files',
    'c:/program files (x86)',
    'c:/programdata',
    '/windows',
    '/etc',
    '/usr',
    '/bin',
    '/sbin',
    '/system',
  ];
  return blockedPrefixes.some(
    (prefix) => normalized === prefix || normalized.startsWith(`${prefix}/`),
  );
}

export function normalizeWebDomainTarget(rawTarget: string): string | null {
  const trimmed = rawTarget.trim();
  if (!trimmed || SHELL_METACHAR_REGEX.test(trimmed)) return null;
  try {
    const withScheme = trimmed.includes('://') ? trimmed : `https://${trimmed}`;
    const url = new URL(withScheme);
    if (url.protocol !== 'https:' && url.hostname !== 'localhost' && url.hostname !== '127.0.0.1') {
      return null;
    }
    return url.hostname.toLowerCase();
  } catch {
    return null;
  }
}

export function isApprovedHttpsUrl(rawUrl: string, approvedDomains: string[]): string | null {
  const trimmed = rawUrl.trim();
  if (!trimmed || SHELL_METACHAR_REGEX.test(trimmed)) return null;
  try {
    const parsed = new URL(trimmed);
    const isLocalhostHttp =
      parsed.protocol === 'http:' &&
      (parsed.hostname === 'localhost' || parsed.hostname === '127.0.0.1');
    if (parsed.protocol !== 'https:' && !isLocalhostHttp) {
      return null;
    }
    const host = parsed.hostname.toLowerCase();
    const allowed = approvedDomains.some(
      (domain) => host === domain.toLowerCase() || host.endsWith(`.${domain.toLowerCase()}`),
    );
    return allowed ? parsed.toString() : null;
  } catch {
    return null;
  }
}
