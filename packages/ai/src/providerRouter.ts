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
  gemini: { apiKey: string; baseUrl: string; model: string };
  openrouter: { apiKey: string; baseUrl: string; model: string };
  cerebras: { apiKey: string; baseUrl: string; model: string };
  mistral: { apiKey: string; baseUrl: string; model: string };
  github: { apiKey: string; baseUrl: string; model: string };
  timeoutMs: number;
  maxRetries?: number;
  fetchImpl?: typeof fetch;
  xaiClientOverride?: XaiResponsesClient;
}

export interface RoutedResponseResult extends CreateResponseResult {
  providerId: ConcreteAiProviderId;
  isFree: boolean;
}

interface InternalProviderEntry {
  id: ConcreteAiProviderId;
  name: string;
  baseUrl: string;
  freeTier: boolean;
  requiresKey: boolean;
  defaultModel: string;
  models: string[];
  configured: boolean;
  costNote: string;
  client: XaiResponsesClient;
}

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
  private readonly fetchImpl: typeof fetch;
  private lastOllamaProbeMs = 0;

  constructor(private readonly cfg: ProviderEndpointConfig) {
    this.fetchImpl = cfg.fetchImpl ?? fetch;
    const defMap = new Map(AI_PROVIDER_CATALOG.map((d) => [d.id, d]));

    const registerOpenAiProvider = (
      id: Exclude<ConcreteAiProviderId, 'xai'>,
      opts: {
        apiKey: string;
        baseUrl: string;
        defaultModel: string;
        configured: boolean;
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
        freeTier: def.freeTier,
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
    const order: ConcreteAiProviderId[] = [
      'ollama',
      'groq',
      'gemini',
      'openrouter',
      'cerebras',
      'mistral',
      'github',
      'xai',
    ];
    return order
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
  ): InternalProviderEntry[] {
    if (requestedProvider !== 'auto') {
      const explicit = this.entries.get(requestedProvider);
      return explicit ? [explicit] : [];
    }

    const freePriority: ConcreteAiProviderId[] = [
      'groq',
      'gemini',
      'openrouter',
      'cerebras',
      'mistral',
      'github',
      'ollama',
    ];
    const configuredFree = freePriority
      .map((id) => this.entries.get(id)!)
      .filter((e) => e.configured);

    const xai = this.entries.get('xai');
    const inferred = requestedModel ? this.inferProviderForModel(requestedModel) : null;

    const ordered: InternalProviderEntry[] = [];
    const pushUnique = (entry?: InternalProviderEntry) => {
      if (entry && entry.configured && !ordered.some((o) => o.id === entry.id)) {
        ordered.push(entry);
      }
    };

    if (inferred) {
      pushUnique(this.entries.get(inferred));
    }
    if (xai?.configured && inferred === 'xai') {
      pushUnique(xai);
    }
    for (const freeEntry of configuredFree) {
      pushUnique(freeEntry);
    }
    if (xai?.configured) {
      pushUnique(xai);
    }

    // If nothing at all is configured, keep xai as sentinel so INVALID_API_KEY surfaces cleanly
    return ordered.length > 0 ? ordered : xai ? [xai] : [];
  }

  public async createResponse(
    params: CreateResponseParams & { provider?: AiProviderId },
  ): Promise<RoutedResponseResult> {
    await this.refreshLocalOllamaModels(false);

    const requestedProvider = params.provider ?? 'auto';
    const candidates = this.buildCandidateOrder(requestedProvider, params.model);
    if (candidates.length === 0) {
      throw new AppError({
        code: ErrorCodes.INVALID_API_KEY,
        category: 'api',
        statusCode: 502,
      });
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
        return {
          ...result,
          providerId: candidate.id,
          isFree: candidate.freeTier,
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
    const candidates = this.buildCandidateOrder(requestedProvider);
    const primary = candidates[0] ?? this.entries.get('xai')!;
    const { modelIds, latencyMs } = await primary.client.listAvailableModelIds(timeoutMs);
    return {
      providerId: primary.id,
      providerName: primary.name,
      modelChecked: primary.defaultModel,
      modelIds,
      latencyMs,
    };
  }
}
