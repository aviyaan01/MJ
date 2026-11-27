import type { FastifyInstance } from 'fastify';
import type { SystemHealthDTO } from '@mj/shared';
import type { MjDatabaseHandle } from '@mj/database';
import type { ServerConfig } from '../config.js';
import type { RuntimeSettingsStore } from '../settingsStore.js';

export interface HealthRouteDeps {
  config: ServerConfig;
  dbHandle: MjDatabaseHandle;
  settingsStore: RuntimeSettingsStore;
  startedAtMs: number;
}

export function registerHealthRoutes(app: FastifyInstance, deps: HealthRouteDeps): void {
  app.get('/api/health', async () => {
    const dbOk = deps.dbHandle.ping();
    const settings = await deps.settingsStore.getPublicSettings();

    const engineState: SystemHealthDTO['aiEngine'] = !deps.config.apiKeyConfigured
      ? 'unconfigured'
      : dbOk
        ? 'ready'
        : 'degraded';

    const payload: SystemHealthDTO = {
      status: dbOk ? 'online' : 'degraded',
      stage: 'Stage 2 · Text & Realtime Voice',
      backend: 'online',
      database: dbOk ? 'healthy' : 'unavailable',
      aiEngine: engineState,
      voiceEngine: engineState,
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
        desktop: false,
      },
    };

    return payload;
  });
}
