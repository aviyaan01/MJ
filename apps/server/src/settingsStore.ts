import {
  DEFAULT_BUDGET_SETTINGS,
  type AiProviderId,
  type BudgetSettings,
  type LanguageMode,
  type PublicSettingsDTO,
  type ReasoningEffort,
  type ResponseStyle,
} from '@mj/shared';
import type { ProviderRouterClient } from '@mj/ai';
import type { MjDatabaseRepository } from '@mj/database';
import type { ServerConfig } from './config.js';

const SETTINGS_STORAGE_KEY = 'mj.runtime_settings.v1';

const DEFAULT_AVAILABLE_VOICES = [
  { id: 'ara', label: 'Ara', description: 'Warm and conversational' },
  { id: 'sal', label: 'Sal', description: 'Smooth and balanced' },
  { id: 'rex', label: 'Rex', description: 'Clear and professional' },
  { id: 'eve', label: 'Eve', description: 'Energetic and upbeat' },
  { id: 'leo', label: 'Leo', description: 'Calm and authoritative' },
];

export interface PersistedSettingsPatch {
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
    languageMode?: LanguageMode;
  };
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
    const providers = this.providerRouter?.listProviderCatalog() ?? [];
    const activeProvider = saved.activeProvider ?? this.config.aiProviders.defaultProvider;

    const configuredProviderModels = providers
      .filter((p) => p.configured)
      .flatMap((p) => p.models);

    const activeModel =
      saved.activeModel?.trim() ||
      (activeProvider !== 'auto'
        ? providers.find((p) => p.id === activeProvider)?.defaultModel
        : undefined) ||
      this.config.xaiTextModel;

    const availableModels = Array.from(
      new Set([activeModel, ...configuredProviderModels, ...this.config.availableModels]),
    );

    const voiceModel = saved.voice?.voiceModel?.trim() || this.config.xaiVoiceModel;
    const availableVoiceModels = Array.from(
      new Set([voiceModel, 'free-browser-voice', ...this.config.availableVoiceModels]),
    );

    const anyProviderConfigured = this.providerRouter
      ? this.providerRouter.hasAnyConfiguredProvider()
      : this.config.apiKeyConfigured;

    return {
      assistantName: 'MJ Assistant',
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
      apiBaseHost: this.config.xaiBaseHost,
      apiKeyConfigured: anyProviderConfigured,
      appEnv: this.config.appEnv,
      budget: {
        ...DEFAULT_BUDGET_SETTINGS,
        ...(saved.budget ?? {}),
      },
      voice: {
        voiceModel,
        availableVoiceModels,
        voiceId: saved.voice?.voiceId ?? 'ara',
        availableVoices: DEFAULT_AVAILABLE_VOICES,
        speakingRate: saved.voice?.speakingRate ?? 1.0,
        volume: saved.voice?.volume ?? 0.9,
        autoPlayback: saved.voice?.autoPlayback ?? false,
        voiceOutputEnabled: saved.voice?.voiceOutputEnabled ?? true,
        languageMode: saved.voice?.languageMode ?? 'auto',
      },
    };
  }

  public async updateSettings(patch: PersistedSettingsPatch): Promise<PublicSettingsDTO> {
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
