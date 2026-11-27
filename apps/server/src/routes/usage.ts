import type { FastifyInstance, FastifyRequest } from 'fastify';
import { AppError, ErrorCodes, type ConnectivityCheckDTO } from '@mj/shared';
import type { XaiResponsesClient } from '@mj/ai';
import type { MjDatabaseRepository } from '@mj/database';
import type { AlertMonitor } from '../alerting.js';
import type { ServerConfig } from '../config.js';
import type { RuntimeSettingsStore } from '../settingsStore.js';
import type { VoiceGateway } from './voice.js';

export function registerUsageRoutes(
  app: FastifyInstance,
  deps: {
    config: ServerConfig;
    repo: MjDatabaseRepository;
    settingsStore: RuntimeSettingsStore;
    xaiClient: XaiResponsesClient;
    voiceGateway: VoiceGateway;
    alertMonitor: AlertMonitor;
    requireSession: (request: FastifyRequest) => Promise<void>;
  },
): void {
  app.get('/api/usage', { preHandler: deps.requireSession }, async () => {
    const settings = await deps.settingsStore.getPublicSettings();
    const summary = await deps.repo.getUsageSummary(settings.budget);
    return {
      ...summary,
      alerting: deps.alertMonitor.getStatus(),
    };
  });

  app.post(
    '/api/usage/connectivity',
    {
      preHandler: deps.requireSession,
      config: {
        rateLimit: {
          max: 12,
          timeWindow: '1 minute',
        },
      },
    },
    async (): Promise<ConnectivityCheckDTO> => {
      const settings = await deps.settingsStore.getPublicSettings();
      const checkedAt = new Date().toISOString();

      if (!deps.config.apiKeyConfigured) {
        return {
          checkedAt,
          apiKeyConfigured: false,
          xaiReachable: false,
          modelChecked: settings.activeModel,
          modelAvailable: null,
          availableModelCount: null,
          voiceModelChecked: settings.voice.voiceModel,
          availableVoiceCount: null,
          latencyMs: null,
          error: {
            code: ErrorCodes.INVALID_API_KEY,
            category: 'api',
            statusCode: 502,
            message: 'XAI_API_KEY is not configured in the backend environment.',
            retryable: false,
          },
          note: 'Configure XAI_API_KEY in .env to enable live xAI connectivity.',
        };
      }

      try {
        const [{ modelIds, latencyMs }, voices] = await Promise.all([
          deps.xaiClient.listAvailableModelIds(10000),
          deps.voiceGateway.listVoices().catch(() => null),
        ]);

        const modelAvailable =
          modelIds.length > 0 ? modelIds.includes(settings.activeModel) : null;

        void deps.alertMonitor.recordApiOutcome({ ok: true });

        return {
          checkedAt,
          apiKeyConfigured: true,
          xaiReachable: true,
          modelChecked: settings.activeModel,
          modelAvailable,
          availableModelCount: modelIds.length,
          voiceModelChecked: settings.voice.voiceModel,
          availableVoiceCount: Array.isArray(voices) ? voices.length : null,
          latencyMs,
          error: null,
          note:
            modelAvailable === false
              ? `xAI API responded in ${latencyMs}ms, but "${settings.activeModel}" was not listed in /v1/models.`
              : `xAI API responded in ${latencyMs}ms.`,
        };
      } catch (err) {
        const appErr =
          err instanceof AppError
            ? err
            : new AppError({
                code: ErrorCodes.NETWORK_DISCONNECTED,
                category: 'network',
                statusCode: 503,
                cause: err,
              });

        void deps.alertMonitor.recordApiOutcome({ ok: false, code: appErr.code });

        return {
          checkedAt,
          apiKeyConfigured: true,
          xaiReachable: false,
          modelChecked: settings.activeModel,
          modelAvailable: false,
          availableModelCount: null,
          voiceModelChecked: settings.voice.voiceModel,
          availableVoiceCount: null,
          latencyMs: null,
          error: appErr.toPayload(),
          note: appErr.message,
        };
      }
    },
  );
}
