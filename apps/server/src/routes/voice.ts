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
  validateInput,
  type VoiceClientSecretDTO,
} from '@mj/shared';
import {
  buildMjVoiceInstructions,
  createRealtimeClientSecret,
  fetchAvailableVoices,
  synthesizeSpeech,
  transcribeSpeech,
  type EphemeralSecretResult,
  type SttTranscriptionResult,
  type TtsSynthesisResult,
} from '@mj/ai';
import type { MjDatabaseRepository } from '@mj/database';
import type { ServerConfig } from '../config.js';
import type { PermissionsStore } from '../permissionsStore.js';
import type { RuntimeSettingsStore } from '../settingsStore.js';

export interface VoiceGateway {
  createClientSecret: (expiresAfterSeconds?: number) => Promise<EphemeralSecretResult>;
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

const SttBodySchema = z.object({
  audioBase64: z.string().min(4).max(12_000_000),
  filename: z.string().max(120).optional(),
  mimeType: z.string().max(80).optional(),
  languageMode: LanguageModeSchema.optional(),
  durationSeconds: z.number().min(0).max(86400).optional(),
});

export function createDefaultVoiceGateway(config: ServerConfig): VoiceGateway {
  const apiConfig = {
    apiKey: config.xaiApiKey,
    baseUrl: config.xaiBaseUrl,
  };

  return {
    createClientSecret: (expiresAfterSeconds = 300) =>
      createRealtimeClientSecret(apiConfig, expiresAfterSeconds),
    synthesizeSpeech: (params) => synthesizeSpeech(apiConfig, params),
    listVoices: () => fetchAvailableVoices(apiConfig),
    transcribeSpeech: (params) => transcribeSpeech(apiConfig, params),
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
    requireSession: (request: FastifyRequest) => Promise<void>;
  },
): void {
  let cachedVoices: {
    keyPresent: boolean;
    fetchedAtMs: number;
    voices: Array<{ id: string; label: string; description: string }>;
  } | null = null;
  const VOICES_CACHE_TTL_MS = 5 * 60 * 1000;

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

      if (!deps.config.apiKeyConfigured) {
        throw new AppError({
          code: ErrorCodes.INVALID_API_KEY,
          category: 'api',
          statusCode: 502,
          requestId: request.id,
        });
      }

      const settings = await deps.settingsStore.getPublicSettings();
      const usageSummary = await deps.repo.getUsageSummary(settings.budget);
      if (usageSummary.budgetStatus.level === 'hard_cap_reached') {
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
      const model = settings.voice.voiceModel;

      const startedAt = Date.now();
      let secret: EphemeralSecretResult;
      try {
        secret = await deps.voiceGateway.createClientSecret(300);
      } catch (err) {
        const code = err instanceof AppError ? err.code : ErrorCodes.VOICE_SERVICE_UNAVAILABLE;
        await deps.repo.recordUsageLog({
          conversationId: body.conversationId,
          kind: 'voice_realtime',
          model,
          status: 'error',
          latencyMs: Date.now() - startedAt,
          errorCode: code,
        });
        throw err;
      }

      const instructions = buildMjVoiceInstructions({
        assistantName: settings.assistantName,
        responseStyle: settings.responseStyle,
        languageMode,
        contextTurns,
      });

      const dto: VoiceClientSecretDTO = {
        token: secret.token,
        expiresAt: secret.expiresAt,
        realtimeUrl: deps.config.xaiRealtimeUrl,
        model,
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

    if (!deps.config.apiKeyConfigured) {
      throw new AppError({
        code: ErrorCodes.INVALID_API_KEY,
        category: 'api',
        statusCode: 502,
        requestId: request.id,
      });
    }

    const settings = await deps.settingsStore.getPublicSettings();
    const usageSummary = await deps.repo.getUsageSummary(settings.budget);
    if (usageSummary.budgetStatus.level === 'hard_cap_reached') {
      throw new AppError({
        code: ErrorCodes.BUDGET_EXCEEDED,
        category: 'budget',
        statusCode: 429,
        requestId: request.id,
      });
    }

    const startedAt = Date.now();
    let result: TtsSynthesisResult;
    try {
      result = await deps.voiceGateway.synthesizeSpeech({
        text: body.text,
        voiceId: body.voiceId ?? settings.voice.voiceId,
        languageMode: body.languageMode ?? settings.voice.languageMode,
      });
    } catch (err) {
      const code = err instanceof AppError ? err.code : ErrorCodes.VOICE_SERVICE_UNAVAILABLE;
      await deps.repo.recordUsageLog({
        kind: 'tts',
        model: 'xai-tts',
        status: 'error',
        latencyMs: Date.now() - startedAt,
        errorCode: code,
      });
      throw err;
    }

    const costUsd = estimateTtsCostUsd(
      body.text.length,
      settings.budget.ttsRatePerMillionCharsUsd,
    );

    await deps.repo.recordUsageLog({
      kind: 'tts',
      model: 'xai-tts',
      status: 'success',
      estimatedCostUsd: costUsd,
      latencyMs: Date.now() - startedAt,
    });

    return reply
      .header('Content-Type', result.contentType)
      .header('Cache-Control', 'no-store')
      .send(Buffer.from(result.audioBuffer));
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

    if (!deps.config.apiKeyConfigured) {
      throw new AppError({
        code: ErrorCodes.INVALID_API_KEY,
        category: 'api',
        statusCode: 502,
        requestId: request.id,
      });
    }

    const settings = await deps.settingsStore.getPublicSettings();
    const startedAt = Date.now();
    const audioBytes = new Uint8Array(Buffer.from(body.audioBase64, 'base64'));
    let result: SttTranscriptionResult;
    try {
      result = await deps.voiceGateway.transcribeSpeech({
        audioBytes,
        filename: body.filename ?? 'audio.webm',
        mimeType: body.mimeType ?? 'audio/webm',
        languageMode: body.languageMode ?? settings.voice.languageMode,
      });
    } catch (err) {
      const code = err instanceof AppError ? err.code : ErrorCodes.VOICE_SERVICE_UNAVAILABLE;
      await deps.repo.recordUsageLog({
        kind: 'stt',
        model: 'grok-voice-transcribe-2.0',
        status: 'error',
        latencyMs: Date.now() - startedAt,
        errorCode: code,
      });
      throw err;
    }

    const durationSec = body.durationSeconds ?? 0;
    const sttCost = estimateSttCostUsd(durationSec, settings.budget.sttRatePerHourUsd);

    await deps.repo.recordUsageLog({
      kind: 'stt',
      model: 'grok-voice-transcribe-2.0',
      status: 'success',
      voiceSeconds: durationSec,
      estimatedCostUsd: sttCost,
      latencyMs: Date.now() - startedAt,
    });

    return result;
  });

  app.post('/api/voice/usage', { preHandler: deps.requireSession }, async (request) => {
    const body = validateInput(RecordVoiceUsageSchema, request.body ?? {});
    const settings = await deps.settingsStore.getPublicSettings();
    const estimatedCostUsd = estimateVoiceDurationCostUsd(
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

    return { recorded: true, estimatedCostUsd };
  });
}
