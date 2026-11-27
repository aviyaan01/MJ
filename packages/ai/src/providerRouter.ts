import {
  AI_PROVIDER_CATALOG,
  AppError,
  ErrorCodes,
  type AiProviderId,
  type ConcreteAiProviderId,
  type ProviderInfoDTO,
} from '@mj/shared';
import {
  XaiResponsesClient,
  type CreateResponseParams,
  type CreateResponseResult,
} from './xaiClient.js';

export interface ProviderEndpointConfig {
  xai: { apiKey: string; baseUrl: string; model: string; models: string[] };
  ollama: { enabled: boolean; baseUrl: string; model: string };
  groq: { apiKey: string; baseUrl: string; model: string };
  gemini: { apiKey: string; baseUrl: string; model: string; paidTier?: boolean };
  openrouter: { apiKey: string; baseUrl: string; model: string };
  cerebras: { apiKey: string; baseUrl: string; model: string };
  mistral: { apiKey: string; baseUrl: string; model: string };
  github: { apiKey: string; baseUrl: string; model: string };
  timeoutMs: number;
  maxRetries?: number;
  cooldownMs?: number;
  nowMs?: () => number;
  fetchImpl?: typeof fetch;
  xaiClientOverride?: XaiResponsesClient;
}

export interface RoutedResponseResult extends CreateResponseResult {
  providerId: ConcreteAiProviderId;
  isFree: boolean;
}

export interface ProviderRoutingCandidatePreview {
  id: ConcreteAiProviderId;
  name: string;
  baseUrl: string;
  endpointUrl: string;
  isFree: boolean;
  isLocal: boolean;
  inCooldown: boolean;
}

export interface ProviderRoutingPreview {
  primary: ProviderRoutingCandidatePreview | null;
  candidates: ProviderRoutingCandidatePreview[];
  hasFreeCandidate: boolean;
  hasLocalCandidate: boolean;
}

interface InternalProviderEntry {
  id: ConcreteAiProviderId;
  name: string;
  baseUrl: string;
  apiFormat: 'xai-responses' | 'openai-chat';
  freeTier: boolean;
  requiresKey: boolean;
  defaultModel: string;
  models: string[];
  configured: boolean;
  costNote: string;
  client: XaiResponsesClient;
}

export function isLoopbackBaseUrl(baseUrl: string): boolean {
  try {
    const parsed = new URL(baseUrl);
    const host = parsed.hostname.toLowerCase();
    return host === '127.0.0.1' || host === 'localhost' || host === '::1' || host === '[::1]';
  } catch {
    return false;
  }
}

const DEFAULT_PROVIDER_COOLDOWN_MS = 5 * 60_000;

const AUTO_PROVIDER_PRIORITY: readonly ConcreteAiProviderId[] = [
  'gemini',
  'ollama',
  'groq',
  'openrouter',
  'cerebras',
  'mistral',
  'github',
  'xai',
];

const COOLDOWN_ERROR_CODES = new Set<string>([
  ErrorCodes.INVALID_API_KEY,
  ErrorCodes.UNAUTHORIZED,
  ErrorCodes.INSUFFICIENT_CREDITS,
]);

const FAILOVER_ELIGIBLE_CODES = new Set<string>([
  ErrorCodes.INSUFFICIENT_CREDITS,
  ErrorCodes.INVALID_API_KEY,
  ErrorCodes.UNAUTHORIZED,
  ErrorCodes.RATE_LIMITED,
  ErrorCodes.UPSTREAM_ERROR,
  ErrorCodes.NETWORK_DISCONNECTED,
  ErrorCodes.TIMEOUT,
]);

export class ProviderRouterClient {
  private readonly entries = new Map<ConcreteAiProviderId, InternalProviderEntry>();
  private readonly cooldownUntilMs = new Map<ConcreteAiProviderId, number>();
  private readonly cooldownErrors = new Map<ConcreteAiProviderId, AppError>();
  private readonly fetchImpl: typeof fetch;
  private readonly cooldownMs: number;
  private readonly nowMs: () => number;
  private lastOllamaProbeMs = 0;

