import { basename } from 'node:path';
import { sanitizeDiagnosticText } from '@mj/shared';
import { buildServer } from './app.js';

async function main() {
  const { app, config, dbHandle, alertMonitor, backupScheduler } = await buildServer();

  if (config.authSecretEphemeral) {
    console.warn(
      '[MJ Server] AUTH_SECRET is unset or placeholder — generated a temporary per-process secret for local development.',
    );
  }
  if (!config.apiKeyConfigured) {
    console.warn(
      '[MJ Server] XAI_API_KEY is not configured (or is still a placeholder). Chat responses will return a structured INVALID_API_KEY notice until configured in .env.',
    );
  }

  let shuttingDown = false;
  const shutdown = async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    backupScheduler.stop();
    await app.close();
    dbHandle.close();
    process.exit(0);
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  process.on('uncaughtException', async (err) => {
    const safeMsg = sanitizeDiagnosticText(err instanceof Error ? err.message : String(err));
    console.error('[MJ Server] Uncaught exception:', safeMsg);
    backupScheduler.stop();
    await alertMonitor.notifyCrash('uncaughtException', err).catch(() => undefined);
    await app.close().catch(() => undefined);
    dbHandle.close();
    process.exit(1);
  });

  process.on('unhandledRejection', (reason) => {
    const safeMsg = sanitizeDiagnosticText(
      reason instanceof Error ? reason.message : String(reason),
    );
    console.error('[MJ Server] Unhandled promise rejection:', safeMsg);
    void alertMonitor.notifyCrash('unhandledRejection', reason);
  });

  await app.listen({
    host: config.host,
    port: config.port,
  });

  backupScheduler.start();
  if (config.backupKeyWarning) {
    console.warn(`[MJ Backup] ${config.backupKeyWarning}`);
  } else if (config.backup.enabled && !backupScheduler.isConfigured()) {
    console.warn(
      '[MJ Backup] Automatic daily backup is inactive (configure dedicated BACKUP_ENCRYPTION_KEY >= 16 chars with file-backed DATABASE_URL).',
    );
  }

  console.log(
    `[MJ Server] MJ Assistant API listening at http://${config.host}:${config.port} (env=${config.appEnv}, model=${config.xaiTextModel}, db=${basename(dbHandle.filePath)})`,
  );
}

main().catch((err) => {
  const safeMsg = sanitizeDiagnosticText(err instanceof Error ? err.message : String(err));
  console.error('[MJ Server] Fatal startup error:', safeMsg);
  process.exit(1);
});
