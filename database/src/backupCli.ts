import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createDatabase } from './client.js';
import { createEncryptedDatabaseBackup } from './backup.js';

function loadRootEnvIfPresent(): string {
  let dir = process.cwd();
  for (let i = 0; i < 6; i++) {
    const envPath = resolve(dir, '.env');
    if (existsSync(envPath)) {
      const lines = readFileSync(envPath, 'utf8').split(/\r?\n/);
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith('#')) continue;
        const eqIdx = trimmed.indexOf('=');
        if (eqIdx <= 0) continue;
        const key = trimmed.slice(0, eqIdx).trim();
        let val = trimmed.slice(eqIdx + 1).trim();
        if (
          (val.startsWith('"') && val.endsWith('"')) ||
          (val.startsWith("'") && val.endsWith("'"))
        ) {
          val = val.slice(1, -1);
        }
        if (process.env[key] === undefined) {
          process.env[key] = val;
        }
      }
      return dir;
    }
    if (existsSync(resolve(dir, 'tsconfig.base.json'))) {
      return dir;
    }
    const parent = resolve(dir, '..');
    if (parent === dir) break;
    dir = parent;
  }
  return process.cwd();
}

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

const rootDir = loadRootEnvIfPresent();
const dbUrl = process.env.DATABASE_URL || resolve(rootDir, 'data', 'mj-assistant.db');
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
