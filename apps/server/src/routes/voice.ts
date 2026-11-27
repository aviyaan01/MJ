import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import {
  AppError,
  ErrorCodes,
  LanguageModeSchema,
  RecordVoiceUsageSchema,
  TtsRequestSchema,
  VoiceClientSecretRequestSchema,
  estimateSttCostUsd,
  estimateTtsCostUsd,
  estimateVoiceDurationCostUsd,
  sanitizeDiagnosticText,
  validateInput,
  type VoiceClientSecretDTO,
} from '@mj/shared';
import {
  GEMINI_TTS_DEFAULT_MODEL,
  buildMjVoiceInstructions,
  createGeminiLiveEphemeralToken,
  createRealtimeClientSecret,
  fetchAvailableVoices,
  synthesizeSpeech,
  synthesizeSpeechWithGemini,
  transcribeSpeech,
  transcribeSpeechWithGemini,
  transcribeSpeechWithGroqFree,
  type EphemeralSecretResult,
  type SttTranscriptionResult,
  type TtsSynthesisResult,
} from '@mj/ai';
import type { MjDatabaseRepository } from '@mj/database';
import type { AlertMonitor } from '../alerting.js';
import type { ServerConfig } from '../config.js';
import type { PermissionsStore } from '../permissionsStore.js';
import type { RuntimeSettingsStore } from '../settingsStore.js';

export interface VoiceGateway {
  createClientSecret: (
    expiresAfterSeconds?: number,
    requestedModel?: string,
  ) => Promise<EphemeralSecretResult>;
  synthesizeSpeech: (params: {
    text: string;
    voiceId?: string;
    languageMode?: 'auto' | 'en' | 'bn' | 'banglish';
  }) => Promise<TtsSynthesisResult>;
  listVoices: () => Promise<Array<{ id: string; label: string; description: string }>>;
  transcribeSpeech: (params: {
    audioBytes: Uint8Array;
    filename: string;
    mimeType: string;
    languageMode?: 'auto' | 'en' | 'bn' | 'banglish';
  }) => Promise<SttTranscriptionResult>;
}

export function isFreeVoiceModel(model: string, config: ServerConfig): boolean {
  const normalized = model.trim().toLowerCase();
  if (!normalized) return false;
  if (normalized === 'free-browser-voice') return true;
  if (normalized.includes('whisper') || normalized.startsWith('groq-')) return true;
  if (normalized.startsWith('gemini-')) return !config.aiProviders.gemini.paidTier;
  return false;
}

const ALLOWED_STT_MIME_TYPES = new Set([
  'audio/webm',
  'audio/webm;codecs=opus',
  'audio/ogg',
  'audio/ogg;codecs=opus',
  'audio/mp4',
  'audio/mpeg',
  'audio/wav',
  'audio/x-wav',
  'audio/flac',
  'audio/aac',
]);

const SttBodySchema = z.object({
  audioBase64: z.string().min(4).max(12_000_000),
  filename: z.string().max(120).optional(),
  // Restrict to known browser audio MIME types to prevent MIME-confusion attacks.
  mimeType: z
    .string()
    .max(80)
    .optional()
    .refine(
      (v) => v === undefined || ALLOWED_STT_MIME_TYPES.has(v.toLowerCase().split(';')[0]!.trim()),
      { message: 'mimeType must be a supported audio type (e.g. audio/webm, audio/ogg, audio/mp4).' },
    ),
  languageMode: LanguageModeSchema.optional(),
  durationSeconds: z.number().min(0).max(86400).optional(),
});

