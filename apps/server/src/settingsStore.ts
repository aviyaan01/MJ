import {
  AppError,
  DEFAULT_AUTO_LISTEN,
  DEFAULT_BARGE_IN_PCM16_THRESHOLD,
  DEFAULT_BUDGET_SETTINGS,
  DEFAULT_FOLLOWUP_LISTEN_SECONDS,
  DEFAULT_GEMINI_FEMALE_VOICE_ID,
  DEFAULT_VOICE_PERSONA,
  ErrorCodes,
  MAX_BARGE_IN_PCM16_THRESHOLD,
  MAX_FOLLOWUP_LISTEN_SECONDS,
  MIN_BARGE_IN_PCM16_THRESHOLD,
  MIN_FOLLOWUP_LISTEN_SECONDS,
  resolveProviderDisplay,
  type AiProviderId,
  type BudgetSettings,
  type LanguageMode,
  type PublicSettingsDTO,
  type ReasoningEffort,
  type ResponseStyle,
  type VoicePersona,
} from '@mj/shared';
import type { ProviderRouterClient } from '@mj/ai';
import type { MjDatabaseRepository } from '@mj/database';
import type { ServerConfig } from './config.js';

const SETTINGS_STORAGE_KEY = 'mj.runtime_settings.v1';

const DEFAULT_AVAILABLE_VOICES = [
  {
    id: 'Aoede',
    label: 'Aoede (Female · Default)',
    description: 'Warm, cheerful & conversational female Gemini voice',
  },
  {
    id: 'Kore',
    label: 'Kore (Female)',
    description: 'Clear, firm & expressive female Gemini voice',
  },
  {
    id: 'Leda',
    label: 'Leda (Female)',
    description: 'Youthful, bright & friendly female Gemini voice',
  },
  {
    id: 'Zephyr',
    label: 'Zephyr (Female)',
    description: 'Smooth, lively & warm female Gemini voice',
  },
];

export interface PersistedSettingsPatch {
  userName?: string;
  activeProvider?: AiProviderId;
  activeModel?: string;
  reasoningEffort?: ReasoningEffort;
  responseStyle?: ResponseStyle;
  maxOutputTokens?: number;
  timeoutMs?: number;
  streamResponses?: boolean;
  reducedMotionOverride?: 'system' | 'reduce' | 'normal';
  compactDensity?: boolean;
  budget?: Partial<BudgetSettings>;
  voice?: {
    voiceModel?: string;
    voiceId?: string;
    speakingRate?: number;
    volume?: number;
    autoPlayback?: boolean;
    voiceOutputEnabled?: boolean;
    autoListen?: boolean;
    followupListenSeconds?: number;
    bargeInThreshold?: number;
    persona?: VoicePersona;
    languageMode?: LanguageMode;
  };
}

const STRICT_FREE_ONLY_SET = new Set<AiProviderId>(['auto', 'gemini', 'ollama', 'groq']);

function isAllowedInFreeOnly(providerId: AiProviderId, config: ServerConfig): boolean {
  if (!config.freeOnlyMode) return true;
  if (!STRICT_FREE_ONLY_SET.has(providerId)) return false;
  if (providerId === 'gemini' && config.aiProviders.gemini.paidTier) return false;
  return true;
}

export class RuntimeSettingsStore {
  private cachedSaved: PersistedSettingsPatch | null = null;

  constructor(
    private readonly repo: MjDatabaseRepository,
    private readonly config: ServerConfig,
    private readonly providerRouter?: ProviderRouterClient,
  ) {}

  private async loadSavedPatch(): Promise<PersistedSettingsPatch> {
    if (this.cachedSaved !== null) {
      return this.cachedSaved;
    }
    const saved =
      (await this.repo.getStoredSettings<PersistedSettingsPatch>(SETTINGS_STORAGE_KEY)) ?? {};
    this.cachedSaved = saved;
    return saved;
  }

