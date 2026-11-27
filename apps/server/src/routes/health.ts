import type { FastifyInstance } from 'fastify';
import type { SystemHealthDTO } from '@mj/shared';
import type { ProviderRouterClient } from '@mj/ai';
import type { MjDatabaseHandle } from '@mj/database';
import type { AlertMonitor } from '../alerting.js';
import type { ServerConfig } from '../config.js';
import type { RuntimeSettingsStore } from '../settingsStore.js';

export interface HealthRouteDeps {
  config: ServerConfig;
  dbHandle: MjDatabaseHandle;
  settingsStore: RuntimeSettingsStore;
  startedAtMs: number;
  alertMonitor?: AlertMonitor;
  providerRouter?: ProviderRouterClient;
}

export function registerHealthRoutes(app: FastifyInstance, deps: HealthRouteDeps): void {
  const buildHealthPayload = async (): Promise<{ dbOk: boolean; payload: SystemHealthDTO }> => {
    const dbOk = deps.dbHandle.ping();
    if (!dbOk) {
      void deps.alertMonitor?.notifyUptimeDegraded('SQLite database ping failed on health check');
    }
    const settings = await deps.settingsStore.getPublicSettings();
    const anyAiReady = deps.providerRouter
      ? deps.providerRouter.hasAnyConfiguredProvider()
      : deps.config.apiKeyConfigured;

    const aiEngineState: SystemHealthDTO['aiEngine'] = !anyAiReady
      ? 'unconfigured'
      : dbOk
        ? 'ready'
        : 'degraded';

    const voiceEngineState: SystemHealthDTO['voiceEngine'] =
      !deps.config.apiKeyConfigured && settings.voice.voiceModel !== 'free-browser-voice'
        ? 'unconfigured'
        : dbOk
          ? 'ready'
          : 'degraded';

    const payload: SystemHealthDTO = {
      status: dbOk ? 'online' : 'degraded',
      stage: 'Stage 5 · Monitoring, Usage & Final Delivery',
      backend: 'online',
      database: dbOk ? 'healthy' : 'unavailable',
      aiEngine: aiEngineState,
      voiceEngine: voiceEngineState,
      activeProvider: settings.activeProvider,
      activeModel: settings.activeModel,
      activeVoiceModel: settings.voice.voiceModel,
      apiBaseHost: deps.config.xaiBaseHost,
      uptimeSeconds: Math.floor((Date.now() - deps.startedAtMs) / 1000),
      appEnv: deps.config.appEnv,
      timestamp: new Date().toISOString(),
      features: {
        textChat: true,
        streaming: true,
        conversationHistory: true,
        voice: true,
        memory: false,
        tools: false,
        automation: false,
        desktop: true,
      },
    };

    return { dbOk, payload };
  };

  app.get('/health', async (_request, reply) => {
    const { dbOk, payload } = await buildHealthPayload();
    return reply.status(dbOk ? 200 : 503).send(payload);
  });

  app.get('/api/health', async () => {
    const { payload } = await buildHealthPayload();
    return payload;
  });
}
