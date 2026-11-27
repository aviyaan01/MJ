import type { StructuredErrorPayload } from './errors.js';

export type MessageRole = 'user' | 'assistant';
export type MessageStatus = 'streaming' | 'completed' | 'aborted' | 'error';
export type MessageChannel = 'text' | 'voice';
export type ReasoningEffort = 'low' | 'medium' | 'high' | 'xhigh';
export type ResponseStyle = 'balanced' | 'concise' | 'detailed';
export type LanguageMode = 'auto' | 'en' | 'bn' | 'banglish';
export type EngineStatus = 'ready' | 'unconfigured' | 'degraded' | 'error';

export const VoiceStates = {
  IDLE: 'idle',
  REQUESTING_PERMISSION: 'requesting_permission',
  CONNECTING: 'connecting',
  LISTENING: 'listening',
  PROCESSING: 'processing',
  SPEAKING: 'speaking',
  INTERRUPTED: 'interrupted',
  RECONNECTING: 'reconnecting',
  ERROR: 'error',
} as const;

export type VoiceState = (typeof VoiceStates)[keyof typeof VoiceStates];

export type UsageKind = 'text' | 'voice_realtime' | 'tts' | 'stt';

export interface ConversationDTO {
  id: string;
  title: string;
  model: string;
  createdAt: string;
  updatedAt: string;
  messageCount: number;
  lastMessagePreview?: string;
}

export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  reasoningTokens: number;
  cachedTokens: number;
  totalTokens: number;
}

export interface MessageDTO {
  id: string;
  conversationId: string;
  role: MessageRole;
  content: string;
  channel: MessageChannel;
  status: MessageStatus;
  model?: string | null;
  xaiResponseId?: string | null;
  inputTokens?: number | null;
  outputTokens?: number | null;
  reasoningTokens?: number | null;
  cachedTokens?: number | null;
  latencyMs?: number | null;
  estimatedCostUsd?: number | null;
  errorCode?: string | null;
  createdAt: string;
}

export interface ConversationDetailDTO {
  conversation: ConversationDTO;
  messages: MessageDTO[];
}

export interface BudgetSettings {
  softCapUsd: number;
  hardCapUsd: number;
  inputRatePerMillionUsd: number;
  outputRatePerMillionUsd: number;
  cachedInputRatePerMillionUsd: number;
  voiceRatePerMinuteUsd: number;
  ttsRatePerMillionCharsUsd: number;
  sttRatePerHourUsd: number;
}

export interface VoiceSettings {
  voiceModel: string;
  availableVoiceModels: string[];
  voiceId: string;
  availableVoices: Array<{ id: string; label: string; description: string }>;
  speakingRate: number;
  volume: number;
  autoPlayback: boolean;
  voiceOutputEnabled: boolean;
  languageMode: LanguageMode;
}

export interface PublicSettingsDTO {
  assistantName: string;
  activeModel: string;
  availableModels: string[];
  reasoningEffort: ReasoningEffort;
  responseStyle: ResponseStyle;
  maxOutputTokens: number;
  timeoutMs: number;
  streamResponses: boolean;
  reducedMotionOverride: 'system' | 'reduce' | 'normal';
  compactDensity: boolean;
  apiBaseHost: string;
  apiKeyConfigured: boolean;
  appEnv: string;
  budget: BudgetSettings;
  voice: VoiceSettings;
}

export interface BudgetStatusSummary {
  level: 'ok' | 'soft_cap_warning' | 'hard_cap_reached';
  monthlySpendUsd: number;
  dailySpendUsd: number;
  softCapUsd: number;
  hardCapUsd: number;
}

export interface UsageSummaryDTO {
  today: {
    requestCount: number;
    errorCount: number;
    inputTokens: number;
    outputTokens: number;
    reasoningTokens: number;
    totalTokens: number;
    voiceSeconds: number;
    estimatedCostUsd: number;
    avgLatencyMs: number;
  };
  month: {
    requestCount: number;
    errorCount: number;
    inputTokens: number;
    outputTokens: number;
    reasoningTokens: number;
    totalTokens: number;
    voiceSeconds: number;
    estimatedCostUsd: number;
    avgLatencyMs: number;
  };
  budgetStatus: BudgetStatusSummary;
  recentEvents: Array<{
    id: string;
    kind: UsageKind;
    model: string;
    status: 'success' | 'error' | 'aborted';
    totalTokens: number;
    voiceSeconds: number;
    estimatedCostUsd: number;
    latencyMs: number;
    errorCode?: string | null;
    createdAt: string;
  }>;
}

export interface SystemHealthDTO {
  status: 'online' | 'degraded';
  stage: 'Stage 2 · Text & Realtime Voice';
  backend: 'online';
  database: 'healthy' | 'unavailable';
  aiEngine: EngineStatus;
  voiceEngine: EngineStatus;
  activeModel: string;
  activeVoiceModel: string;
  apiBaseHost: string;
  uptimeSeconds: number;
  appEnv: string;
  timestamp: string;
  features: {
    textChat: true;
    streaming: true;
    conversationHistory: true;
    voice: true;
    memory: false;
    tools: false;
    automation: false;
    desktop: false;
  };
}

export interface AuthSessionDTO {
  authenticated: boolean;
  passcodeRequired: boolean;
  mode: 'passcode' | 'local-dev';
  appEnv: string;
}

export interface VoiceClientSecretDTO {
  token: string;
  expiresAt: number;
  realtimeUrl: string;
  model: string;
  voice: string;
  languageMode: LanguageMode;
  instructions: string;
  contextTurns: Array<{ role: MessageRole; content: string }>;
}

export type ChatStreamEvent =
  | {
      type: 'meta';
      conversationId: string;
      userMessageId: string;
      assistantMessageId: string;
      model: string;
      conversationTitle?: string;
    }
  | {
      type: 'status';
      phase: 'connecting' | 'reasoning' | 'streaming';
      detail: string;
    }
  | {
      type: 'delta';
      text: string;
    }
  | {
      type: 'usage';
      usage: TokenUsage;
      estimatedCostUsd: number;
      latencyMs: number;
      budgetStatus: BudgetStatusSummary;
    }
  | {
      type: 'done';
      message: MessageDTO;
      conversation: ConversationDTO;
    }
  | {
      type: 'error';
      error: StructuredErrorPayload;
      partialMessage?: MessageDTO;
    };
