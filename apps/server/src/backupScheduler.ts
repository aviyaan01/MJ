import { sanitizeDiagnosticText } from '@mj/shared';
import {
  createEncryptedDatabaseBackup,
  listEncryptedBackups,
  type BackupResult,
  type MjDatabaseHandle,
} from '@mj/database';
import type { AlertMonitor } from './alerting.js';

export interface BackupSchedulerConfig {
  enabled: boolean;
  dir: string;
  encryptionKey?: string;
  intervalHours: number;
  retentionCount: number;
}

export class DailyBackupScheduler {
  private timer: NodeJS.Timeout | null = null;
  private running = false;

  constructor(
    private readonly dbHandle: MjDatabaseHandle,
    private readonly config: BackupSchedulerConfig,
    private readonly alertMonitor?: AlertMonitor,
    private readonly nowMs: () => number = () => Date.now(),
    private readonly onLog: (msg: string) => void = (msg) => console.log(msg),
  ) {}

  public isConfigured(): boolean {
    return Boolean(
      this.config.enabled &&
        this.dbHandle.filePath !== ':memory:' &&
        this.config.encryptionKey &&
        this.config.encryptionKey.trim().length >= 16,
    );
  }

  /**
   * Checks whether the newest encrypted backup is missing or older than `intervalHours`,
   * and executes a consistent encrypted backup if due.
   */
  public async runIfDue(force = false): Promise<BackupResult | null> {
    if (!this.isConfigured() || this.running) {
      return null;
    }

    this.running = true;
    try {
      const existing = listEncryptedBackups(this.config.dir);
      const intervalMs = this.config.intervalHours * 3_600_000;
      const latest = existing[0];
      const now = this.nowMs();

      if (!force && latest && now - latest.mtimeMs < intervalMs) {
        return null;
      }

      const result = createEncryptedDatabaseBackup({
        sqlite: this.dbHandle.sqlite,
        backupDir: this.config.dir,
        encryptionKey: this.config.encryptionKey!,
        retentionCount: this.config.retentionCount,
        now: new Date(now),
      });

      this.onLog(
        `[MJ Backup] Daily encrypted DB backup completed: ${result.fileName} (${result.bytesEncrypted} bytes, pruned=${result.prunedFiles.length})`,
      );
      return result;
    } catch (err) {
      const safeMsg = sanitizeDiagnosticText(
        err instanceof Error ? err.message : 'Daily backup error',
      );
      this.onLog(`[MJ Backup] Automatic daily backup failed: ${safeMsg}`);
      await this.alertMonitor?.notifyCrash('daily_database_backup', err);
      return null;
    } finally {
      this.running = false;
    }
  }

  public start(): void {
    if (!this.isConfigured() || this.timer) {
      return;
    }
    void this.runIfDue(false);
    // Poll every hour so daily cadence remains accurate without 32-bit timer overflow
    this.timer = setInterval(() => {
      void this.runIfDue(false);
    }, 3_600_000);
    this.timer.unref();
  }

  public stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }
}