  constructor(private readonly cfg: ProviderEndpointConfig) {
    this.fetchImpl = cfg.fetchImpl ?? fetch;
    this.cooldownMs = Math.max(0, cfg.cooldownMs ?? DEFAULT_PROVIDER_COOLDOWN_MS);
    this.nowMs = cfg.nowMs ?? (() => Date.now());
    const defMap = new Map(AI_PROVIDER_CATALOG.map((d) => [d.id, d]));

    const registerOpenAiProvider = (
      id: Exclude<ConcreteAiProviderId, 'xai'>,
      opts: {
        apiKey: string;
        baseUrl: string;
        defaultModel: string;
        configured: boolean;
        freeTierOverride?: boolean;
        allowEmptyApiKey?: boolean;
        extraHeaders?: Record<string, string>;
      },
    ) => {
      const def = defMap.get(id)!;
      const models = Array.from(new Set([opts.defaultModel, ...def.suggestedModels]));
      this.entries.set(id, {
        id,
        name: def.name,
        baseUrl: opts.baseUrl,
        apiFormat: 'openai-chat',
        freeTier: opts.freeTierOverride ?? def.freeTier,
        requiresKey: def.requiresKey,
        defaultModel: opts.defaultModel,
        models,
        configured: opts.configured,
        costNote: def.costNote,
        client: new XaiResponsesClient({
          apiKey: opts.apiKey,
          baseUrl: opts.baseUrl,
          defaultModel: opts.defaultModel,
          timeoutMs: cfg.timeoutMs,
          maxRetries: cfg.maxRetries ?? 2,
          apiFormat: 'openai-chat',
          providerId: id,
          allowEmptyApiKey: opts.allowEmptyApiKey,
          extraHeaders: opts.extraHeaders,
          fetchImpl: this.fetchImpl,
        }),
      });
    };

    const xaiDef = defMap.get('xai')!;
    this.entries.set('xai', {
      id: 'xai',
      name: xaiDef.name,
      baseUrl: cfg.xai.baseUrl,
      apiFormat: 'xai-responses',
      freeTier: false,
      requiresKey: true,
      defaultModel: cfg.xai.model,
      models: Array.from(new Set([cfg.xai.model, ...cfg.xai.models])),
      configured: cfg.xai.apiKey.trim().length > 0,
      costNote: xaiDef.costNote,
      client:
        cfg.xaiClientOverride ??
        new XaiResponsesClient({
          apiKey: cfg.xai.apiKey,
          baseUrl: cfg.xai.baseUrl,
          defaultModel: cfg.xai.model,
          timeoutMs: cfg.timeoutMs,
          maxRetries: cfg.maxRetries ?? 2,
          apiFormat: 'xai-responses',
          fetchImpl: this.fetchImpl,
        }),
    });

    registerOpenAiProvider('groq', {
      apiKey: cfg.groq.apiKey,
      baseUrl: cfg.groq.baseUrl,
      defaultModel: cfg.groq.model,
      configured: cfg.groq.apiKey.trim().length > 0,
    });

    registerOpenAiProvider('gemini', {
      apiKey: cfg.gemini.apiKey,
      baseUrl: cfg.gemini.baseUrl,
      defaultModel: cfg.gemini.model,
      configured: cfg.gemini.apiKey.trim().length > 0,
      freeTierOverride: !(cfg.gemini.paidTier ?? false),
    });

    registerOpenAiProvider('openrouter', {
      apiKey: cfg.openrouter.apiKey,
      baseUrl: cfg.openrouter.baseUrl,
      defaultModel: cfg.openrouter.model,
      configured: cfg.openrouter.apiKey.trim().length > 0,
      extraHeaders: { 'X-Title': 'MJ Assistant' },
    });

    registerOpenAiProvider('cerebras', {
      apiKey: cfg.cerebras.apiKey,
      baseUrl: cfg.cerebras.baseUrl,
      defaultModel: cfg.cerebras.model,
      configured: cfg.cerebras.apiKey.trim().length > 0,
    });

    registerOpenAiProvider('mistral', {
      apiKey: cfg.mistral.apiKey,
      baseUrl: cfg.mistral.baseUrl,
      defaultModel: cfg.mistral.model,
      configured: cfg.mistral.apiKey.trim().length > 0,
    });

    registerOpenAiProvider('github', {
      apiKey: cfg.github.apiKey,
      baseUrl: cfg.github.baseUrl,
      defaultModel: cfg.github.model,
      configured: cfg.github.apiKey.trim().length > 0,
    });

    registerOpenAiProvider('ollama', {
      apiKey: '',
      baseUrl: cfg.ollama.baseUrl,
      defaultModel: cfg.ollama.model,
      configured: cfg.ollama.enabled,
      allowEmptyApiKey: true,
    });
  }

