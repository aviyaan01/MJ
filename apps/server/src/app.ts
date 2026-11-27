import { existsSync, readFileSync, statSync } from 'node:fs';
import { extname, resolve, sep } from 'node:path';
import Fastify, { type FastifyInstance } from 'fastify';
import cookie from '@fastify/cookie';
import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import { AppError, ErrorCodes, sanitizeDiagnosticText, sanitizeUrlForLog } from '@mj/shared';
import { XaiResponsesClient } from '@mj/ai';
import {
  MjDatabaseRepository,
  createDatabase,
  type MjDatabaseHandle,
} from '@mj/database';
import { AlertMonitor } from './alerting.js';
import { createSessionGuard } from './auth.js';
import { DailyBackupScheduler } from './backupScheduler.js';
import { loadServerConfig, type ServerConfig } from './config.js';
import { PermissionsStore } from './permissionsStore.js';
import { RuntimeSettingsStore } from './settingsStore.js';
import { ShortcutsStore } from './shortcutsStore.js';
import { registerAuthRoutes } from './routes/auth.js';
import { registerConversationRoutes } from './routes/conversations.js';
import { registerDesktopRoutes } from './routes/desktop.js';
import { registerHealthRoutes } from './routes/health.js';
import { registerPrivacyRoutes } from './routes/privacy.js';
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
  alertMonitor?: AlertMonitor;
  dbHandle?: MjDatabaseHandle;
  logger?: boolean;
  webDistDir?: string;
}

export interface MjServerContext {
  app: FastifyInstance;
  config: ServerConfig;
  dbHandle: MjDatabaseHandle;
  repo: MjDatabaseRepository;
  settingsStore: RuntimeSettingsStore;
  permissionsStore: PermissionsStore;
  alertMonitor: AlertMonitor;
  backupScheduler: DailyBackupScheduler;
}

export async function buildServer(options: BuildServerOptions = {}): Promise<MjServerContext> {
  const config = options.config ?? loadServerConfig();
  const dbHandle = options.dbHandle ?? createDatabase(config.databaseUrl);
  const repo = new MjDatabaseRepository(dbHandle);
  const settingsStore = new RuntimeSettingsStore(repo, config);
  const permissionsStore = new PermissionsStore(repo);
  const shortcutsStore = new ShortcutsStore(repo);
  const alertMonitor = options.alertMonitor ?? new AlertMonitor(config.alerting);
  const backupScheduler = new DailyBackupScheduler(dbHandle, config.backup, alertMonitor);
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
            'req.headers["x-api-key"]',
            'req.headers["x-forwarded-for"]',
            'req.headers["x-real-ip"]',
            'req.headers["proxy-authorization"]',
            'req.remoteAddress',
            'res.headers["set-cookie"]',
          ],
          serializers: {
            req(request) {
              return {
                method: request.method,
                url: sanitizeUrlForLog(request.url),
              };
            },
            err(err) {
              return {
                type: err.name || 'Error',
                message: sanitizeDiagnosticText(err.message || 'Server error'),
                stack: sanitizeDiagnosticText(err.stack || ''),
              };
            },
          },
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
    alertMonitor,
  });
  registerAuthRoutes(app, config);
  registerSettingsRoutes(app, { settingsStore, requireSession });
  registerUsageRoutes(app, {
    config,
    repo,
    settingsStore,
    xaiClient,
    voiceGateway,
    alertMonitor,
    requireSession,
  });
  registerPrivacyRoutes(app, {
    repo,
    permissionsStore,
    settingsStore,
    requireSession,
  });
  registerDesktopRoutes(app, {
    repo,
    permissionsStore,
    shortcutsStore,
    requireSession,
  });
  registerVoiceRoutes(app, {
    config,
    repo,
    settingsStore,
    permissionsStore,
    voiceGateway,
    alertMonitor,
    requireSession,
  });
  registerConversationRoutes(app, {
    config,
    repo,
    settingsStore,
    permissionsStore,
    xaiClient,
    alertMonitor,
    requireSession,
  });

  // Optional production single-server static frontend serving (built apps/web/dist)
  const resolvedWebDist =
    options.webDistDir ??
    (config.serveWebDist ? resolve(config.rootDir, 'apps', 'web', 'dist') : null);

  if (resolvedWebDist && existsSync(resolve(resolvedWebDist, 'index.html'))) {
    const distRoot = resolve(resolvedWebDist);
    const mimeByExt: Record<string, string> = {
      '.html': 'text/html; charset=utf-8',
      '.js': 'application/javascript; charset=utf-8',
      '.css': 'text/css; charset=utf-8',
      '.json': 'application/json; charset=utf-8',
      '.svg': 'image/svg+xml',
      '.png': 'image/png',
      '.ico': 'image/x-icon',
      '.woff2': 'font/woff2',
    };

    app.get('/*', async (request, reply) => {
      const urlPath = request.url.split('?')[0] ?? '/';
      if (urlPath === '/api' || urlPath.startsWith('/api/')) {
        throw new AppError({
          code: ErrorCodes.NOT_FOUND,
          category: 'validation',
          statusCode: 404,
          requestId: request.id,
          message: `API endpoint "${urlPath}" not found.`,
        });
      }

      const safeRel = decodeURIComponent(urlPath).replace(/^\/+/, '');
      const candidate = resolve(distRoot, safeRel);
      const insideDist =
        candidate === distRoot || candidate.startsWith(`${distRoot}${sep}`);

      if (insideDist && safeRel.length > 0 && existsSync(candidate) && statSync(candidate).isFile()) {
        const ext = extname(candidate).toLowerCase();
        const isHashedAsset = urlPath.startsWith('/assets/');
        return reply
          .header('Content-Type', mimeByExt[ext] ?? 'application/octet-stream')
          .header(
            'Cache-Control',
            isHashedAsset ? 'public, max-age=31536000, immutable' : 'no-cache',
          )
          .send(readFileSync(candidate));
      }

      return reply
        .header('Content-Type', 'text/html; charset=utf-8')
        .header('Cache-Control', 'no-cache')
        .send(readFileSync(resolve(distRoot, 'index.html')));
    });
  }

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

    const sanitizedDetail =
      err instanceof Error ? sanitizeDiagnosticText(err.message) : 'Unexpected server error';

    request.log.error(
      {
        reqId: request.id,
        errName: err instanceof Error ? err.name : 'UnknownError',
        detail: sanitizedDetail,
      },
      'Unhandled server error',
    );

    void alertMonitor.recordApiOutcome({ ok: false, code: ErrorCodes.INTERNAL_ERROR });
    void alertMonitor.notifyCrash('http_request_handler', err);

    const internalErr = new AppError({
      code: ErrorCodes.INTERNAL_ERROR,
      category: 'internal',
      statusCode: 500,
      requestId: request.id,
    });
    return reply.status(500).send({ error: internalErr.toPayload() });
  });

  app.addHook('onClose', async () => {
    backupScheduler.stop();
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
    permissionsStore,
    alertMonitor,
    backupScheduler,
  };
}
