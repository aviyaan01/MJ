import { copyFileSync, existsSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  MjDatabaseRepository,
  createDatabase,
  createEncryptedDatabaseBackup,
  listEncryptedBackups,
  restoreEncryptedDatabaseBackup,
} from '@mj/database';
import { DailyBackupScheduler } from '../apps/server/src/backupScheduler.js';
import { loadServerConfig } from '../apps/server/src/config.js';
import { PermissionsStore } from '../apps/server/src/permissionsStore.js';
import { RuntimeSettingsStore } from '../apps/server/src/settingsStore.js';

describe('Encrypted Daily Database Backup & Verified Restore', () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    while (tempDirs.length > 0) {
      const dir = tempDirs.pop()!;
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('creates an AES-256-GCM encrypted backup, blocks wrong/tampered keys, and restores full memory + settings', async () => {
    const workDir = mkdtempSync(join(tmpdir(), 'mj-bak-test-'));
    tempDirs.push(workDir);
    const dbPath = join(workDir, 'mj-live.db');
    const backupDir = join(workDir, 'backups');
    const encryptionKey = 'strong-test-backup-passphrase-2026';

    // 1. Populate memory (conversations + messages), settings, permissions, and audit log in WAL SQLite
    const handle = createDatabase(dbPath);
    const repo = new MjDatabaseRepository(handle);
    const config = loadServerConfig({
      APP_ENV: 'test',
      DATABASE_URL: dbPath,
      AUTH_SECRET: 'test-auth-secret-minimum-32-characters-long',
    });
    const settingsStore = new RuntimeSettingsStore(repo, config);
    const permissionsStore = new PermissionsStore(repo);

    const conv = await repo.createConversation({
      title: 'Memory Backup Verification Thread',
      model: 'gemini-2.5-flash',
    });
    await repo.addMessage({
      conversationId: conv.id,
      role: 'user',
      content: 'আমার জরুরি বাংলা নোট মনে রাখো: Project deadline Friday 5pm.',
      status: 'completed',
    });
    await repo.addMessage({
      conversationId: conv.id,
      role: 'assistant',
      content: 'Noted cleanly in persistent conversation memory.',
      status: 'completed',
    });
    await settingsStore.updateSettings({
      activeModel: 'gemini-2.5-flash-lite',
      budget: { dailyCapUsd: 4.5, softCapUsd: 15 },
    });
    await permissionsStore.setSinglePermission('fileRead', true, 'web');

    // 2. Execute encrypted backup against live handle
    const backup = createEncryptedDatabaseBackup({
      sqlite: handle.sqlite,
      backupDir,
      encryptionKey,
      retentionCount: 7,
    });
    handle.close();

    expect(existsSync(backup.filePath)).toBe(true);
    expect(backup.fileName).toMatch(/^mj-backup-.*\.mjbak$/);

    // Confirm raw encrypted archive leaks zero plaintext memory/settings content
    const rawArchive = readFileSync(backup.filePath, 'utf8');
    expect(rawArchive).toContain('"cipher": "aes-256-gcm"');
    expect(rawArchive).not.toContain('Memory Backup Verification Thread');
    expect(rawArchive).not.toContain('Project deadline Friday 5pm');
    expect(rawArchive).not.toContain('gemini-2.5-flash-lite');

    // 3. Reject wrong key & tampered ciphertext
    expect(() =>
      restoreEncryptedDatabaseBackup({
        backupFilePath: backup.filePath,
        targetDatabaseUrl: join(workDir, 'wrong-key.db'),
        encryptionKey: 'completely-wrong-encryption-passphrase',
      }),
    ).toThrow(/decryption or authentication failed/i);

    const tamperedPath = join(workDir, 'tampered.mjbak');
    const parsed = JSON.parse(rawArchive) as Record<string, string>;
    parsed.ciphertextB64 = `AA${parsed.ciphertextB64!.slice(2)}`;
    writeFileSync(tamperedPath, JSON.stringify(parsed));
    expect(() =>
      restoreEncryptedDatabaseBackup({
        backupFilePath: tamperedPath,
        targetDatabaseUrl: join(workDir, 'tampered-out.db'),
        encryptionKey,
      }),
    ).toThrow(/decryption or authentication failed/i);

    // 4. Simulate data loss / overwrite live DB, then restore from encrypted .mjbak
    const damagedHandle = createDatabase(dbPath);
    const damagedRepo = new MjDatabaseRepository(damagedHandle);
    await damagedRepo.clearAllConversations();
    damagedHandle.close();

    const restored = restoreEncryptedDatabaseBackup({
      backupFilePath: backup.filePath,
      targetDatabaseUrl: dbPath,
      encryptionKey,
      createPreRestoreSafetyCopy: true,
    });

    expect(restored.integrityCheck).toBe('ok');
    expect(restored.counts.conversations).toBe(1);
    expect(restored.counts.messages).toBe(2);
    expect(restored.counts.appSettings).toBeGreaterThanOrEqual(2);
    expect(restored.counts.privilegedAuditLogs).toBeGreaterThanOrEqual(1);
    expect(restored.preRestoreBackupPath).not.toBeNull();
    expect(existsSync(restored.preRestoreBackupPath!)).toBe(true);

    // 5. Re-open restored DB and assert exact memory + settings fidelity
    const verifyHandle = createDatabase(dbPath);
    const verifyRepo = new MjDatabaseRepository(verifyHandle);
    const verifySettings = new RuntimeSettingsStore(verifyRepo, config);
    const verifyPermissions = new PermissionsStore(verifyRepo);

    const detail = await verifyRepo.getConversationDetail(conv.id);
    expect(detail?.conversation.title).toBe('Memory Backup Verification Thread');
    expect(detail?.messages[0]?.content).toContain('আমার জরুরি বাংলা নোট মনে রাখো');

    const loadedSettings = await verifySettings.getPublicSettings();
    expect(loadedSettings.activeModel).toBe('gemini-2.5-flash-lite');
    expect(loadedSettings.budget.dailyCapUsd).toBe(4.5);

    const loadedPerms = await verifyPermissions.getPermissions();
    expect(loadedPerms.fileRead).toBe(true);
    verifyHandle.close();
  });

  it('runs DailyBackupScheduler automatically once every 24h interval and enforces retention count', async () => {
    const workDir = mkdtempSync(join(tmpdir(), 'mj-sched-test-'));
    tempDirs.push(workDir);
    const dbPath = join(workDir, 'mj-sched.db');
    const backupDir = join(workDir, 'backups');
    const handle = createDatabase(dbPath);

    let fakeNow = 1_750_000_000_000;
    const logs: string[] = [];

    const scheduler = new DailyBackupScheduler(
      handle,
      {
        enabled: true,
        dir: backupDir,
        encryptionKey: 'daily-scheduler-secret-key-2026',
        intervalHours: 24,
        retentionCount: 2,
      },
      undefined,
      () => fakeNow,
      (m) => logs.push(m),
    );

    // Day 0 -> creates first backup
    const first = await scheduler.runIfDue();
    expect(first).not.toBeNull();
    utimesSync(first!.filePath, new Date(fakeNow), new Date(fakeNow));

    // +4 hours later -> skipped (not yet 24h)
    fakeNow += 4 * 3_600_000;
    expect(await scheduler.runIfDue()).toBeNull();

    // +24 hours from Day 0 -> creates second backup
    fakeNow += 20 * 3_600_000;
    const second = await scheduler.runIfDue();
    expect(second).not.toBeNull();
    utimesSync(second!.filePath, new Date(fakeNow), new Date(fakeNow));

    // +24 hours later -> creates 3rd backup and prunes oldest down to retentionCount=2
    fakeNow += 24 * 3_600_000;
    const third = await scheduler.runIfDue();
    expect(third).not.toBeNull();
    expect(listEncryptedBackups(backupDir)).toHaveLength(2);
    expect(logs.some((l) => l.includes('Daily encrypted DB backup completed'))).toBe(true);

    scheduler.stop();
    handle.close();
  });

  it('checkpoints uncheckpointed WAL transactions before pre-restore copy and refuses BACKUP_ENCRYPTION_KEY -> AUTH_SECRET fallback', async () => {
    const workDir = mkdtempSync(join(tmpdir(), 'mj-wal-restore-test-'));
    tempDirs.push(workDir);
    const sourceDbPath = join(workDir, 'source.db');
    const targetDbPath = join(workDir, 'live-wal-target.db');
    const backupDir = join(workDir, 'backups');
    const encryptionKey = 'dedicated-backup-key-separate-2026';

    // 1. Refuse fallback from BACKUP_ENCRYPTION_KEY -> AUTH_SECRET & warn cleanly
    const authOnlyConfig = loadServerConfig({
      APP_ENV: 'production',
      AUTH_SECRET: 'production-session-signing-secret-minimum-32-chars',
      APP_ACCESS_PASSCODE: 'prod-pass-1234',
      DATABASE_URL: sourceDbPath,
      CORS_ORIGIN: 'https://app.example.com',
    });
    expect(authOnlyConfig.backup.encryptionKey).toBeUndefined();
    expect(authOnlyConfig.backupKeyWarning).toMatch(/AUTH_SECRET fallback/i);

    const reusedKeyConfig = loadServerConfig({
      APP_ENV: 'production',
      AUTH_SECRET: 'same-secret-key-at-least-32-chars-long-value',
      BACKUP_ENCRYPTION_KEY: 'same-secret-key-at-least-32-chars-long-value',
      APP_ACCESS_PASSCODE: 'prod-pass-1234',
      DATABASE_URL: sourceDbPath,
      CORS_ORIGIN: 'https://app.example.com',
    });
    expect(reusedKeyConfig.backup.encryptionKey).toBeUndefined();
    expect(reusedKeyConfig.backupKeyWarning).toMatch(/must not match AUTH_SECRET/i);

    // 2. Create clean backup BEFORE uncheckpointed WAL row is written
    const h1 = createDatabase(sourceDbPath);
    const repo1 = new MjDatabaseRepository(h1);
    const baselineConv = await repo1.createConversation({
      title: 'Baseline Backup Conversation',
      model: 'gemini-2.5-flash',
    });
    const backup = createEncryptedDatabaseBackup({
      sqlite: h1.sqlite,
      backupDir,
      encryptionKey,
    });

    // Write a new conversation with wal_autocheckpoint = 0 so the row sits ONLY in -wal
    h1.sqlite.exec('PRAGMA wal_autocheckpoint = 0;');
    const walConv = await repo1.createConversation({
      title: 'Uncheckpointed WAL Recovery Check',
      model: 'gemini-2.5-flash',
    });

    // Snapshot .db + -wal + -shm onto targetDbPath before closing h1 (simulates uncheckpointed DB state without open lock)
    copyFileSync(sourceDbPath, targetDbPath);
    if (existsSync(`${sourceDbPath}-wal`)) {
      copyFileSync(`${sourceDbPath}-wal`, `${targetDbPath}-wal`);
    }
    if (existsSync(`${sourceDbPath}-shm`)) {
      copyFileSync(`${sourceDbPath}-shm`, `${targetDbPath}-shm`);
    }
    h1.close();

    // 3. Restore baseline backup onto targetDbPath -> pre-restore safety copy MUST contain the WAL row!
    const restored = restoreEncryptedDatabaseBackup({
      backupFilePath: backup.filePath,
      targetDatabaseUrl: targetDbPath,
      encryptionKey,
      createPreRestoreSafetyCopy: true,
    });
    expect(restored.preRestoreBackupPath).toBeTruthy();

    const safetyHandle = createDatabase(restored.preRestoreBackupPath!);
    const safetyRepo = new MjDatabaseRepository(safetyHandle);
    const recoveredWalConv = await safetyRepo.getConversationDetail(walConv.id);
    expect(recoveredWalConv?.conversation.title).toBe('Uncheckpointed WAL Recovery Check');
    safetyHandle.close();

    const restoredHandle = createDatabase(targetDbPath);
    const restoredRepo = new MjDatabaseRepository(restoredHandle);
    expect((await restoredRepo.getConversationDetail(baselineConv.id))?.conversation.title).toBe(
      'Baseline Backup Conversation',
    );
    expect(await restoredRepo.getConversationDetail(walConv.id)).toBeNull();
    restoredHandle.close();
  });
});
