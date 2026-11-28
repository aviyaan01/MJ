import { basename, resolve } from 'node:path';
import { loadRootEnvIntoProcess, resolveSqlitePath } from './client.js';
import { restoreEncryptedDatabaseBackup } from './backup.js';

function getArgValue(flag: string): string | undefined {
  const idx = process.argv.indexOf(flag);
  if (idx === -1) return undefined;
  return process.argv[idx + 1];
}

function resolveKeyFromEnv(): string {
  const explicit = (process.env.BACKUP_ENCRYPTION_KEY ?? '').trim();
  const auth = (process.env.AUTH_SECRET ?? '').trim();
  if (!explicit || explicit.startsWith('your_') || explicit.startsWith('replace_with')) {
    throw new Error(
      'Set a dedicated BACKUP_ENCRYPTION_KEY (>= 16 chars) in .env/environment before running db:restore. AUTH_SECRET fallback is disabled.',
    );
  }
  if (explicit.length < 16) {
    throw new Error('BACKUP_ENCRYPTION_KEY must be at least 16 characters.');
  }
  if (auth && explicit === auth) {
    console.warn(
      '[MJ Restore] Warning: BACKUP_ENCRYPTION_KEY matches AUTH_SECRET. Rotate to a dedicated BACKUP_ENCRYPTION_KEY after restoring.',
    );
  }
  return explicit;
}

const rootDir = loadRootEnvIntoProcess();
const positionalArgs = process.argv.slice(2).filter((arg, i, arr) => {
  if (arg.startsWith('--')) return false;
  const prev = i > 0 ? arr[i - 1] : undefined;
  return prev !== '--file' && prev !== '--target';
});

const fileArg = getArgValue('--file') ?? positionalArgs[0];
if (!fileArg) {
  console.error(
    'Usage: npm run db:restore -- --file <path/to/mj-backup-....mjbak> [--target <db-path>] [--no-safety-copy]',
  );
  process.exit(1);
}

const targetArg = getArgValue('--target') ?? positionalArgs[1];
const targetDbUrl = targetArg
  ? resolve(process.cwd(), targetArg)
  : resolveSqlitePath(process.env.DATABASE_URL || './data/mj-assistant.db', rootDir);
const createSafetyCopy = !process.argv.includes('--no-safety-copy');
const encryptionKey = resolveKeyFromEnv();

const result = restoreEncryptedDatabaseBackup({
  backupFilePath: resolve(process.cwd(), fileArg),
  targetDatabaseUrl: targetDbUrl,
  encryptionKey,
  createPreRestoreSafetyCopy: createSafetyCopy,
});

console.log(
  `[MJ Restore] Successfully restored ${basename(result.restoredFrom)} -> ${basename(result.targetPath)}`,
);
console.log(
  `[MJ Restore] Integrity=${result.integrityCheck}, sha256=${result.sha256Plaintext.slice(0, 12)}..., snapshotAt=${result.createdAt}`,
);
console.log(
  `[MJ Restore] Rows: conversations=${result.counts.conversations}, messages=${result.counts.messages}, app_settings=${result.counts.appSettings}, usage_logs=${result.counts.usageLogs}, allowlist=${result.counts.desktopAllowlist}, audit_logs=${result.counts.privilegedAuditLogs}`,
);
if (result.preRestoreBackupPath) {
  console.log(`[MJ Restore] Previous DB preserved at: ${basename(result.preRestoreBackupPath)}`);
}
