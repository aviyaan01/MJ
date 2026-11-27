import { existsSync, readFileSync } from 'node:fs';
import { basename, resolve } from 'node:path';
import { restoreEncryptedDatabaseBackup } from './backup.js';

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

function getArgValue(flag: string): string | undefined {
  const idx = process.argv.indexOf(flag);
  if (idx === -1) return undefined;
  return process.argv[idx + 1];
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
    'Set BACKUP_ENCRYPTION_KEY (or AUTH_SECRET used during backup) in .env/environment before running db:restore.',
  );
}

const rootDir = loadRootEnvIfPresent();
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
  : process.env.DATABASE_URL || resolve(rootDir, 'data', 'mj-assistant.db');
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