  /**
   * Probes local Ollama `/api/tags` when enabled so actually installed free local models
   * appear automatically in MJ Settings and model selectors.
   */
  public async refreshLocalOllamaModels(force = false): Promise<void> {
    if (!this.cfg.ollama.enabled) return;
    const now = Date.now();
    if (!force && now - this.lastOllamaProbeMs < 15_000) return;
    this.lastOllamaProbeMs = now;

    const entry = this.entries.get('ollama');
    if (!entry) return;

    const rootUrl = this.cfg.ollama.baseUrl.replace(/\/v1\/?$/, '');
    try {
      const res = await this.fetchImpl(`${rootUrl}/api/tags`, {
        method: 'GET',
        signal: AbortSignal.timeout(900),
      });
      if (!res.ok) {
        entry.configured = false;
        return;
      }
      const json = (await res.json()) as { models?: Array<{ name?: string; model?: string }> };
      const names = Array.isArray(json.models)
        ? json.models.map((m) => String(m.name ?? m.model ?? '').trim()).filter(Boolean)
        : [];
      entry.configured = names.length > 0;
      if (names.length > 0) {
        entry.models = names;
        if (!names.includes(entry.defaultModel)) {
          entry.defaultModel = names[0]!;
        }
      }
    } catch {
      entry.configured = false;
    }
  }

  public hasAnyConfiguredProvider(): boolean {
    for (const entry of this.entries.values()) {
      if (entry.configured) return true;
    }
    return false;
  }

  public listProviderCatalog(): ProviderInfoDTO[] {
    return AUTO_PROVIDER_PRIORITY
      .map((id) => this.entries.get(id))
      .filter((e): e is InternalProviderEntry => Boolean(e))
      .map((e) => ({
        id: e.id,
        name: e.name,
        baseUrl: e.baseUrl,
        configured: e.configured,
        freeTier: e.freeTier,
        requiresKey: e.requiresKey,
        defaultModel: e.defaultModel,
        models: [...e.models],
        costNote: e.costNote,
      }));
  }

  public getProviderInfo(id: ConcreteAiProviderId): ProviderInfoDTO | undefined {
    return this.listProviderCatalog().find((p) => p.id === id);
  }

  public isInCooldown(id: ConcreteAiProviderId): boolean {
    const until = this.cooldownUntilMs.get(id);
    if (until === undefined) return false;
    if (this.nowMs() >= until) {
      this.cooldownUntilMs.delete(id);
      this.cooldownErrors.delete(id);
      return false;
    }
    return true;
  }

  public getCooldownRemainingMs(id: ConcreteAiProviderId): number {
    const until = this.cooldownUntilMs.get(id);
    if (until === undefined) return 0;
    const rem = until - this.nowMs();
    if (rem <= 0) {
      this.cooldownUntilMs.delete(id);
      this.cooldownErrors.delete(id);
      return 0;
    }
    return rem;
  }

  public clearCooldown(id?: ConcreteAiProviderId): void {
    if (id) {
      this.cooldownUntilMs.delete(id);
      this.cooldownErrors.delete(id);
      return;
    }
    this.cooldownUntilMs.clear();
    this.cooldownErrors.clear();
  }

  private shouldTriggerCooldown(err: AppError): boolean {
    return (
      err.statusCode === 401 ||
      err.statusCode === 403 ||
      COOLDOWN_ERROR_CODES.has(err.code)
    );
  }

  private recordCooldown(id: ConcreteAiProviderId, err: AppError): void {
    if (this.cooldownMs <= 0 || !this.shouldTriggerCooldown(err)) return;
    this.cooldownUntilMs.set(id, this.nowMs() + this.cooldownMs);
    this.cooldownErrors.set(id, err);
  }

  private getEndpointUrl(entry: InternalProviderEntry): string {
    const clean = entry.baseUrl.replace(/\/+$/, '');
    if (entry.apiFormat === 'xai-responses') {
      return clean.endsWith('/responses') ? clean : `${clean}/responses`;
    }
    return clean.endsWith('/chat/completions') ? clean : `${clean}/chat/completions`;
  }

  private isEntryFreeForModel(entry: InternalProviderEntry, requestedModel?: string): boolean {
    if (entry.id === 'xai') return false;
    if (entry.id === 'gemini') return entry.freeTier;
    if (entry.id === 'openrouter') {
      const m = (requestedModel?.trim() || entry.defaultModel).toLowerCase();
      return m === 'openrouter/free' || m.endsWith(':free');
    }
    return entry.freeTier;
  }

