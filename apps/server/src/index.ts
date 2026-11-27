import { buildServer } from './app.js';

async function main() {
  const { app, config, dbHandle } = await buildServer();

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

  const shutdown = async () => {
    await app.close();
    dbHandle.close();
    process.exit(0);
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  await app.listen({
    host: config.host,
    port: config.port,
  });

  console.log(
    `[MJ Server] MJ Assistant API listening at http://${config.host}:${config.port} (env=${config.appEnv}, model=${config.xaiTextModel}, db=${dbHandle.filePath})`,
  );
}

main().catch((err) => {
  console.error('[MJ Server] Fatal startup error:', err instanceof Error ? err.message : err);
  process.exit(1);
});
