import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
  scryptSync,
} from 'node:crypto';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { gunzipSync, gzipSync } from 'node:zlib';
import { sanitizeDiagnosticText } from '@mj/shared';
import { resolveSqlitePath, runMigrations } from './client.js';

export const BACKUP_ENVELOPE_FORMAT = 'mj-backup-v1' as const;

export interface EncryptedBackupEnvelope {
  format: typeof BACKUP_ENVELOPE_FORMAT;
  cipher: 'aes-256-gcm';
  kdf: 'scrypt';
  compression: 'gzip';
  createdAt: string;
  sha256Plaintext: string;
  saltB64: string;
  ivB64: string;
  authTagB64: string;
  ciphertextB64: string;
}

export interface BackupResult {
  filePath: string;
  fileName: string;
  createdAt: string;
  bytesEncrypted: number;
  sha256Plaintext: string;
  prunedFiles: string[];
}

export interface RestoredTableCounts {
  conversations: number;
  messages: number;
  appSettings: number;
  usageLogs: number;
  desktopAllowlist: number;
  privilegedAuditLogs: number;
}

export interface RestoreResult {
  restoredFrom: string;
  targetPath: string;
  preRestoreBackupPath: string | null;
  createdAt: string;
  sha256Plaintext: string;
  integrityCheck: string;
  counts: RestoredTableCounts;
}

function assertBackupPassphrase(passphrase: string): string {
  const trimmed = passphrase.trim();
  if (trimmed.length < 16) {
    throw new Error(
      'Backup encryption key/passphrase must be at least 16 characters long.',
    );
  }
  return trimmed;
}

function deriveBackupAesKey(passphrase: string, salt: Buffer): Buffer {
  return scryptSync(passphrase, salt, 32, { N: 16384, r: 8, p: 1 });
}

function sha256Hex(data: Buffer): string {
  return createHash('sha256').update(data).digest('hex');
}

function formatBackupTimestamp(date: Date): string {
  const iso = date.toISOString(); // e.g. 2026-11-27T20:35:10.123Z
  return iso.slice(0, 19).replace(/[:T]/g, '-');
}