  public resolveRoutingPreview(
    requestedProvider: AiProviderId,
    requestedModel?: string,
  ): ProviderRoutingPreview {
    const ordered = this.buildCandidateOrder(requestedProvider, requestedModel, {
      excludeCooldown: false,
      allowUnconfiguredExplicit: true,
    });
    const toPreview = (entry: InternalProviderEntry): ProviderRoutingCandidatePreview => ({
      id: entry.id,
      name: entry.name,
      baseUrl: entry.baseUrl,
      endpointUrl: this.getEndpointUrl(entry),
      isFree: this.isEntryFreeForModel(entry, requestedModel),
      isLocal: isLoopbackBaseUrl(entry.baseUrl),
      inCooldown: this.isInCooldown(entry.id),
    });

    const previews = ordered.map(toPreview);
    return {
      primary: previews[0] ?? null,
      candidates: previews,
      hasFreeCandidate: previews.some((c) => {
        const entry = this.entries.get(c.id);
        return Boolean(entry?.configured && c.isFree);
      }),
      hasLocalCandidate: previews.some((c) => {
        const entry = this.entries.get(c.id);
        return Boolean(entry?.configured && c.isLocal);
      }),
    };
  }

  public inferProviderForModel(model: string): ConcreteAiProviderId | null {
    const trimmed = model.trim();
    if (!trimmed) return null;
    for (const entry of this.entries.values()) {
      if (entry.models.includes(trimmed)) {
        return entry.id;
      }
    }
    if (trimmed.startsWith('grok-')) return 'xai';
    if (trimmed.startsWith('gemini-')) return 'gemini';
    if (trimmed.includes(':free')) return 'openrouter';
    if (trimmed.includes(':')) return 'ollama';
    return null;
  }

  private buildCandidateOrder(
    requestedProvider: AiProviderId,
    requestedModel?: string,
    filters: {
      freeOnly?: boolean;
      localOnly?: boolean;
      excludeCooldown?: boolean;
      allowUnconfiguredExplicit?: boolean;
    } = {},
  ): InternalProviderEntry[] {
    const matchesFilters = (entry: InternalProviderEntry, checkConfigured: boolean): boolean => {
      if (checkConfigured && !entry.configured) return false;
      if (filters.localOnly && !isLoopbackBaseUrl(entry.baseUrl)) return false;
      if (filters.freeOnly && !this.isEntryFreeForModel(entry, requestedModel)) return false;
      if (filters.excludeCooldown && this.isInCooldown(entry.id)) return false;
      return true;
    };

    if (requestedProvider !== 'auto') {
      const explicit = this.entries.get(requestedProvider);
      if (!explicit) return [];
      const passes = matchesFilters(explicit, !(filters.allowUnconfiguredExplicit ?? false));
      return passes ? [explicit] : [];
    }

    const ordered: InternalProviderEntry[] = [];
    const pushIfEligible = (entry?: InternalProviderEntry) => {
      if (!entry) return;
      if (!matchesFilters(entry, true)) return;
      if (!ordered.some((o) => o.id === entry.id)) {
        ordered.push(entry);
      }
    };

    // Only promote inferred free/local model when caller explicitly picked a non-Gemini/non-xAI model;
    // never promote xAI ahead of Gemini or free/local providers because a model starts with `grok-*`.
    const inferred = requestedModel ? this.inferProviderForModel(requestedModel) : null;
    if (inferred && inferred !== 'xai' && inferred !== 'gemini') {
      pushIfEligible(this.entries.get(inferred));
    }

    for (const id of AUTO_PROVIDER_PRIORITY) {
      pushIfEligible(this.entries.get(id));
    }

    return ordered;
  }

