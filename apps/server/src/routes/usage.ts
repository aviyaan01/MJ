import type { FastifyInstance, FastifyRequest } from 'fastify';
import { AppError, ErrorCodes, type ConnectivityCheckDTO } from '@mj/shared';
import type { ProviderRouterClient, XaiResponsesClient } from '@mj/ai';
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
    providerRouter?: ProviderRouterClient;
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
    async (request): Promise<ConnectivityCheckDTO> => {
      const settings = await deps.settingsStore.getPublicSettings();
      const checkedAt = new Date().toISOString();
      const anyConfigured = deps.providerRouter
        ? deps.providerRouter.hasAnyConfiguredProvider()
        : deps.config.freeOnlyMode
          ? false
          : deps.config.apiKeyConfigured;

      if (!anyConfigured) {
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
            message: 'API key invalid',
            retryable: false,
          },
          note: deps.config.freeOnlyMode
            ? 'FREE_ONLY_MODE=true: configure GEMINI_API_KEY, GROQ_API_KEY, or run Ollama locally.'
            : 'Configure XAI_API_KEY, a free-tier provider key (Groq/Gemini/OpenRouter/Cerebras), or run Ollama locally.',
        };
      }

      try {
        const probeResult = deps.providerRouter
          ? await deps.providerRouter.probeProvider(settings.activeProvider ?? 'auto', 10000)
          : {
            providerId: 'xai' as const,
            providerName: 'xAI Grok',
            modelChecked: settings.activeModel,
            ...(await deps.xaiClient.listAvailableModelIds(10000)),
          };
        const voices =
          !deps.config.freeOnlyMode && deps.config.apiKeyConfigured
            ? await deps.voiceGateway.listVoices().catch(() => null)
            : deps.config.freeOnlyMode
              ? await deps.voiceGateway.listVoices().catch(() => null)
              : null;

        const targetModel =
          probeResult.providerId === 'xai' ? settings.activeModel : probeResult.modelChecked;
        const modelAvailable =
          probeResult.modelIds.length > 0 ? probeResult.modelIds.includes(targetModel) : null;

        void deps.alertMonitor.recordApiOutcome({ ok: true });

        return {
          checkedAt,
          apiKeyConfigured: true,
          xaiReachable: true,
          modelChecked: targetModel,
          modelAvailable,
          availableModelCount: probeResult.modelIds.length,
          voiceModelChecked: settings.voice.voiceModel,
          availableVoiceCount: Array.isArray(voices) ? voices.length : null,
          latencyMs: probeResult.latencyMs,
          error: null,
          note:
            modelAvailable === false
              ? `${probeResult.providerName} responded in ${probeResult.latencyMs}ms, but "${targetModel}" was not listed in /models.`
              : `${probeResult.providerName} responded cleanly in ${probeResult.latencyMs}ms.`,
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

        request.log.error(
          {
            reqId: request.id,
            code: appErr.code,
            statusCode: appErr.statusCode,
            ...(appErr.upstreamDiagnostic
              ? { upstreamError: appErr.upstreamDiagnostic }
              : {}),
          },
          'xAI connectivity probe failed',
        );

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
