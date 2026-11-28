import type { FastifyInstance } from 'fastify';
import type { SystemHealthDTO } from '@mj/shared';
import { SESSION_COOKIE_NAME, verifySessionToken } from '../auth.js';
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

export const DEFAULT_HEALTH_WATCHDOG_INTERVAL_MS = 60_000;

/**
 * Periodically checks local SQLite health even when `/health` receives no HTTP traffic,
 * dispatching `uptime_down` alerts whenever the database ping fails.
 */
export class HealthWatchdog {
  private timer: NodeJS.Timeout | null = null;
  private readonly intervalMs: number;

  constructor(
    private readonly deps: {
      dbHandle: MjDatabaseHandle;
      alertMonitor?: AlertMonitor;
      intervalMs?: number;
    },
  ) {
    this.intervalMs = deps.intervalMs ?? DEFAULT_HEALTH_WATCHDOG_INTERVAL_MS;
  }

  public async runCheck(): Promise<boolean> {
    let dbOk = false;
    try {
      dbOk = this.deps.dbHandle.ping();
    } catch {
      dbOk = false;
    }
    if (!dbOk) {
      await this.deps.alertMonitor?.notifyUptimeDegraded(
        'Background health watchdog: SQLite database ping failed',
      );
    }
    return dbOk;
  }

  public start(): void {
    if (this.intervalMs <= 0 || this.timer) return;
    this.timer = setInterval(() => {
      void this.runCheck();
    }, this.intervalMs);
    this.timer.unref();
  }

  public stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }
}

export function registerHealthRoutes(app: FastifyInstance, deps: HealthRouteDeps): void {
  const checkDatabaseHealth = (): boolean => {
    const dbOk = deps.dbHandle.ping();
    if (!dbOk) {
      void deps.alertMonitor?.notifyUptimeDegraded('SQLite database ping failed on health check');
    }
    return dbOk;
  };

  const buildHealthPayload = async (): Promise<{ dbOk: boolean; payload: SystemHealthDTO }> => {
    const dbOk = checkDatabaseHealth();
    const settings = await deps.settingsStore.getPublicSettings();
    const anyAiReady = deps.providerRouter
      ? deps.providerRouter.hasAnyConfiguredProvider()
      : deps.config.apiKeyConfigured;

    const aiEngineState: SystemHealthDTO['aiEngine'] = !anyAiReady
      ? 'unconfigured'
      : dbOk
        ? 'ready'
        : 'degraded';

    const geminiVoiceReady = Boolean(
      deps.config.aiProviders.gemini.apiKey &&
      (!deps.config.freeOnlyMode || !deps.config.aiProviders.gemini.paidTier),
    );
    const freeVoiceReady =
      geminiVoiceReady ||
      deps.config.aiProviders.ollama.enabled ||
      Boolean(deps.config.aiProviders.groq.apiKey) ||
      settings.voice.voiceModel === 'free-browser-voice' ||
      deps.config.freeOnlyMode;

    const voiceEngineState: SystemHealthDTO['voiceEngine'] =
      !(deps.config.freeOnlyMode ? freeVoiceReady : freeVoiceReady || deps.config.apiKeyConfigured)
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
      freeOnlyMode: deps.config.freeOnlyMode,
      activeProvider: settings.activeProvider,
      activeModel: settings.activeModel,
      activeVoiceModel: settings.voice.voiceModel,
      apiBaseHost: settings.apiBaseHost,
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

  const hasAuthenticatedSession = (cookieToken: string | undefined): boolean =>
    verifySessionToken(cookieToken, deps.config.authSecret) !== null;

  app.get('/health', async (request, reply) => {
    if (!hasAuthenticatedSession(request.cookies?.[SESSION_COOKIE_NAME])) {
      const dbOk = checkDatabaseHealth();
      return reply.status(dbOk ? 200 : 503).send({ status: dbOk ? 'ok' : 'error' });
    }
    const { dbOk, payload } = await buildHealthPayload();
    return reply.status(dbOk ? 200 : 503).send(payload);
  });

  app.get('/api/health', async (request, reply) => {
    if (!hasAuthenticatedSession(request.cookies?.[SESSION_COOKIE_NAME])) {
      const dbOk = checkDatabaseHealth();
      return reply.status(dbOk ? 200 : 503).send({ status: dbOk ? 'ok' : 'error' });
    }
    const { payload } = await buildHealthPayload();
    return payload;
  });
}