  public async createResponse(
    params: CreateResponseParams & {
      provider?: AiProviderId;
      freeOnly?: boolean;
      localOnly?: boolean;
    },
  ): Promise<RoutedResponseResult> {
    await this.refreshLocalOllamaModels(false);

    const requestedProvider = params.provider ?? 'auto';
    const eligibleNoCooldown = this.buildCandidateOrder(requestedProvider, params.model, {
      freeOnly: params.freeOnly,
      localOnly: params.localOnly,
      excludeCooldown: false,
      allowUnconfiguredExplicit: requestedProvider !== 'auto',
    });

    if (eligibleNoCooldown.length === 0) {
      if (params.freeOnly) {
        throw new AppError({
          code: ErrorCodes.BUDGET_EXCEEDED,
          category: 'budget',
          statusCode: 429,
        });
      }
      if (params.localOnly) {
        throw new AppError({
          code: ErrorCodes.PERMISSION_DENIED,
          category: 'privacy',
          statusCode: 403,
          message: 'External AI requests are disabled in Privacy & Permissions.',
        });
      }
      throw new AppError({
        code: ErrorCodes.INVALID_API_KEY,
        category: 'api',
        statusCode: 502,
      });
    }

    const candidates = eligibleNoCooldown.filter((entry) => !this.isInCooldown(entry.id));
    if (candidates.length === 0) {
      const firstId = eligibleNoCooldown[0]!.id;
      throw (
        this.cooldownErrors.get(firstId) ??
        new AppError({
          code: ErrorCodes.INVALID_API_KEY,
          category: 'api',
          statusCode: 502,
        })
      );
    }

    let lastError: AppError | undefined;

    for (let i = 0; i < candidates.length; i++) {
      const candidate = candidates[i]!;
      const modelMatchesCandidate =
        params.model &&
        (candidate.models.includes(params.model) ||
          this.inferProviderForModel(params.model) === candidate.id);
      const effectiveModel =
        modelMatchesCandidate || requestedProvider !== 'auto'
          ? params.model?.trim() || candidate.defaultModel
          : candidate.defaultModel;

      try {
        const result = await candidate.client.createResponse({
          ...params,
          model: effectiveModel,
        });
        this.clearCooldown(candidate.id);
        return {
          ...result,
          providerId: candidate.id,
          isFree: this.isEntryFreeForModel(candidate, effectiveModel),
        };
      } catch (err) {
        const appErr =
          err instanceof AppError
            ? err
            : new AppError({
                code: ErrorCodes.UPSTREAM_ERROR,
                category: 'api',
                statusCode: 502,
                cause: err,
              });
        this.recordCooldown(candidate.id, appErr);
        lastError = appErr;

        const hasNext = i < candidates.length - 1;
        if (
          requestedProvider === 'auto' &&
          hasNext &&
          FAILOVER_ELIGIBLE_CODES.has(appErr.code) &&
          appErr.code !== ErrorCodes.ABORTED
        ) {
          continue;
        }
        throw appErr;
      }
    }

    throw (
      lastError ??
      new AppError({
        code: ErrorCodes.UPSTREAM_ERROR,
        category: 'api',
        statusCode: 502,
      })
    );
  }

  public async probeProvider(
    requestedProvider: AiProviderId,
    timeoutMs = 10000,
  ): Promise<{
    providerId: ConcreteAiProviderId;
    providerName: string;
    modelChecked: string;
    modelIds: string[];
    latencyMs: number;
  }> {
    await this.refreshLocalOllamaModels(true);
    const candidates = this.buildCandidateOrder(requestedProvider, undefined, {
      excludeCooldown: true,
      allowUnconfiguredExplicit: requestedProvider !== 'auto',
    });
    const list = candidates.length > 0 ? candidates : [this.entries.get('xai')!];
    let lastError: AppError | undefined;

    for (let i = 0; i < list.length; i++) {
      const candidate = list[i]!;
      try {
        const { modelIds, latencyMs } = await candidate.client.listAvailableModelIds(timeoutMs);
        this.clearCooldown(candidate.id);
        return {
          providerId: candidate.id,
          providerName: candidate.name,
          modelChecked: candidate.defaultModel,
          modelIds,
          latencyMs,
        };
      } catch (err) {
        const appErr =
          err instanceof AppError
            ? err
            : new AppError({
                code: ErrorCodes.UPSTREAM_ERROR,
                category: 'api',
                statusCode: 502,
                cause: err,
              });
        this.recordCooldown(candidate.id, appErr);
        lastError = appErr;
        if (
          requestedProvider === 'auto' &&
          i < list.length - 1 &&
          FAILOVER_ELIGIBLE_CODES.has(appErr.code)
        ) {
          continue;
        }
        throw appErr;
      }
    }

    throw (
      lastError ??
      new AppError({
        code: ErrorCodes.UPSTREAM_ERROR,
        category: 'api',
        statusCode: 502,
      })
    );
  }
}
