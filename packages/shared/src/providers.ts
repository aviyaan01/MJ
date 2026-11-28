export type ConcreteAiProviderId =
  | 'xai'
  | 'ollama'
  | 'groq'
  | 'gemini'
  | 'openrouter'
  | 'cerebras'
  | 'mistral'
  | 'github';

export type AiProviderId = 'auto' | ConcreteAiProviderId;

export interface ProviderInfoDTO {
  id: ConcreteAiProviderId;
  name: string;
  baseUrl: string;
  configured: boolean;
  freeTier: boolean;
  requiresKey: boolean;
  defaultModel: string;
  models: string[];
  costNote: string;
}

export interface ProviderCatalogDefinition {
  id: ConcreteAiProviderId;
  name: string;
  defaultBaseUrl: string;
  apiFormat: 'xai-responses' | 'openai-chat';
  freeTier: boolean;
  requiresKey: boolean;
  defaultModel: string;
  suggestedModels: string[];
  costNote: string;
}

export const AI_PROVIDER_CATALOG: readonly ProviderCatalogDefinition[] = [
  {
    id: 'ollama',
    name: 'Ollama (Local Free)',
    defaultBaseUrl: 'http://127.0.0.1:11434/v1',
    apiFormat: 'openai-chat',
    freeTier: true,
    requiresKey: false,
    defaultModel: 'qwen2.5:7b',
    suggestedModels: ['qwen2.5:7b', 'llama3.2:latest', 'mj-os-agent:latest'],
    costNote: '$0.00 forever · runs 100% locally with no API key',
  },
  {
    id: 'groq',
    name: 'Groq (Free Tier)',
    defaultBaseUrl: 'https://api.groq.com/openai/v1',
    apiFormat: 'openai-chat',
    freeTier: true,
    requiresKey: true,
    defaultModel: 'llama-3.3-70b-versatile',
    suggestedModels: ['llama-3.3-70b-versatile', 'llama-3.1-8b-instant'],
    costNote: '$0.00 developer free tier (RPM/RPD limits) + free Whisper STT',
  },
  {
    id: 'gemini',
    name: 'Google Gemini (Free Tier)',
    defaultBaseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai',
    apiFormat: 'openai-chat',
    freeTier: true,
    requiresKey: true,
    defaultModel: 'gemini-2.5-flash',
    suggestedModels: ['gemini-2.5-flash', 'gemini-2.5-flash-lite', 'gemini-2.5-pro'],
    costNote: '$0.00 Google AI Studio free tier (rate-limited)',
  },
  {
    id: 'openrouter',
    name: 'OpenRouter (:free)',
    defaultBaseUrl: 'https://openrouter.ai/api/v1',
    apiFormat: 'openai-chat',
    freeTier: true,
    requiresKey: true,
    defaultModel: 'openrouter/free',
    suggestedModels: [
      'openrouter/free',
      'meta-llama/llama-3.3-70b-instruct:free',
      'google/gemma-3-27b-it:free',
    ],
    costNote: '$0.00 on :free router and :free community models',
  },
  {
    id: 'cerebras',
    name: 'Cerebras (Free Tier)',
    defaultBaseUrl: 'https://api.cerebras.ai/v1',
    apiFormat: 'openai-chat',
    freeTier: true,
    requiresKey: true,
    defaultModel: 'llama-3.3-70b',
    suggestedModels: ['llama-3.3-70b', 'qwen-3-32b', 'gpt-oss-120b'],
    costNote: '$0.00 fast developer free tier (rate-limited)',
  },
  {
    id: 'mistral',
    name: 'Mistral AI (Free/Experiment)',
    defaultBaseUrl: 'https://api.mistral.ai/v1',
    apiFormat: 'openai-chat',
    freeTier: true,
    requiresKey: true,
    defaultModel: 'mistral-small-latest',
    suggestedModels: ['mistral-small-latest', 'open-mistral-nemo'],
    costNote: 'Free Experiment tier where eligible on console.mistral.ai',
  },
  {
    id: 'github',
    name: 'GitHub Models (Free)',
    defaultBaseUrl: 'https://models.inference.ai.azure.com',
    apiFormat: 'openai-chat',
    freeTier: true,
    requiresKey: true,
    defaultModel: 'gpt-4o-mini',
    suggestedModels: ['gpt-4o-mini', 'Llama-3.3-70B-Instruct'],
    costNote: '$0.00 rate-limited inference using GitHub PAT',
  },
  {
    id: 'xai',
    name: 'xAI Grok',
    defaultBaseUrl: 'https://api.x.ai/v1',
    apiFormat: 'xai-responses',
    freeTier: false,
    requiresKey: true,
    defaultModel: 'grok-4.7',
    suggestedModels: ['grok-4.7', 'grok-4.6', 'grok-4.5', 'grok-4-1-fast', 'grok-3'],
    costNote: 'Paid prepaid billing at console.x.ai ($150/mo Data Sharing after $5)',
  },
];