  public async getPublicSettings(): Promise<PublicSettingsDTO> {
    await this.providerRouter?.refreshLocalOllamaModels(false);
    const saved = await this.loadSavedPatch();
    const rawProviders = this.providerRouter?.listProviderCatalog() ?? [];
    const providers = this.config.freeOnlyMode
      ? rawProviders.filter((p) => isAllowedInFreeOnly(p.id, this.config))
      : rawProviders;

    const savedProvider = saved.activeProvider ?? this.config.aiProviders.defaultProvider;
    const activeProvider = isAllowedInFreeOnly(savedProvider, this.config)
      ? savedProvider
      : this.config.aiProviders.defaultProvider;

    const configuredProviderModels = providers
      .filter((p) => p.configured)
      .flatMap((p) => p.models);

    const autoDefaultProvider =
      providers.find((p) => p.id === 'gemini' && p.configured) ??
      providers.find((p) => p.freeTier && p.configured) ??
      providers.find((p) => p.id === 'gemini') ??
      providers.find((p) => p.configured);

    const savedModel = saved.activeModel?.trim();
    const safeSavedModel =
      this.config.freeOnlyMode && savedModel?.toLowerCase().startsWith('grok-')
        ? undefined
        : savedModel;

    const activeModel =
      safeSavedModel ||
      (activeProvider !== 'auto'
        ? providers.find((p) => p.id === activeProvider)?.defaultModel
        : autoDefaultProvider?.defaultModel) ||
      this.config.aiProviders.gemini.model ||
      (this.config.freeOnlyMode ? 'gemini-2.5-flash' : this.config.xaiTextModel);

    const availableModels = Array.from(
      new Set([activeModel, ...configuredProviderModels, ...this.config.availableModels]),
    ).filter((m) => !this.config.freeOnlyMode || !m.toLowerCase().startsWith('grok-'));

    const savedVoiceModel = saved.voice?.voiceModel?.trim();
    const safeSavedVoice =
      this.config.freeOnlyMode && savedVoiceModel?.toLowerCase().startsWith('grok-')
        ? undefined
        : savedVoiceModel;
    const voiceModel = safeSavedVoice || this.config.voiceModel;
    const availableVoiceModels = Array.from(
      new Set([voiceModel, 'free-browser-voice', ...this.config.availableVoiceModels]),
    ).filter((m) => !this.config.freeOnlyMode || !m.toLowerCase().startsWith('grok-'));

    const anyProviderConfigured = this.providerRouter
      ? this.providerRouter.hasAnyConfiguredProvider()
      : this.config.freeOnlyMode
        ? Boolean(
            (this.config.aiProviders.gemini.apiKey && !this.config.aiProviders.gemini.paidTier) ||
              this.config.aiProviders.groq.apiKey ||
              this.config.aiProviders.ollama.enabled,
          )
        : this.config.apiKeyConfigured;

    const apiBaseHost = this.config.freeOnlyMode
      ? resolveProviderDisplay({
          activeProvider,
          activeModel,
          activeVoiceModel: voiceModel,
          providers,
        }).hostLabel
      : this.config.xaiBaseHost;

    const resolvedUserName =
      saved.userName !== undefined
        ? saved.userName.trim() || undefined
        : this.config.userName;
    const rawVoiceId = saved.voice?.voiceId?.trim();
    const voiceId =
      rawVoiceId === 'ara'
        ? 'Aoede'
        : rawVoiceId === 'eve'
          ? 'Kore'
          : rawVoiceId || DEFAULT_GEMINI_FEMALE_VOICE_ID;

    return {
      assistantName: 'MJ Assistant',
      ...(resolvedUserName ? { userName: resolvedUserName } : {}),
      freeOnlyMode: this.config.freeOnlyMode,
      activeProvider,
      ...(providers.length > 0 ? { providers } : {}),
      activeModel,
      availableModels,
      reasoningEffort: saved.reasoningEffort ?? this.config.xaiReasoningEffort,
      responseStyle: saved.responseStyle ?? 'balanced',
      maxOutputTokens: saved.maxOutputTokens ?? this.config.xaiMaxOutputTokens,
      timeoutMs: saved.timeoutMs ?? this.config.xaiTimeoutMs,
      streamResponses: saved.streamResponses ?? true,
      reducedMotionOverride: saved.reducedMotionOverride ?? 'system',
      compactDensity: saved.compactDensity ?? false,
      apiBaseHost,
      apiKeyConfigured: anyProviderConfigured,
      appEnv: this.config.appEnv,
      budget: {
        ...DEFAULT_BUDGET_SETTINGS,
        ...(saved.budget ?? {}),
      },
      voice: {
        voiceModel,
        availableVoiceModels,
        voiceId,
        availableVoices: DEFAULT_AVAILABLE_VOICES,
        speakingRate: saved.voice?.speakingRate ?? 1.0,
        volume: saved.voice?.volume ?? 0.9,
        autoPlayback: saved.voice?.autoPlayback ?? false,
        voiceOutputEnabled: saved.voice?.voiceOutputEnabled ?? true,
        autoListen: saved.voice?.autoListen ?? DEFAULT_AUTO_LISTEN,
        followupListenSeconds: Math.min(
          MAX_FOLLOWUP_LISTEN_SECONDS,
          Math.max(
            MIN_FOLLOWUP_LISTEN_SECONDS,
            Math.round(saved.voice?.followupListenSeconds ?? DEFAULT_FOLLOWUP_LISTEN_SECONDS),
          ),
        ),
        bargeInThreshold: Math.min(
          MAX_BARGE_IN_PCM16_THRESHOLD,
          Math.max(
            MIN_BARGE_IN_PCM16_THRESHOLD,
            Math.round(saved.voice?.bargeInThreshold ?? DEFAULT_BARGE_IN_PCM16_THRESHOLD),
          ),
        ),
        persona: saved.voice?.persona ?? DEFAULT_VOICE_PERSONA,
        languageMode: saved.voice?.languageMode ?? 'auto',
      },
    };
  }