export function createDefaultVoiceGateway(
  config: ServerConfig,
  fetchImpl?: typeof fetch,
): VoiceGateway {
  const xaiApiConfig = {
    apiKey: config.xaiApiKey,
    baseUrl: config.xaiBaseUrl,
    ...(fetchImpl ? { fetchImpl } : {}),
  };

  const geminiKey = config.aiProviders.gemini.apiKey;
  const geminiVoiceConfig = {
    apiKey: geminiKey,
    baseUrl: config.aiProviders.gemini.baseUrl,
    paidTier: config.aiProviders.gemini.paidTier,
    ...(fetchImpl ? { fetchImpl } : {}),
  };

  const groqKey = config.aiProviders.groq.apiKey;
  const preferXaiOnly = config.aiProviders.defaultProvider === 'xai';

  const makeFreeBrowserFallback = (): EphemeralSecretResult => ({
    token: 'free-browser-voice',
    expiresAt: Math.floor(Date.now() / 1000) + 3600,
    protocol: 'free-browser',
    realtimeUrl: 'browser://free-speech',
    model: 'free-browser-voice',
  });

  return {
    createClientSecret: async (expiresAfterSeconds = 300, requestedModel?: string) => {
      const explicitGrokVoice = Boolean(requestedModel?.trim().toLowerCase().startsWith('grok-'));
      if (preferXaiOnly || (explicitGrokVoice && config.apiKeyConfigured)) {
        const secret = await createRealtimeClientSecret(xaiApiConfig, expiresAfterSeconds);
        return {
          ...secret,
          protocol: 'xai-realtime',
          realtimeUrl: config.xaiRealtimeUrl,
          model: requestedModel || config.xaiVoiceModel,
        };
      }

      if (geminiKey) {
        try {
          const liveModel =
            requestedModel && requestedModel.startsWith('gemini-')
              ? requestedModel
              : config.geminiLiveModel;
          const secret = await createGeminiLiveEphemeralToken(
            { ...geminiVoiceConfig, model: liveModel },
            Math.max(expiresAfterSeconds, 300),
          );
          return {
            ...secret,
            protocol: 'gemini-live',
            realtimeUrl: config.geminiRealtimeUrl,
            model: liveModel,
          };
        } catch {
          return makeFreeBrowserFallback();
        }
      }

      return makeFreeBrowserFallback();
    },

    synthesizeSpeech: async (params) => {
      if (!preferXaiOnly && geminiKey) {
        try {
          return await synthesizeSpeechWithGemini(
            { ...geminiVoiceConfig, model: GEMINI_TTS_DEFAULT_MODEL },
            params,
          );
        } catch (err) {
          if (!config.apiKeyConfigured) throw err;
        }
      }

      if (config.apiKeyConfigured) {
        try {
          const res = await synthesizeSpeech(xaiApiConfig, params);
          return { ...res, modelUsed: 'xai-tts', isFree: false };
        } catch (err) {
          if (geminiKey) {
            return synthesizeSpeechWithGemini(
              { ...geminiVoiceConfig, model: GEMINI_TTS_DEFAULT_MODEL },
              params,
            );
          }
          throw err;
        }
      }

      throw new AppError({
        code: ErrorCodes.INVALID_API_KEY,
        category: 'api',
        statusCode: 502,
      });
    },

    listVoices: async () => {
      if (!preferXaiOnly && !config.apiKeyConfigured) {
        return [
          { id: 'ara', label: 'Ara (Aoede)', description: 'Warm conversational Gemini Live voice' },
          { id: 'sal', label: 'Sal (Charon)', description: 'Balanced informative Gemini Live voice' },
          { id: 'rex', label: 'Rex (Fenrir)', description: 'Crisp analytical Gemini Live voice' },
          { id: 'eve', label: 'Eve (Kore)', description: 'Clear firm Gemini Live voice' },
          { id: 'leo', label: 'Leo (Puck)', description: 'Upbeat natural Gemini Live voice' },
        ];
      }
      return fetchAvailableVoices(xaiApiConfig);
    },

    transcribeSpeech: async (params) => {
      if (!preferXaiOnly && geminiKey) {
        try {
          return await transcribeSpeechWithGemini(
            { ...geminiVoiceConfig, model: config.aiProviders.gemini.model },
            params,
          );
        } catch (err) {
          if (groqKey) {
            return transcribeSpeechWithGroqFree(
              {
                apiKey: groqKey,
                baseUrl: config.aiProviders.groq.baseUrl,
                ...(fetchImpl ? { fetchImpl } : {}),
              },
              params,
            );
          }
          if (!config.apiKeyConfigured) throw err;
        }
      }

      if (!config.apiKeyConfigured && groqKey) {
        return transcribeSpeechWithGroqFree(
          {
            apiKey: groqKey,
            baseUrl: config.aiProviders.groq.baseUrl,
            ...(fetchImpl ? { fetchImpl } : {}),
          },
          params,
        );
      }

      try {
        const res = await transcribeSpeech(xaiApiConfig, params);
        return { ...res, modelUsed: 'grok-voice-transcribe-2.0', isFree: false };
      } catch (err) {
        if (
          groqKey &&
          err instanceof AppError &&
          (err.code === ErrorCodes.INSUFFICIENT_CREDITS ||
            err.code === ErrorCodes.INVALID_API_KEY ||
            err.code === ErrorCodes.UNAUTHORIZED)
        ) {
          return transcribeSpeechWithGroqFree(
            {
              apiKey: groqKey,
              baseUrl: config.aiProviders.groq.baseUrl,
              ...(fetchImpl ? { fetchImpl } : {}),
            },
            params,
          );
        }
        throw err;
      }
    },
  };
}