export interface ProviderDisplayMeta {
  providerId: ConcreteAiProviderId;
  isAuto: boolean;
  shortLabel: string;
  readyBanner: string;
  textChannelTitle: string;
  textEngineLabel: string;
  voiceLiveLabel: string;
  voiceEndpoint: string;
  hostLabel: string;
  verifyButtonLabel: string;
  checkingButtonLabel: string;
  verifiedPillLabel: string;
  missingKeyHint: string;
  sidebarTextLabel: string;
  docsHint: string;
}

const AUTO_DISPLAY_ORDER: readonly ConcreteAiProviderId[] = [
  'gemini',
  'ollama',
  'groq',
  'openrouter',
  'cerebras',
  'mistral',
  'github',
  'xai',
];

function inferProviderFromHost(host?: string | null): ConcreteAiProviderId | null {
  if (!host) return null;
  const h = host.toLowerCase();
  if (h.includes('generativelanguage.googleapis.com')) return 'gemini';
  if (h.includes('127.0.0.1') || h.includes('localhost')) return 'ollama';
  if (h.includes('groq.com')) return 'groq';
  if (h.includes('openrouter.ai')) return 'openrouter';
  if (h.includes('cerebras.ai')) return 'cerebras';
  if (h.includes('mistral.ai')) return 'mistral';
  if (h.includes('azure.com') || h.includes('github')) return 'github';
  if (h.includes('x.ai')) return 'xai';
  return null;
}

function inferProviderFromModel(model?: string | null): ConcreteAiProviderId | null {
  if (!model) return null;
  const m = model.toLowerCase();
  if (m.startsWith('gemini-')) return 'gemini';
  if (m.startsWith('grok-')) return 'xai';
  if (m.includes(':free') || m.startsWith('openrouter/')) return 'openrouter';
  if (m.startsWith('mistral') || m.startsWith('open-mistral')) return 'mistral';
  return null;
}

