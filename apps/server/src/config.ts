import { randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';
import type { ReasoningEffort } from '@mj/shared';
import type { AlertingConfig } from './alerting.js';
import type { BackupSchedulerConfig } from './backupScheduler.js';

export interface ServerConfig {
  appEnv: 'development' | 'test' | 'production';
  host: string;
  port: number;
  corsOrigins: string[];
  databaseUrl: string;
  xaiApiKey: string;
  apiKeyConfigured: boolean;
  xaiBaseUrl: string;
  xaiRealtimeUrl: string;
  xaiBaseHost: string;
  xaiTextModel: string;
  availableModels: string[];
  xaiVoiceModel: string;
  availableVoiceModels: string[];
  xaiTimeoutMs: number;
  xaiMaxOutputTokens: number;
  xaiReasoningEffort: ReasoningEffort;
  authSecret: string;
  authSecretEphemeral: boolean;
  accessPasscode: string;
  passcodeRequired: boolean;
  serveWebDist: boolean;
  cookieSameSite: 'lax' | 'strict' | 'none';
  cookieDomain?: string;
  alerting: AlertingConfig;
  backup: BackupSchedulerConfig;
  rootDir: string;
}

const DEFAULT_SUGGESTED_MODELS = [
  'grok-4.7',
  'grok-4.6',
  'grok-4.5',
  'grok-4-1-fast',
  'grok-3',
];

const DEFAULT_VOICE_MODELS = ['grok-voice-latest', 'grok-voice-3.0'];

function findMonorepoRoot(startDir: string): string {
  let current = startDir;
  for (let i = 0; i < 6; i++) {
    if (existsSync(resolve(current, '.env.example')) || existsSync(resolve(current, 'tsconfig.base.json'))) {
      return current;
    }
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return process.cwd();
}

export function isPlaceholderValue(value: string | undefined): boolean {
  if (!value) return true;
  const normalized = value.trim().toLowerCase();
  if (!normalized) return true;
  return (
    normalized.startsWith('your_') ||
    normalized.startsWith('replace_with') ||
    normalized.startsWith('<') ||
    normalized === 'changeme' ||
    normalized === 'placeholder'
  );
}

function deriveRealtimeUrl(baseUrl: string): string {
  const trimmed = baseUrl.replace(/\/+$/, '');
  const wsBase = trimmed.replace(/^https:/i, 'wss:').replace(/^http:/i, 'ws:');
  return wsBase.endsWith('/realtime') ? wsBase : `${wsBase}/realtime`;
}

export function loadServerConfig(envOverrides?: Record<string, string | undefined>): ServerConfig {
  const thisDir = dirname(fileURLToPath(import.meta.url));
  const rootDir = findMonorepoRoot(thisDir);

  if (!envOverrides) {
    const rootEnvPath = resolve(rootDir, '.env');
    if (existsSync(rootEnvPath)) {
      dotenv.config({ path: rootEnvPath });
    } else {
      dotenv.config();
    }
  }

  const env = envOverrides ?? process.env;

  const rawAppEnv = (env.APP_ENV ?? 'development').trim().toLowerCase();
  const appEnv: ServerConfig['appEnv'] =
    rawAppEnv === 'production' ? 'production' : rawAppEnv === 'test' ? 'test' : 'development';

  const rawApiKey = (env.XAI_API_KEY ?? '').trim();
  const apiKeyConfigured = !isPlaceholderValue(rawApiKey);
  const xaiApiKey = apiKeyConfigured ? rawApiKey : '';

  const rawBaseUrl = (env.XAI_BASE_URL ?? 'https://api.x.ai/v1').trim();
  let xaiBaseHost = 'api.x.ai';
  try {
    xaiBaseHost = new URL(rawBaseUrl).host;
  } catch {
    xaiBaseHost = 'api.x.ai';
  }
  const xaiRealtimeUrl = deriveRealtimeUrl(rawBaseUrl);

  const xaiTextModel = !isPlaceholderValue(env.XAI_TEXT_MODEL)
    ? env.XAI_TEXT_MODEL!.trim()
    : 'grok-4.7';

  const extraModels = (env.XAI_AVAILABLE_MODELS ?? '')
    .split(',')
    .map((m) => m.trim())
    .filter(Boolean);

  const availableModels = Array.from(
    new Set([xaiTextModel, ...extraModels, ...DEFAULT_SUGGESTED_MODELS]),
  );

  const xaiVoiceModel = !isPlaceholderValue(env.XAI_VOICE_MODEL)
    ? env.XAI_VOICE_MODEL!.trim()
    : 'grok-voice-latest';

  const availableVoiceModels = Array.from(
    new Set([xaiVoiceModel, ...DEFAULT_VOICE_MODELS]),
  );

  const rawDatabaseUrl = (env.DATABASE_URL ?? './data/mj-assistant.db').trim();
  const databaseUrl =
    rawDatabaseUrl === ':memory:' || rawDatabaseUrl.startsWith('file::memory:')
      ? ':memory:'
      : rawDatabaseUrl.startsWith('file:')
        ? resolve(rootDir, rawDatabaseUrl.slice(5))
        : resolve(rootDir, rawDatabaseUrl);

  const rawAuthSecret = (env.AUTH_SECRET ?? '').trim();
  const hasValidAuthSecret = !isPlaceholderValue(rawAuthSecret) && rawAuthSecret.length >= 32;

  if (appEnv === 'production' && !hasValidAuthSecret) {
    throw new Error(
      'AUTH_SECRET must be set to a non-placeholder random string of at least 32 characters in production.',
    );
  }

  const authSecret = hasValidAuthSecret ? rawAuthSecret : randomBytes(32).toString('hex');
  const authSecretEphemeral = !hasValidAuthSecret;

  const accessPasscode = (env.APP_ACCESS_PASSCODE ?? '').trim();
  if (appEnv === 'production' && accessPasscode.length < 8) {
    throw new Error(
      'APP_ACCESS_PASSCODE (min 8 characters) is required when APP_ENV=production.',
    );
  }
  const passcodeRequired = accessPasscode.length > 0;

  const parsedCorsOrigins = (env.CORS_ORIGIN ?? 'http://localhost:5173')
    .split(',')
    .map((origin) => origin.trim())
    .filter(Boolean);

  // In local dev/test, browsers accessing Vite via http://127.0.0.1:5173 vs http://localhost:5173
  // send distinct Origin headers for the same local Vite instance; keep production strictly exact.
  const corsOrigins =
    appEnv === 'production'
      ? parsedCorsOrigins
      : Array.from(
          new Set(
            parsedCorsOrigins.flatMap((origin) => {
              try {
                const u = new URL(origin);
                if (u.hostname === 'localhost') {
                  return [origin, `${u.protocol}//127.0.0.1${u.port ? `:${u.port}` : ''}`];
                }
                if (u.hostname === '127.0.0.1') {
                  return [origin, `${u.protocol}//localhost${u.port ? `:${u.port}` : ''}`];
                }
              } catch {
                // ignore malformed origin; preserve verbatim
              }
              return [origin];
            }),
          ),
        );

  const rawEffort = (env.XAI_REASONING_EFFORT ?? 'medium').trim().toLowerCase();
  const xaiReasoningEffort: ReasoningEffort =
    rawEffort === 'low' || rawEffort === 'high' || rawEffort === 'xhigh' ? rawEffort : 'medium';

  const portNum = Number(env.PORT ?? 3001);
  const timeoutNum = Number(env.XAI_TIMEOUT_MS ?? 60000);
  const maxTokensNum = Number(env.XAI_MAX_OUTPUT_TOKENS ?? 4096);

  const rawServeWeb = (env.SERVE_WEB_DIST ?? '').trim().toLowerCase();
  const serveWebDist =
    rawServeWeb === 'true' ? true : rawServeWeb === 'false' ? false : appEnv === 'production';

  const rawSameSite = (env.COOKIE_SAME_SITE ?? 'lax').trim().toLowerCase();
  const cookieSameSite: ServerConfig['cookieSameSite'] =
    rawSameSite === 'strict' ? 'strict' : rawSameSite === 'none' ? 'none' : 'lax';
  const rawCookieDomain = (env.COOKIE_DOMAIN ?? '').trim();
  const cookieDomain = rawCookieDomain && !isPlaceholderValue(rawCookieDomain) ? rawCookieDomain : undefined;

  const cleanEnvSecret = (val: string | undefined): string | undefined => {
    const trimmed = (val ?? '').trim();
    return trimmed && !isPlaceholderValue(trimmed) ? trimmed : undefined;
  };
  const clampNumber = (val: string | undefined, fallback: number, min: number, max: number): number => {
    const parsed = Number(val);
    return Number.isFinite(parsed) && parsed >= min && parsed <= max ? parsed : fallback;
  };
  const smtpPort = clampNumber(env.ALERT_SMTP_PORT, 587, 1, 65535);
  const rawSmtpSecure = (env.ALERT_SMTP_SECURE ?? '').trim().toLowerCase();
  const smtpSecure =
    rawSmtpSecure === 'true' ? true : rawSmtpSecure === 'false' ? false : smtpPort === 465;

  const alerting: AlertingConfig = {
    appEnv,
    telegramBotToken: cleanEnvSecret(env.ALERT_TELEGRAM_BOT_TOKEN),
    telegramChatId: cleanEnvSecret(env.ALERT_TELEGRAM_CHAT_ID),
    resendApiKey: cleanEnvSecret(env.ALERT_RESEND_API_KEY),
    smtpHost: cleanEnvSecret(env.ALERT_SMTP_HOST),
    smtpPort,
    smtpSecure,
    smtpUser: cleanEnvSecret(env.ALERT_SMTP_USER),
    smtpPass: cleanEnvSecret(env.ALERT_SMTP_PASS),
    emailFrom: cleanEnvSecret(env.ALERT_EMAIL_FROM),
    emailTo: cleanEnvSecret(env.ALERT_EMAIL_TO),
    errorRateThresholdPct: clampNumber(env.ALERT_ERROR_RATE_PCT, 25, 1, 100),
    minSampleRequests: clampNumber(env.ALERT_MIN_REQUESTS, 5, 1, 500),
    windowMinutes: clampNumber(env.ALERT_WINDOW_MINUTES, 15, 1, 1440),
    cooldownMinutes: clampNumber(env.ALERT_COOLDOWN_MINUTES, 15, 1, 1440),
  };

  const rawBackupEnabled = (env.BACKUP_ENABLED ?? '').trim().toLowerCase();
  const backupEnabled =
    rawBackupEnabled === 'false' ? false : rawBackupEnabled === 'true' ? true : appEnv !== 'test';
  const rawBackupDir = (env.BACKUP_DIR ?? './data/backups').trim() || './data/backups';
  const explicitBackupKey = cleanEnvSecret(env.BACKUP_ENCRYPTION_KEY);
  const backupEncryptionKey =
    explicitBackupKey && explicitBackupKey.length >= 16
      ? explicitBackupKey
      : !authSecretEphemeral && authSecret.length >= 16
        ? authSecret
        : undefined;

  const backup: BackupSchedulerConfig = {
    enabled: backupEnabled,
    dir: resolve(rootDir, rawBackupDir),
    ...(backupEncryptionKey ? { encryptionKey: backupEncryptionKey } : {}),
    intervalHours: clampNumber(env.BACKUP_INTERVAL_HOURS, 24, 1, 168),
    retentionCount: clampNumber(env.BACKUP_RETENTION_COUNT, 14, 1, 365),
  };

  return {
    appEnv,
    host: (env.HOST ?? '127.0.0.1').trim(),
    port: Number.isFinite(portNum) && portNum > 0 ? portNum : 3001,
    corsOrigins,
    databaseUrl,
    xaiApiKey,
    apiKeyConfigured,
    xaiBaseUrl: rawBaseUrl,
    xaiRealtimeUrl,
    xaiBaseHost,
    xaiTextModel,
    availableModels,
    xaiVoiceModel,
    availableVoiceModels,
    xaiTimeoutMs: Number.isFinite(timeoutNum) && timeoutNum >= 5000 ? timeoutNum : 60000,
    xaiMaxOutputTokens: Number.isFinite(maxTokensNum) && maxTokensNum >= 128 ? maxTokensNum : 4096,
    xaiReasoningEffort,
    authSecret,
    authSecretEphemeral,
    accessPasscode,
    passcodeRequired,
    serveWebDist,
    cookieSameSite,
    ...(cookieDomain ? { cookieDomain } : {}),
    alerting,
    backup,
    rootDir,
  };
}
