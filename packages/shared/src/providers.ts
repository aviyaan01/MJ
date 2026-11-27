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
    suggestedModels: ['gemini-2.5-flash', 'gemini-2.5-pro'],
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
