import { randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';
import { findMonorepoRoot, resolveSqlitePath } from '@mj/database';
import type { AiProviderId, ReasoningEffort } from '@mj/shared';
import type { AlertingConfig } from './alerting.js';
import type { BackupSchedulerConfig } from './backupScheduler.js';

export interface ServerConfig {
  appEnv: 'development' | 'test' | 'production';
  freeOnlyMode: boolean;
  userName?: string;
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
  voiceModel: string;
  geminiVoiceModel: string;
  xaiVoiceModel: string;
  availableVoiceModels: string[];
  geminiRealtimeUrl: string;
  geminiLiveModel: string;
  backupKeyWarning?: string;
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
  aiProviders: {
    defaultProvider: AiProviderId;
    ollama: { enabled: boolean; baseUrl: string; model: string };
    groq: { apiKey: string; baseUrl: string; model: string };
    gemini: { apiKey: string; baseUrl: string; model: string; paidTier: boolean };
    openrouter: { apiKey: string; baseUrl: string; model: string };
    cerebras: { apiKey: string; baseUrl: string; model: string };
    mistral: { apiKey: string; baseUrl: string; model: string };
    github: { apiKey: string; baseUrl: string; model: string };
  };
  toolsConfig: {
    openWeatherApiKey: string;
    webSearchApiKey: string;
    webSearchBaseUrl: string;
  };
  rootDir: string;
}

const DEFAULT_SUGGESTED_MODELS = [
  'grok-4.7',
  'grok-4.6',
  'grok-4.5',
  'grok-4-1-fast',
  'grok-3',
];

const DEFAULT_VOICE_MODELS = [
  'gemini-2.5-flash-native-audio-preview-12-2025',
  'free-browser-voice',
  'grok-voice-latest',
  'grok-voice-3.0',
];

const DEFAULT_GEMINI_LIVE_MODEL = 'gemini-2.5-flash-native-audio-preview-12-2025';
const DEFAULT_GEMINI_REALTIME_URL =
  'wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1alpha.GenerativeService.BidiGenerateContentConstrained';

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

function cleanEnvSecret(val: string | undefined): string | undefined {
  const trimmed = (val ?? '').trim();
  return trimmed && !isPlaceholderValue(trimmed) ? trimmed : undefined;
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
  const userName = cleanEnvSecret(env.USER_NAME);

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

  const geminiDefaultModel = !isPlaceholderValue(env.GEMINI_MODEL)
    ? env.GEMINI_MODEL!.trim()
    : 'gemini-2.5-flash';

  const geminiApiKey = cleanEnvSecret(env.GEMINI_API_KEY) ?? '';
  const groqApiKey = cleanEnvSecret(env.GROQ_API_KEY) ?? '';
  const rawFreeOnly = (env.FREE_ONLY_MODE ?? '').trim().toLowerCase();
  const isLegacyXaiOnlyTest =
    appEnv === 'test' &&
    apiKeyConfigured &&
    !geminiApiKey &&
    !groqApiKey &&
    !env.AI_PROVIDER &&
    rawFreeOnly === '';
  const freeOnlyMode =
    rawFreeOnly === 'false' ? false : rawFreeOnly === 'true' ? true : !isLegacyXaiOnlyTest;

  const xaiTextModel = !isPlaceholderValue(env.XAI_TEXT_MODEL)
    ? env.XAI_TEXT_MODEL!.trim()
    : 'grok-4.7';

  const extraModels = (env.XAI_AVAILABLE_MODELS ?? '')
    .split(',')
    .map((m) => m.trim())
    .filter(Boolean);

  const availableModels = Array.from(
    new Set(
      freeOnlyMode
        ? [geminiDefaultModel, 'gemini-2.5-flash-lite', 'gemini-2.5-pro']
        : [
            geminiDefaultModel,
            'gemini-2.5-flash-lite',
            'gemini-2.5-pro',
            xaiTextModel,
            ...extraModels,
            ...DEFAULT_SUGGESTED_MODELS,
          ],
    ),
  );

  const requestedVoiceModel = cleanEnvSecret(env.VOICE_MODEL);
  const geminiVoiceModel =
    cleanEnvSecret(env.GEMINI_VOICE_MODEL) ??
    cleanEnvSecret(env.GEMINI_LIVE_MODEL) ??
    (requestedVoiceModel && !requestedVoiceModel.toLowerCase().startsWith('grok-')
      ? requestedVoiceModel
      : undefined) ??
    DEFAULT_GEMINI_LIVE_MODEL;
  const geminiLiveModel = geminiVoiceModel;
  const geminiRealtimeUrl =
    (env.GEMINI_REALTIME_URL ?? '').trim() || DEFAULT_GEMINI_REALTIME_URL;

  const xaiVoiceModel = cleanEnvSecret(env.XAI_VOICE_MODEL) ?? 'grok-voice-latest';

  const rawDatabaseUrl = (env.DATABASE_URL ?? './data/mj-assistant.db').trim();
  const databaseUrl = resolveSqlitePath(rawDatabaseUrl, rootDir);

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

  const rawCorsOrigin = (env.CORS_ORIGIN ?? '').trim();
  const parsedCorsOrigins = rawCorsOrigin
    ? rawCorsOrigin
      .split(',')
      .map((origin) => origin.trim())
      .filter(Boolean)
    : appEnv === 'production'
      ? ['tauri://localhost', 'http://tauri.localhost']
      : ['http://localhost:5173', 'http://127.0.0.1:5173'];

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
  let backupEncryptionKey: string | undefined;
  let backupKeyWarning: string | undefined;

  if (!explicitBackupKey) {
    if (backupEnabled) {
      backupKeyWarning =
        'Dedicated BACKUP_ENCRYPTION_KEY (>= 16 chars) is not set; refusing AUTH_SECRET fallback so session signing and backup keys remain separate.';
    }
  } else if (explicitBackupKey.length < 16) {
    backupKeyWarning =
      'BACKUP_ENCRYPTION_KEY must be at least 16 characters; encrypted backups remain inactive until configured.';
  } else if (hasValidAuthSecret && explicitBackupKey === rawAuthSecret) {
    backupKeyWarning =
      'BACKUP_ENCRYPTION_KEY must not match AUTH_SECRET; encrypted backups remain inactive until a separate dedicated key is configured.';
  } else {
    backupEncryptionKey = explicitBackupKey;
  }

  const backup: BackupSchedulerConfig = {
    enabled: backupEnabled,
    dir: resolve(rootDir, rawBackupDir),
    ...(backupEncryptionKey ? { encryptionKey: backupEncryptionKey } : {}),
    intervalHours: clampNumber(env.BACKUP_INTERVAL_HOURS, 24, 1, 168),
    retentionCount: clampNumber(env.BACKUP_RETENTION_COUNT, 14, 1, 365),
  };

  const geminiPaidTier = (env.GEMINI_PAID_TIER ?? '').trim().toLowerCase() === 'true';

  const rawDefaultProvider = (
    env.AI_PROVIDER ?? (isLegacyXaiOnlyTest ? 'xai' : 'gemini')
  )
    .trim()
    .toLowerCase();
  const validProviders = new Set<AiProviderId>([
    'auto',
    'xai',
    'ollama',
    'groq',
    'gemini',
    'openrouter',
    'cerebras',
    'mistral',
    'github',
  ]);
  const strictFreeProviders = new Set<AiProviderId>(['auto', 'gemini', 'ollama', 'groq']);
  const parsedProvider: AiProviderId = validProviders.has(rawDefaultProvider as AiProviderId)
    ? (rawDefaultProvider as AiProviderId)
    : 'gemini';
  const defaultProvider: AiProviderId =
    freeOnlyMode && !strictFreeProviders.has(parsedProvider) ? 'auto' : parsedProvider;

  const safeRequestedVoiceModel =
    requestedVoiceModel && (!freeOnlyMode || !requestedVoiceModel.toLowerCase().startsWith('grok-'))
      ? requestedVoiceModel
      : undefined;
  const voiceModel =
    !freeOnlyMode && defaultProvider === 'xai'
      ? (safeRequestedVoiceModel ?? cleanEnvSecret(env.XAI_VOICE_MODEL) ?? xaiVoiceModel)
      : (safeRequestedVoiceModel ??
          cleanEnvSecret(env.GEMINI_VOICE_MODEL) ??
          cleanEnvSecret(env.GEMINI_LIVE_MODEL) ??
          (geminiApiKey && (!freeOnlyMode || !geminiPaidTier)
            ? geminiVoiceModel
            : !freeOnlyMode && apiKeyConfigured
              ? xaiVoiceModel
              : 'free-browser-voice'));

  const availableVoiceModels = Array.from(
    new Set(
      freeOnlyMode
        ? [voiceModel, geminiVoiceModel, 'free-browser-voice']
        : [voiceModel, geminiVoiceModel, 'free-browser-voice', xaiVoiceModel, ...DEFAULT_VOICE_MODELS],
    ),
  );

  const rawOllamaEnabled = (env.OLLAMA_ENABLED ?? '').trim().toLowerCase();
  const ollamaEnabled =
    rawOllamaEnabled === 'true'
      ? true
      : rawOllamaEnabled === 'false'
        ? false
        : appEnv === 'development';

  const aiProviders: ServerConfig['aiProviders'] = {
    defaultProvider,
    ollama: {
      enabled: ollamaEnabled,
      baseUrl: (env.OLLAMA_BASE_URL ?? 'http://127.0.0.1:11434/v1').trim(),
      model: !isPlaceholderValue(env.OLLAMA_MODEL) ? env.OLLAMA_MODEL!.trim() : 'qwen2.5:7b',
    },
    groq: {
      apiKey: groqApiKey,
      baseUrl: (env.GROQ_BASE_URL ?? 'https://api.groq.com/openai/v1').trim(),
      model: !isPlaceholderValue(env.GROQ_MODEL)
        ? env.GROQ_MODEL!.trim()
        : 'llama-3.3-70b-versatile',
    },
    gemini: {
      apiKey: geminiApiKey,
      baseUrl: (
        env.GEMINI_BASE_URL ?? 'https://generativelanguage.googleapis.com/v1beta/openai'
      ).trim(),
      model: geminiDefaultModel,
      paidTier: geminiPaidTier,
    },
    openrouter: {
      apiKey: cleanEnvSecret(env.OPENROUTER_API_KEY) ?? '',
      baseUrl: (env.OPENROUTER_BASE_URL ?? 'https://openrouter.ai/api/v1').trim(),
      model: !isPlaceholderValue(env.OPENROUTER_MODEL)
        ? env.OPENROUTER_MODEL!.trim()
        : 'openrouter/free',
    },
    cerebras: {
      apiKey: cleanEnvSecret(env.CEREBRAS_API_KEY) ?? '',
      baseUrl: (env.CEREBRAS_BASE_URL ?? 'https://api.cerebras.ai/v1').trim(),
      model: !isPlaceholderValue(env.CEREBRAS_MODEL) ? env.CEREBRAS_MODEL!.trim() : 'llama-3.3-70b',
    },
    mistral: {
      apiKey: cleanEnvSecret(env.MISTRAL_API_KEY) ?? '',
      baseUrl: (env.MISTRAL_BASE_URL ?? 'https://api.mistral.ai/v1').trim(),
      model: !isPlaceholderValue(env.MISTRAL_MODEL)
        ? env.MISTRAL_MODEL!.trim()
        : 'mistral-small-latest',
    },
    github: {
      apiKey: cleanEnvSecret(env.GITHUB_MODELS_TOKEN) ?? '',
      baseUrl: (env.GITHUB_MODELS_BASE_URL ?? 'https://models.inference.ai.azure.com').trim(),
      model: !isPlaceholderValue(env.GITHUB_MODELS_MODEL)
        ? env.GITHUB_MODELS_MODEL!.trim()
        : 'gpt-4o-mini',
    },
  };

  return {
    appEnv,
    freeOnlyMode,
    ...(userName ? { userName } : {}),
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
    voiceModel,
    geminiVoiceModel,
    xaiVoiceModel,
    availableVoiceModels,
    geminiRealtimeUrl,
    geminiLiveModel,
    ...(backupKeyWarning ? { backupKeyWarning } : {}),
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
    aiProviders,
    toolsConfig: {
      openWeatherApiKey: cleanEnvSecret(env.OPENWEATHER_API_KEY) ?? '',
      webSearchApiKey: cleanEnvSecret(env.WEB_SEARCH_API_KEY) ?? '',
      webSearchBaseUrl: (env.WEB_SEARCH_BASE_URL ?? 'https://api.tavily.com/search').trim(),
    },
    rootDir,
  };
}