export function resolveProviderDisplay(input: {
  activeProvider?: AiProviderId | null;
  activeModel?: string | null;
  activeVoiceModel?: string | null;
  apiBaseHost?: string | null;
  providers?: ProviderInfoDTO[] | null;
}): ProviderDisplayMeta {
  const isAuto = input.activeProvider === 'auto';
  let resolved: ConcreteAiProviderId | null =
    input.activeProvider && input.activeProvider !== 'auto' ? input.activeProvider : null;

  if (!resolved && isAuto && input.providers && input.providers.length > 0) {
    resolved =
      AUTO_DISPLAY_ORDER.find((id) => input.providers?.find((p) => p.id === id)?.configured) ??
      null;
  }

  if (!resolved && input.activeProvider === undefined) {
    resolved = inferProviderFromModel(input.activeModel) ?? inferProviderFromHost(input.apiBaseHost);
  }

  if (!resolved) {
    resolved =
      inferProviderFromHost(input.apiBaseHost) ?? inferProviderFromModel(input.activeModel) ?? 'gemini';
  }

  const catalog = AI_PROVIDER_CATALOG.find((c) => c.id === resolved);
  const hostFromCatalog =
    catalog?.defaultBaseUrl.replace(/^https?:\/\//, '').split('/')[0] ??
    'generativelanguage.googleapis.com';
  const hostLabel = input.apiBaseHost || hostFromCatalog;
  const isFreeBrowserVoice = input.activeVoiceModel === 'free-browser-voice';

  const shortLabels: Record<ConcreteAiProviderId, string> = {
    gemini: 'Google Gemini',
    ollama: 'Ollama (Local)',
    groq: 'Groq',
    openrouter: 'OpenRouter',
    cerebras: 'Cerebras',
    mistral: 'Mistral AI',
    github: 'GitHub Models',
    xai: 'xAI Grok',
  };

  const shortLabel = shortLabels[resolved];
  const readyBanner =
    resolved === 'gemini'
      ? 'Gemini Voice & Text Ready'
      : resolved === 'ollama'
        ? 'Ollama (Local) Ready'
        : resolved === 'xai'
          ? 'Grok Voice & Text Ready'
          : `${shortLabel} Ready`;

  const textChannelTitle =
    resolved === 'xai'
      ? 'Grok Responses Text'
      : resolved === 'gemini'
        ? 'Gemini Responses Text'
        : `${shortLabel} Text`;

  const textEngineLabel =
    resolved === 'xai' ? 'Grok Responses streaming' : `${shortLabel} streaming`;

  const voiceLiveLabel = isFreeBrowserVoice
    ? 'Free Browser Voice'
    : resolved === 'xai'
      ? 'Grok Realtime Voice'
      : 'Google Gemini Live';

  const voiceEndpoint = isFreeBrowserVoice
    ? 'Web Speech API / Groq Whisper'
    : resolved === 'xai'
      ? 'wss://api.x.ai/v1/realtime'
      : 'wss://generativelanguage.googleapis.com (Gemini Live)';

  const missingKeyHints: Record<ConcreteAiProviderId, string> = {
    gemini: 'Set GEMINI_API_KEY (free from aistudio.google.com) in .env, or start local Ollama.',
    ollama: 'Ensure local Ollama is running at http://127.0.0.1:11434 or configure GEMINI_API_KEY.',
    groq: 'Set GROQ_API_KEY (free developer tier at console.groq.com) in .env.',
    openrouter: 'Set OPENROUTER_API_KEY in .env to use :free models.',
    cerebras: 'Set CEREBRAS_API_KEY in .env.',
    mistral: 'Set MISTRAL_API_KEY in .env.',
    github: 'Set GITHUB_MODELS_TOKEN in .env.',
    xai: 'Set XAI_API_KEY in .env or switch to Gemini / Ollama.',
  };

  const docsHints: Record<ConcreteAiProviderId, string> = {
    gemini: 'ai.google.dev',
    ollama: 'ollama.com',
    groq: 'console.groq.com',
    openrouter: 'openrouter.ai',
    cerebras: 'cloud.cerebras.ai',
    mistral: 'docs.mistral.ai',
    github: 'github.com/marketplace/models',
    xai: 'docs.x.ai',
  };

  return {
    providerId: resolved,
    isAuto,
    shortLabel,
    readyBanner,
    textChannelTitle,
    textEngineLabel,
    voiceLiveLabel,
    voiceEndpoint,
    hostLabel,
    verifyButtonLabel: `Verify Live ${shortLabel} Model`,
    checkingButtonLabel: `Checking ${shortLabel} API…`,
    verifiedPillLabel: `Live ${shortLabel} Verified`,
    missingKeyHint: missingKeyHints[resolved],
    sidebarTextLabel: resolved === 'xai' ? 'Grok Text Chat' : `${shortLabel} Chat`,
    docsHint: docsHints[resolved],
  };
}
