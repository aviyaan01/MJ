import { resolve } from 'node:path';
import { createDatabase, loadRootEnvIntoProcess, resolveSqlitePath } from './client.js';
import { createEncryptedDatabaseBackup } from './backup.js';

function resolveKeyFromEnv(): string {
  const explicit = (process.env.BACKUP_ENCRYPTION_KEY ?? '').trim();
  const auth = (process.env.AUTH_SECRET ?? '').trim();
  if (!explicit || explicit.startsWith('your_') || explicit.startsWith('replace_with')) {
    throw new Error(
      'Set a dedicated BACKUP_ENCRYPTION_KEY (>= 16 chars, distinct from AUTH_SECRET) in .env/environment before running db:backup. AUTH_SECRET fallback is disabled.',
    );
  }
  if (explicit.length < 16) {
    throw new Error('BACKUP_ENCRYPTION_KEY must be at least 16 characters.');
  }
  if (auth && explicit === auth) {
    throw new Error(
      'BACKUP_ENCRYPTION_KEY must not reuse AUTH_SECRET. Configure a separate backup passphrase.',
    );
  }
  return explicit;
}

const rootDir = loadRootEnvIntoProcess();
const dbUrl = resolveSqlitePath(process.env.DATABASE_URL || './data/mj-assistant.db', rootDir);
const backupDir = process.env.BACKUP_DIR
  ? resolve(rootDir, process.env.BACKUP_DIR)
  : resolve(rootDir, 'data', 'backups');
const retentionCount = Math.max(1, Number(process.env.BACKUP_RETENTION_COUNT ?? 14) || 14);
const encryptionKey = resolveKeyFromEnv();

const handle = createDatabase(dbUrl);
try {
  const result = createEncryptedDatabaseBackup({
    sqlite: handle.sqlite,
    backupDir,
    encryptionKey,
    retentionCount,
  });
  console.log(
    `[MJ Backup] Created encrypted backup: ${result.fileName} (${result.bytesEncrypted} bytes, sha256=${result.sha256Plaintext.slice(0, 12)}..., pruned=${result.prunedFiles.length})`,
  );
} finally {
  handle.close();
}
