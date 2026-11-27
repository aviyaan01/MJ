import {
  DEFAULT_PERMISSIONS_STATE,
  OS_CAPABILITY_KEYS,
  type AuditSource,
  type ControllablePermissionKey,
  type PermissionsStateDTO,
} from '@mj/shared';
import type { MjDatabaseRepository } from '@mj/database';

const PERMISSIONS_STORAGE_KEY = 'mj.permissions.v1';

export class PermissionsStore {
  private cachedPermissions: PermissionsStateDTO | null = null;

  constructor(private readonly repo: MjDatabaseRepository) {}

  public async getPermissions(): Promise<PermissionsStateDTO> {
    if (this.cachedPermissions) {
      return { ...this.cachedPermissions };
    }

    const saved =
      (await this.repo.getStoredSettings<Partial<PermissionsStateDTO>>(
        PERMISSIONS_STORAGE_KEY,
      )) ?? {};

    const resolved: PermissionsStateDTO = {
      ...DEFAULT_PERMISSIONS_STATE,
      appOpening: Boolean(saved.appOpening ?? false),
      fileRead: Boolean(saved.fileRead ?? false),
      fileWrite: Boolean(saved.fileWrite ?? false),
      systemMonitoring: Boolean(saved.systemMonitoring ?? false),
      notifications: Boolean(saved.notifications ?? false),
      clipboardWrite: Boolean(saved.clipboardWrite ?? false),
      webLaunch: Boolean(saved.webLaunch ?? false),
      wakeWordStandby: Boolean(saved.wakeWordStandby ?? false),
      configurableShortcuts: Boolean(saved.configurableShortcuts ?? false),
      microphoneAccess:
        saved.microphoneAccess !== undefined
          ? Boolean(saved.microphoneAccess)
          : DEFAULT_PERMISSIONS_STATE.microphoneAccess,
      voiceSessionAccess:
        saved.voiceSessionAccess !== undefined
          ? Boolean(saved.voiceSessionAccess)
          : DEFAULT_PERMISSIONS_STATE.voiceSessionAccess,
      externalWebServices:
        saved.externalWebServices !== undefined
          ? Boolean(saved.externalWebServices)
          : DEFAULT_PERMISSIONS_STATE.externalWebServices,
      // Stage 3 categories stay locked OFF in Stage 4/5
      memoryAccess: false,
      optionalAutomation: false,
      cloudFileProcessing: false,
    };

    this.cachedPermissions = resolved;
    return { ...resolved };
  }

  public async setSinglePermission(
    key: ControllablePermissionKey,
    enabled: boolean,
    source: AuditSource = 'web',
  ): Promise<PermissionsStateDTO> {
    const current = await this.getPermissions();
    const updated: PermissionsStateDTO = {
      ...current,
      [key]: enabled,
      // If microphone is disabled, wake-word standby must also turn OFF
      ...(key === 'microphoneAccess' && !enabled ? { wakeWordStandby: false } : {}),
    };

    await this.repo.saveStoredSettings(PERMISSIONS_STORAGE_KEY, updated);
    this.cachedPermissions = updated;
    await this.repo.recordAuditLog({
      capability: key,
      action: enabled ? 'Enabled capability individually' : 'Disabled capability',
      target: key,
      outcome: 'allowed',
      source,
      detail: `Permission "${key}" set to ${enabled ? 'ON' : 'OFF'}.`,
    });

    return { ...updated };
  }

  public async revokeAllDesktopPermissions(
    source: AuditSource = 'web',
  ): Promise<PermissionsStateDTO> {
    const current = await this.getPermissions();
    const updated: PermissionsStateDTO = { ...current };
    for (const key of OS_CAPABILITY_KEYS) {
      updated[key] = false;
    }

    await this.repo.saveStoredSettings(PERMISSIONS_STORAGE_KEY, updated);
    this.cachedPermissions = updated;
    await this.repo.recordAuditLog({
      capability: 'desktop_revocation',
      action: 'Revoked all OS-level desktop permissions',
      target: 'all_os_capabilities',
      outcome: 'allowed',
      source,
      detail: 'All OS capability classes and wake-word standby were reset to OFF.',
    });

    return { ...updated };
  }
}
