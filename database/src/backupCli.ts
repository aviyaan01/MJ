import { resolve } from 'node:path';
import { createDatabase, loadRootEnvIntoProcess, resolveSqlitePath } from './client.js';
import { createEncryptedDatabaseBackup } from './backup.js';

function resolveKeyFromEnv(): string {
  const explicit = (process.env.BACKUP_ENCRYPTION_KEY ?? '').trim();
  if (explicit && !explicit.startsWith('your_') && !explicit.startsWith('replace_with')) {
    return explicit;
  }
  const auth = (process.env.AUTH_SECRET ?? '').trim();
  if (auth && !auth.startsWith('your_') && !auth.startsWith('replace_with')) {
    return auth;
  }
  throw new Error(
    'Set BACKUP_ENCRYPTION_KEY (recommended, >= 16 chars) or AUTH_SECRET in .env/environment before running db:backup.',
  );
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