export function registerVoiceRoutes(
  app: FastifyInstance,
  deps: {
    config: ServerConfig;
    repo: MjDatabaseRepository;
    settingsStore: RuntimeSettingsStore;
    permissionsStore: PermissionsStore;
    voiceGateway: VoiceGateway;
    alertMonitor?: AlertMonitor;
    requireSession: (request: FastifyRequest) => Promise<void>;
  },
): void {
  let cachedVoices: {
    keyPresent: boolean;
    fetchedAtMs: number;
    voices: Array<{ id: string; label: string; description: string }>;
  } | null = null;
  const VOICES_CACHE_TTL_MS = 5 * 60 * 1000;

  async function runTrackedVoiceOp<T>(
    request: FastifyRequest,
    meta: {
      kind: 'voice_realtime' | 'tts' | 'stt';
      model: string;
      conversationId?: string;
    },
    fn: () => Promise<T>,
  ): Promise<{ value: T; latencyMs: number }> {
    const startedAt = Date.now();
    try {
      const value = await fn();
      void deps.alertMonitor?.recordApiOutcome({ ok: true });
      return { value, latencyMs: Date.now() - startedAt };
    } catch (err) {
      const code = err instanceof AppError ? err.code : ErrorCodes.VOICE_SERVICE_UNAVAILABLE;
      const upstreamError =
        err instanceof AppError
          ? err.upstreamDiagnostic ?? sanitizeDiagnosticText(err.message)
          : sanitizeDiagnosticText(err instanceof Error ? err.message : String(err));

      request.log.error(
        {
          reqId: request.id,
          kind: meta.kind,
          code,
          statusCode: err instanceof AppError ? err.statusCode : 503,
          upstreamError,
        },
        'xAI voice API error',
      );

      await deps.repo.recordUsageLog({
        conversationId: meta.conversationId,
        kind: meta.kind,
        model: meta.model,
        status: 'error',
        latencyMs: Date.now() - startedAt,
        errorCode: code,
      });
      if (!(err instanceof AppError) || err.statusCode >= 500 || err.statusCode === 429) {
        void deps.alertMonitor?.recordApiOutcome({ ok: false, code });
      }
      throw err;
    }
  }

  /**
   * Generates a short-lived xAI Realtime ephemeral client secret server-side.
   * Never exposes the permanent XAI_API_KEY to the browser.
   */
  app.post(
    '/api/voice/client-secret',
    {
      preHandler: deps.requireSession,
      config: {
        rateLimit: {
          max: 20,
          timeWindow: '1 minute',
        },
      },
    },
    async (request) => {
      const body = validateInput(VoiceClientSecretRequestSchema, request.body ?? {});

      const permissions = await deps.permissionsStore.getPermissions();
      if (!permissions.microphoneAccess || !permissions.voiceSessionAccess || !permissions.externalWebServices) {
        const disabledKey = !permissions.microphoneAccess
          ? 'microphoneAccess'
          : !permissions.voiceSessionAccess
            ? 'voiceSessionAccess'
            : 'externalWebServices';
        await deps.repo.recordAuditLog({
          capability: disabledKey,
          action: 'Blocked realtime voice ephemeral token issuance',
          target: 'wss://api.x.ai/v1/realtime',
          outcome: 'denied',
          source: 'server',
          detail: `Blocked because "${disabledKey}" is disabled in Privacy & Permissions.`,
        });
        throw new AppError({
          code: ErrorCodes.PERMISSION_DENIED,
          category: 'privacy',
          statusCode: 403,
          requestId: request.id,
          message: `Voice session blocked because "${disabledKey}" is disabled in Privacy & Permissions.`,
        });
      }

      const settings = await deps.settingsStore.getPublicSettings();
      const targetVoiceModel = settings.voice.voiceModel;
      const usageSummary = await deps.repo.getUsageSummary(settings.budget);
      if (
        usageSummary.budgetStatus.level === 'hard_cap_reached' &&
        !isFreeVoiceModel(targetVoiceModel, deps.config)
      ) {
        throw new AppError({
          code: ErrorCodes.BUDGET_EXCEEDED,
          category: 'budget',
          statusCode: 429,
          requestId: request.id,
        });
      }

      let contextTurns: VoiceClientSecretDTO['contextTurns'] = [];
      if (body.conversationId) {
        contextTurns = await deps.repo.getContextTurns(body.conversationId, 8);
      }

      const languageMode = body.languageMode ?? settings.voice.languageMode;
      const voice = body.voice ?? settings.voice.voiceId;

      const { value: ephemeralSecret } = await runTrackedVoiceOp(
        request,
        {
          kind: 'voice_realtime',
          model: targetVoiceModel,
          conversationId: body.conversationId,
        },
        () => deps.voiceGateway.createClientSecret(300, targetVoiceModel),
      );

      const instructions = buildMjVoiceInstructions({
        assistantName: settings.assistantName,
        responseStyle: settings.responseStyle,
        languageMode,
        contextTurns,
      });

      const resolvedModel = ephemeralSecret.model ?? targetVoiceModel;
      const resolvedRealtimeUrl =
        ephemeralSecret.realtimeUrl ??
        (ephemeralSecret.protocol === 'gemini-live' ||
        (deps.config.aiProviders.gemini.apiKey && !resolvedModel.startsWith('grok-'))
          ? deps.config.geminiRealtimeUrl
          : deps.config.xaiRealtimeUrl);

      const dto: VoiceClientSecretDTO = {
        token: ephemeralSecret.token,
        expiresAt: ephemeralSecret.expiresAt,
        realtimeUrl: resolvedRealtimeUrl,
        ...(ephemeralSecret.protocol ? { protocol: ephemeralSecret.protocol } : {}),
        model: resolvedModel,
        voice,
        languageMode,
        instructions,
        contextTurns,
      };

      return dto;
    },
  );

  app.get('/api/voice/voices', { preHandler: deps.requireSession }, async () => {
    const now = Date.now();
    if (
      cachedVoices &&
      cachedVoices.keyPresent === deps.config.apiKeyConfigured &&
      now - cachedVoices.fetchedAtMs < VOICES_CACHE_TTL_MS
    ) {
      return { voices: cachedVoices.voices };
    }
    const voices = await deps.voiceGateway.listVoices();
    cachedVoices = {
      keyPresent: deps.config.apiKeyConfigured,
      fetchedAtMs: now,
      voices,
    };
    return { voices };
  });

  app.post('/api/voice/tts', { preHandler: deps.requireSession }, async (request, reply) => {
    const body = validateInput(TtsRequestSchema, request.body ?? {});
    const permissions = await deps.permissionsStore.getPermissions();
    if (!permissions.voiceSessionAccess || !permissions.externalWebServices) {
      throw new AppError({
        code: ErrorCodes.PERMISSION_DENIED,
        category: 'privacy',
        statusCode: 403,
        requestId: request.id,
        message: 'Speech synthesis is disabled in Privacy & Permissions.',
      });
    }

    if (!deps.config.apiKeyConfigured && !deps.config.aiProviders.gemini.apiKey) {
      throw new AppError({
        code: ErrorCodes.INVALID_API_KEY,
        category: 'api',
        statusCode: 502,
        requestId: request.id,
      });
    }

    const settings = await deps.settingsStore.getPublicSettings();
    const isFreeGeminiTtsAvailable =
      Boolean(deps.config.aiProviders.gemini.apiKey) &&
      !deps.config.aiProviders.gemini.paidTier &&
      deps.config.aiProviders.defaultProvider !== 'xai';
    const usageSummary = await deps.repo.getUsageSummary(settings.budget);
    if (usageSummary.budgetStatus.level === 'hard_cap_reached' && !isFreeGeminiTtsAvailable) {
      throw new AppError({
        code: ErrorCodes.BUDGET_EXCEEDED,
        category: 'budget',
        statusCode: 429,
        requestId: request.id,
      });
    }

    const expectedTtsModel = isFreeGeminiTtsAvailable ? GEMINI_TTS_DEFAULT_MODEL : 'xai-tts';
    const { value: ttsAudio, latencyMs } = await runTrackedVoiceOp(
      request,
      { kind: 'tts', model: expectedTtsModel },
      () =>
        deps.voiceGateway.synthesizeSpeech({
          text: body.text,
          voiceId: body.voiceId ?? settings.voice.voiceId,
          languageMode: body.languageMode ?? settings.voice.languageMode,
        }),
    );

    const actualTtsModel = ttsAudio.modelUsed ?? expectedTtsModel;
    const isFreeTts = ttsAudio.isFree ?? isFreeVoiceModel(actualTtsModel, deps.config);
    const costUsd = isFreeTts
      ? 0
      : estimateTtsCostUsd(body.text.length, settings.budget.ttsRatePerMillionCharsUsd);

    await deps.repo.recordUsageLog({
      kind: 'tts',
      model: actualTtsModel,
      status: 'success',
      estimatedCostUsd: costUsd,
      latencyMs,
    });

    if (deps.alertMonitor) {
      const updatedUsage = await deps.repo.getUsageSummary(settings.budget);
      void deps.alertMonitor.notifyDailyBudgetCrossed(updatedUsage.budgetStatus);
    }

    return reply
      .header('Content-Type', ttsAudio.contentType)
      .header('Cache-Control', 'no-store')
      .send(Buffer.from(ttsAudio.audioBuffer));
  });

  app.post(
    '/api/voice/stt',
    { preHandler: deps.requireSession, bodyLimit: 12 * 1024 * 1024 },
    async (request) => {
      const body = validateInput(SttBodySchema, request.body ?? {});
      const permissions = await deps.permissionsStore.getPermissions();
      if (!permissions.microphoneAccess || !permissions.voiceSessionAccess || !permissions.externalWebServices) {
        throw new AppError({
          code: ErrorCodes.PERMISSION_DENIED,
          category: 'privacy',
          statusCode: 403,
          requestId: request.id,
          message: 'Speech transcription is disabled in Privacy & Permissions.',
        });
      }

      if (
        !deps.config.apiKeyConfigured &&
        !deps.config.aiProviders.groq.apiKey &&
        !deps.config.aiProviders.gemini.apiKey
      ) {
        throw new AppError({
          code: ErrorCodes.INVALID_API_KEY,
          category: 'api',
          statusCode: 502,
          requestId: request.id,
        });
      }

      const settings = await deps.settingsStore.getPublicSettings();
      const audioBytes = new Uint8Array(Buffer.from(body.audioBase64, 'base64'));
      const defaultSttModel =
        deps.config.aiProviders.defaultProvider !== 'xai' && deps.config.aiProviders.gemini.apiKey
          ? deps.config.aiProviders.gemini.model
          : deps.config.aiProviders.groq.apiKey && !deps.config.apiKeyConfigured
            ? 'whisper-large-v3-turbo'
            : 'grok-voice-transcribe-2.0';

      const { value: sttResult, latencyMs } = await runTrackedVoiceOp(
        request,
        { kind: 'stt', model: defaultSttModel },
        () =>
          deps.voiceGateway.transcribeSpeech({
            audioBytes,
            filename: body.filename ?? 'audio.webm',
            mimeType: body.mimeType ?? 'audio/webm',
            languageMode: body.languageMode ?? settings.voice.languageMode,
          }),
      );

      const durationSec = body.durationSeconds ?? 0;
      const actualSttModel = sttResult.modelUsed ?? defaultSttModel;
      const isFreeStt =
        sttResult.isFree ??
        (sttResult.modelUsed !== undefined ? isFreeVoiceModel(sttResult.modelUsed, deps.config) : false);
      const sttCost = isFreeStt
        ? 0
        : estimateSttCostUsd(durationSec, settings.budget.sttRatePerHourUsd);

      await deps.repo.recordUsageLog({
        kind: 'stt',
        model: actualSttModel,
        status: 'success',
        voiceSeconds: durationSec,
        estimatedCostUsd: sttCost,
        latencyMs,
      });

      if (deps.alertMonitor) {
        const updatedUsage = await deps.repo.getUsageSummary(settings.budget);
        void deps.alertMonitor.notifyDailyBudgetCrossed(updatedUsage.budgetStatus);
      }

      return sttResult;
    },
  );

  app.post('/api/voice/usage', { preHandler: deps.requireSession }, async (request) => {
    const body = validateInput(RecordVoiceUsageSchema, request.body ?? {});
    const settings = await deps.settingsStore.getPublicSettings();
    const isFree = isFreeVoiceModel(body.model, deps.config);
    const estimatedCostUsd = isFree
      ? 0
      : estimateVoiceDurationCostUsd(
          body.durationSeconds,
          settings.budget.voiceRatePerMinuteUsd,
        );

    await deps.repo.recordUsageLog({
      conversationId: body.conversationId,
      kind: 'voice_realtime',
      model: body.model,
      status: body.status,
      voiceSeconds: body.durationSeconds,
      estimatedCostUsd,
      latencyMs: 0,
      errorCode: body.errorCode,
    });

    if (deps.alertMonitor) {
      const updatedUsage = await deps.repo.getUsageSummary(settings.budget);
      void deps.alertMonitor.notifyDailyBudgetCrossed(updatedUsage.budgetStatus);
    }

    return { recorded: true, estimatedCostUsd };
  });
}