  public async updateSettings(patch: PersistedSettingsPatch): Promise<PublicSettingsDTO> {
    if (this.config.freeOnlyMode) {
      if (patch.activeProvider !== undefined && !isAllowedInFreeOnly(patch.activeProvider, this.config)) {
        throw new AppError({
          code: ErrorCodes.PERMISSION_DENIED,
          category: 'privacy',
          statusCode: 403,
          message: 'Paid providers (xAI, OpenRouter, or paid tiers) are disabled while FREE_ONLY_MODE=true.',
        });
      }
      if (patch.activeModel?.trim().toLowerCase().startsWith('grok-')) {
        throw new AppError({
          code: ErrorCodes.PERMISSION_DENIED,
          category: 'privacy',
          statusCode: 403,
          message: 'Paid xAI models are disabled while FREE_ONLY_MODE=true.',
        });
      }
      if (patch.voice?.voiceModel?.trim().toLowerCase().startsWith('grok-')) {
        throw new AppError({
          code: ErrorCodes.PERMISSION_DENIED,
          category: 'privacy',
          statusCode: 403,
          message: 'Paid xAI voice models are disabled while FREE_ONLY_MODE=true.',
        });
      }
    }

    const existing = await this.loadSavedPatch();

    const merged: PersistedSettingsPatch = {
      ...existing,
      ...patch,
      ...(patch.budget || existing.budget
        ? {
            budget: {
              ...(existing.budget ?? {}),
              ...(patch.budget ?? {}),
            },
          }
        : {}),
      ...(patch.voice || existing.voice
        ? {
            voice: {
              ...(existing.voice ?? {}),
              ...(patch.voice ?? {}),
            },
          }
        : {}),
    };

    await this.repo.saveStoredSettings(SETTINGS_STORAGE_KEY, merged);
    this.cachedSaved = merged;
    return this.getPublicSettings();
  }
}
