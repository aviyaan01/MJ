import { randomUUID } from 'node:crypto';
import type {
  AuditSource,
  ConfigurableShortcutDTO,
  ShortcutActionKind,
} from '@mj/shared';
import type { MjDatabaseRepository } from '@mj/database';

const SHORTCUTS_STORAGE_KEY = 'mj.shortcuts.v1';

export class ShortcutsStore {
  private cachedShortcuts: ConfigurableShortcutDTO[] | null = null;

  constructor(private readonly repo: MjDatabaseRepository) {}

  public async listShortcuts(): Promise<ConfigurableShortcutDTO[]> {
    if (this.cachedShortcuts) {
      return [...this.cachedShortcuts];
    }
    const saved =
      (await this.repo.getStoredSettings<ConfigurableShortcutDTO[]>(SHORTCUTS_STORAGE_KEY)) ?? [];
    const normalized = Array.isArray(saved) ? saved : [];
    this.cachedShortcuts = normalized;
    return [...normalized];
  }

  public async addShortcut(
    input: {
      label: string;
      accelerator: string;
      action: ShortcutActionKind;
      target?: string;
    },
    source: AuditSource = 'web',
  ): Promise<ConfigurableShortcutDTO> {
    const existing = await this.listShortcuts();
    const entry: ConfigurableShortcutDTO = {
      id: randomUUID(),
      label: input.label,
      accelerator: input.accelerator,
      action: input.action,
      ...(input.target ? { target: input.target } : {}),
      createdAt: new Date().toISOString(),
    };
    const next = [entry, ...existing];
    await this.repo.saveStoredSettings(SHORTCUTS_STORAGE_KEY, next);
    this.cachedShortcuts = next;

    await this.repo.recordAuditLog({
      capability: 'configurableShortcuts',
      action: 'Configured desktop shortcut',
      target: `${entry.accelerator} -> ${entry.action}${entry.target ? ` (${entry.target})` : ''}`,
      outcome: 'allowed',
      source,
      detail: `Label: ${entry.label}`,
    });

    return entry;
  }

  public async removeShortcut(
    id: string,
    source: AuditSource = 'web',
  ): Promise<ConfigurableShortcutDTO | null> {
    const existing = await this.listShortcuts();
    const found = existing.find((s) => s.id === id);
    if (!found) return null;

    const next = existing.filter((s) => s.id !== id);
    await this.repo.saveStoredSettings(SHORTCUTS_STORAGE_KEY, next);
    this.cachedShortcuts = next;

    await this.repo.recordAuditLog({
      capability: 'configurableShortcuts',
      action: 'Removed configured shortcut',
      target: `${found.accelerator} -> ${found.action}`,
      outcome: 'allowed',
      source,
      detail: `Label: ${found.label}`,
    });

    return found;
  }
}