function escapeSqlStringLiteral(value: string): string {
  return value.replace(/'/g, "''");
}

function inspectSqliteSnapshot(sqlitePath: string): {
  integrityCheck: string;
  counts: RestoredTableCounts;
} {
  const db = new DatabaseSync(sqlitePath);
  try {
    const integrityRow = db.prepare('PRAGMA integrity_check;').get() as
      | { integrity_check?: string }
      | undefined;
    const integrityCheck = integrityRow?.integrity_check ?? 'unknown';
    if (integrityCheck !== 'ok') {
      throw new Error(`SQLite integrity check failed: ${integrityCheck}`);
    }

    runMigrations(db);

    const countTable = (table: string): number => {
      const row = db.prepare(`SELECT COUNT(*) AS count FROM ${table};`).get() as
        | { count?: number }
        | undefined;
      return Number(row?.count ?? 0);
    };

    return {
      integrityCheck,
      counts: {
        conversations: countTable('conversations'),
        messages: countTable('messages'),
        appSettings: countTable('app_settings'),
        usageLogs: countTable('usage_logs'),
        desktopAllowlist: countTable('desktop_allowlist'),
        privilegedAuditLogs: countTable('privileged_audit_logs'),
      },
    };
  } finally {
    db.close();
  }
}

/**
 * Creates a transactionally consistent, compressed, AES-256-GCM encrypted backup
 * from a live SQLite handle (including WAL mode) without storing unencrypted artifacts.
 */
export function createEncryptedDatabaseBackup(options: {
  sqlite: DatabaseSync;
  backupDir: string;
  encryptionKey: string;
  retentionCount?: number;
  now?: Date;
}): BackupResult {
  const passphrase = assertBackupPassphrase(options.encryptionKey);
  const now = options.now ?? new Date();
  const createdAt = now.toISOString();
  const backupDir = resolve(options.backupDir);
  mkdirSync(backupDir, { recursive: true });

  const suffix = randomBytes(4).toString('hex');
  const tempSnapshotPath = resolve(backupDir, `.tmp-snapshot-${Date.now()}-${suffix}.db`);
  const fileName = `mj-backup-${formatBackupTimestamp(now)}-${suffix}.mjbak`;
  const tempArchivePath = resolve(backupDir, `.${fileName}.tmp`);
  const finalArchivePath = resolve(backupDir, fileName);

  try {
    // SQLite VACUUM INTO yields a self-contained, consistent snapshot of WAL DB state.
    options.sqlite.exec(`VACUUM INTO '${escapeSqlStringLiteral(tempSnapshotPath)}';`);

    const rawSnapshot = readFileSync(tempSnapshotPath);
    const sha256Plaintext = sha256Hex(rawSnapshot);
    const compressed = gzipSync(rawSnapshot, { level: 9 });

    const salt = randomBytes(16);
    const iv = randomBytes(12);
    const key = deriveBackupAesKey(passphrase, salt);
    const cipher = createCipheriv('aes-256-gcm', key, iv);
    const aad = Buffer.from(
      `${BACKUP_ENVELOPE_FORMAT}|${createdAt}|${sha256Plaintext}`,
      'utf8',
    );
    cipher.setAAD(aad);

    const encrypted = Buffer.concat([cipher.update(compressed), cipher.final()]);
    const authTag = cipher.getAuthTag();

    const envelope: EncryptedBackupEnvelope = {
      format: BACKUP_ENVELOPE_FORMAT,
      cipher: 'aes-256-gcm',
      kdf: 'scrypt',
      compression: 'gzip',
      createdAt,
      sha256Plaintext,
      saltB64: salt.toString('base64'),
      ivB64: iv.toString('base64'),
      authTagB64: authTag.toString('base64'),
      ciphertextB64: encrypted.toString('base64'),
    };

    const serialized = `${JSON.stringify(envelope, null, 2)}\n`;
    writeFileSync(tempArchivePath, serialized, { encoding: 'utf8', mode: 0o600 });
    renameSync(tempArchivePath, finalArchivePath);

    const bytesEncrypted = statSync(finalArchivePath).size;
    const retention = options.retentionCount ?? 14;
    const prunedFiles = pruneOldBackups(backupDir, retention);

    return {
      filePath: finalArchivePath,
      fileName,
      createdAt,
      bytesEncrypted,
      sha256Plaintext,
      prunedFiles,
    };
  } catch (err) {
    const safeMsg = err instanceof Error ? sanitizeDiagnosticText(err.message) : 'Backup failed';
    throw new Error(`Encrypted backup failed: ${safeMsg}`);
  } finally {
    rmSync(tempSnapshotPath, { force: true });
    rmSync(tempArchivePath, { force: true });
  }
}

export function listEncryptedBackups(
  backupDir: string,
): Array<{ fileName: string; filePath: string; sizeBytes: number; mtimeMs: number }> {
  const dir = resolve(backupDir);
  if (!existsSync(dir)) return [];

  return readdirSync(dir)
    .filter((name) => name.startsWith('mj-backup-') && name.endsWith('.mjbak'))
    .map((fileName) => {
      const filePath = resolve(dir, fileName);
      const st = statSync(filePath);
      return {
        fileName,
        filePath,
        sizeBytes: st.size,
        mtimeMs: st.mtimeMs,
      };
    })
    .sort((a, b) => b.mtimeMs - a.mtimeMs || b.fileName.localeCompare(a.fileName));
}

export function pruneOldBackups(backupDir: string, retentionCount: number): string[] {
  if (retentionCount <= 0) return [];
  const entries = listEncryptedBackups(backupDir);
  if (entries.length <= retentionCount) return [];

  const removed: string[] = [];
  for (const stale of entries.slice(retentionCount)) {
    rmSync(stale.filePath, { force: true });
    removed.push(stale.fileName);
  }
  return removed;
}

/**
 * Decrypts, authenticates (AES-256-GCM tag + SHA-256), verifies SQLite PRAGMA integrity_check,
 * and atomically restores an encrypted `.mjbak` archive to the target SQLite path.
 */
export function restoreEncryptedDatabaseBackup(options: {
  backupFilePath: string;
  targetDatabaseUrl: string;
  encryptionKey: string;
  createPreRestoreSafetyCopy?: boolean;
}): RestoreResult {
  const passphrase = assertBackupPassphrase(options.encryptionKey);
  const backupFilePath = resolve(options.backupFilePath);
  if (!existsSync(backupFilePath)) {
    throw new Error(`Backup archive not found: ${basename(backupFilePath)}`);
  }

  const targetPath = resolveSqlitePath(options.targetDatabaseUrl);
  if (targetPath === ':memory:') {
    throw new Error('Cannot restore an encrypted backup onto an :memory: database target.');
  }

  const rawEnvelopeText = readFileSync(backupFilePath, 'utf8');
  let envelope: EncryptedBackupEnvelope;
  try {
    envelope = JSON.parse(rawEnvelopeText) as EncryptedBackupEnvelope;
  } catch {
    throw new Error('Backup file is not a valid MJ encrypted backup JSON envelope.');
  }

  if (
    envelope.format !== BACKUP_ENVELOPE_FORMAT ||
    envelope.cipher !== 'aes-256-gcm' ||
    envelope.kdf !== 'scrypt' ||
    envelope.compression !== 'gzip'
  ) {
    throw new Error('Unsupported or corrupted backup envelope metadata.');
  }

  const salt = Buffer.from(envelope.saltB64, 'base64');
  const iv = Buffer.from(envelope.ivB64, 'base64');
  const authTag = Buffer.from(envelope.authTagB64, 'base64');
  const ciphertext = Buffer.from(envelope.ciphertextB64, 'base64');

  const key = deriveBackupAesKey(passphrase, salt);
  const decipher = createDecipheriv('aes-256-gcm', key, iv);
  const aad = Buffer.from(
    `${envelope.format}|${envelope.createdAt}|${envelope.sha256Plaintext}`,
    'utf8',
  );
  decipher.setAAD(aad);
  decipher.setAuthTag(authTag);

  let compressed: Buffer;
  try {
    compressed = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  } catch {
    throw new Error(
      'Backup decryption or authentication failed (wrong BACKUP_ENCRYPTION_KEY or tampered file).',
    );
  }

  const plaintextDb = gunzipSync(compressed);
  const actualSha = sha256Hex(plaintextDb);
  if (actualSha !== envelope.sha256Plaintext) {
    throw new Error('Restored SQLite checksum mismatch.');
  }

  const targetDir = dirname(targetPath);
  mkdirSync(targetDir, { recursive: true });
  const tempRestoredPath = resolve(
    targetDir,
    `.tmp-restore-${Date.now()}-${randomBytes(4).toString('hex')}.db`,
  );

  let preRestoreBackupPath: string | null = null;

  try {
    writeFileSync(tempRestoredPath, plaintextDb, { mode: 0o600 });
    const verified = inspectSqliteSnapshot(tempRestoredPath);

    if (options.createPreRestoreSafetyCopy !== false && existsSync(targetPath)) {
      let checkpointDb: DatabaseSync | null = null;
      try {
        checkpointDb = new DatabaseSync(targetPath);
        checkpointDb.exec('PRAGMA busy_timeout = 2000;');
        checkpointDb.exec('PRAGMA wal_checkpoint(TRUNCATE);');
      } catch {
        // Target database may be locked or partially corrupt; preserve sidecar WAL/SHM files below.
      } finally {
        try {
          checkpointDb?.close();
        } catch {
          // ignore close failures
        }
      }

      const safetyPath = `${targetPath}.pre-restore-${formatBackupTimestamp(new Date())}.db`;
      copyFileSync(targetPath, safetyPath);
      if (existsSync(`${targetPath}-wal`)) {
        copyFileSync(`${targetPath}-wal`, `${safetyPath}-wal`);
      }
      if (existsSync(`${targetPath}-shm`)) {
        copyFileSync(`${targetPath}-shm`, `${safetyPath}-shm`);
      }
      preRestoreBackupPath = safetyPath;
    }

    // Remove stale WAL/SHM sidecars before moving verified single-file snapshot into place
    rmSync(`${targetPath}-wal`, { force: true });
    rmSync(`${targetPath}-shm`, { force: true });
    renameSync(tempRestoredPath, targetPath);

    return {
      restoredFrom: backupFilePath,
      targetPath,
      preRestoreBackupPath,
      createdAt: envelope.createdAt,
      sha256Plaintext: actualSha,
      integrityCheck: verified.integrityCheck,
      counts: verified.counts,
    };
  } finally {
    rmSync(tempRestoredPath, { force: true });
  }
}
