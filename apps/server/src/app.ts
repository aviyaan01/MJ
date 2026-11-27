import Fastify, { type FastifyInstance } from 'fastify';
import cookie from '@fastify/cookie';
import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import { AppError, ErrorCodes } from '@mj/shared';
import { XaiResponsesClient } from '@mj/ai';
import {
  MjDatabaseRepository,
  createDatabase,
  type MjDatabaseHandle,
} from '@mj/database';
import { createSessionGuard } from './auth.js';
import { loadServerConfig, type ServerConfig } from './config.js';
import { RuntimeSettingsStore } from './settingsStore.js';
import { registerAuthRoutes } from './routes/auth.js';
import { registerConversationRoutes } from './routes/conversations.js';
import { registerHealthRoutes } from './routes/health.js';
import { registerSettingsRoutes } from './routes/settings.js';
import { registerUsageRoutes } from './routes/usage.js';
import {
  createDefaultVoiceGateway,
  registerVoiceRoutes,
  type VoiceGateway,
} from './routes/voice.js';

export interface BuildServerOptions {
  config?: ServerConfig;
  xaiClient?: XaiResponsesClient;
  voiceGateway?: VoiceGateway;
  dbHandle?: MjDatabaseHandle;
  logger?: boolean;
}

export interface MjServerContext {
  app: FastifyInstance;
  config: ServerConfig;
  dbHandle: MjDatabaseHandle;
  repo: MjDatabaseRepository;
  settingsStore: RuntimeSettingsStore;
}

export async function buildServer(options: BuildServerOptions = {}): Promise<MjServerContext> {
  const config = options.config ?? loadServerConfig();
  const dbHandle = options.dbHandle ?? createDatabase(config.databaseUrl);
  const repo = new MjDatabaseRepository(dbHandle);
  const settingsStore = new RuntimeSettingsStore(repo, config);
  const xaiClient =
    options.xaiClient ??
    new XaiResponsesClient({
      apiKey: config.xaiApiKey,
      baseUrl: config.xaiBaseUrl,
      defaultModel: config.xaiTextModel,
      timeoutMs: config.xaiTimeoutMs,
      maxRetries: 2,
    });
  const voiceGateway = options.voiceGateway ?? createDefaultVoiceGateway(config);

  const startedAtMs = Date.now();

  const app = Fastify({
    logger:
      options.logger ??
      (config.appEnv !== 'test'
        ? {
            level: config.appEnv === 'production' ? 'info' : 'warn',
            redact: [
              'req.headers.authorization',
              'req.headers.cookie',
              'res.headers["set-cookie"]',
            ],
          }
        : false),
    bodyLimit: 256 * 1024,
    trustProxy: config.appEnv === 'production',
  });

  await app.register(helmet, {
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'"],
        styleSrc: ["'self'", "'unsafe-inline'"],
        imgSrc: ["'self'", 'data:'],
        connectSrc: ["'self'", 'wss://api.x.ai', 'https://api.x.ai'],
        mediaSrc: ["'self'", 'blob:'],
        objectSrc: ["'none'"],
        frameAncestors: ["'none'"],
      },
    },
    crossOriginEmbedderPolicy: false,
  });

  await app.register(cors, {
    origin: (origin, callback) => {
      if (!origin || config.corsOrigins.includes(origin)) {
        callback(null, true);
        return;
      }
      callback(
        new AppError({
          code: ErrorCodes.UNAUTHORIZED,
          category: 'auth',
          statusCode: 403,
          message: 'Origin not permitted by CORS policy.',
        }),
        false,
      );
    },
    credentials: true,
    methods: ['GET', 'POST', 'PATCH', 'DELETE', 'OPTIONS'],
  });

  await app.register(cookie);

  await app.register(rateLimit, {
    max: 90,
    timeWindow: '1 minute',
    errorResponseBuilder: (_req, context) => {
      const err = new AppError({
        code: ErrorCodes.RATE_LIMITED,
        category: 'api',
        statusCode: 429,
        message: 'Too many requests to the MJ server. Please pause briefly and try again.',
        retryAfterMs: context.ttl,
      });
      return { error: err.toPayload() };
    },
  });

  const requireSession = createSessionGuard(config);

  registerHealthRoutes(app, {
    config,
    dbHandle,
    settingsStore,
    startedAtMs,
  });
  registerAuthRoutes(app, config);
  registerSettingsRoutes(app, { settingsStore, requireSession });
  registerUsageRoutes(app, { repo, settingsStore, requireSession });
  registerVoiceRoutes(app, {
    config,
    repo,
    settingsStore,
    voiceGateway,
    requireSession,
  });
  registerConversationRoutes(app, {
    config,
    repo,
    settingsStore,
    xaiClient,
    requireSession,
  });

  app.setErrorHandler((err, request, reply) => {
    if (err instanceof AppError) {
      err.requestId = err.requestId ?? request.id;
      return reply.status(err.statusCode).send({ error: err.toPayload() });
    }

    const fastifyErr = err as { statusCode?: number; code?: string; message?: string };
    if (fastifyErr.statusCode === 429) {
      const rateErr = new AppError({
        code: ErrorCodes.RATE_LIMITED,
        category: 'api',
        statusCode: 429,
        requestId: request.id,
      });
      return reply.status(429).send({ error: rateErr.toPayload() });
    }

    if (fastifyErr.statusCode && fastifyErr.statusCode >= 400 && fastifyErr.statusCode < 500) {
      const valErr = new AppError({
        code: ErrorCodes.VALIDATION_ERROR,
        category: 'validation',
        statusCode: fastifyErr.statusCode,
        message: fastifyErr.message || 'Invalid request.',
        requestId: request.id,
      });
      return reply.status(valErr.statusCode).send({ error: valErr.toPayload() });
    }

    request.log.error(
      {
        reqId: request.id,
        errName: err instanceof Error ? err.name : 'UnknownError',
      },
      'Unhandled server error',
    );

    const internalErr = new AppError({
      code: ErrorCodes.INTERNAL_ERROR,
      category: 'internal',
      statusCode: 500,
      requestId: request.id,
    });
    return reply.status(500).send({ error: internalErr.toPayload() });
  });

  app.addHook('onClose', async () => {
    if (!options.dbHandle) {
      dbHandle.close();
    }
  });

  return {
    app,
    config,
    dbHandle,
    repo,
    settingsStore,
  };
}
