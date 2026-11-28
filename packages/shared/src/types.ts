import type { StructuredErrorPayload } from './errors.js';
import type { AiProviderId, ProviderInfoDTO } from './providers.js';

export type MessageRole = 'user' | 'assistant';
export type MessageStatus = 'streaming' | 'completed' | 'aborted' | 'error';
export type MessageChannel = 'text' | 'voice';
export type ReasoningEffort = 'low' | 'medium' | 'high' | 'xhigh';
export type ResponseStyle = 'balanced' | 'concise' | 'detailed';
export type LanguageMode = 'auto' | 'en' | 'bn' | 'banglish' | 'hi' | 'hinglish';
export type VoicePersona = 'friendly' | 'professional';
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
  dailyCapUsd?: number;
  softCapUsd: number;
  hardCapUsd: number;
  inputRatePerMillionUsd: number;
  outputRatePerMillionUsd: number;
  cachedInputRatePerMillionUsd: number;
  voiceRatePerMinuteUsd: number;
  ttsRatePerMillionCharsUsd: number;
  sttRatePerHourUsd: number;
}

export const DEFAULT_AUTO_LISTEN = true;
export const DEFAULT_FOLLOWUP_LISTEN_SECONDS = 7;
export const MIN_FOLLOWUP_LISTEN_SECONDS = 3;
export const MAX_FOLLOWUP_LISTEN_SECONDS = 30;
export const DEFAULT_BARGE_IN_PCM16_THRESHOLD = 1400;
export const MIN_BARGE_IN_PCM16_THRESHOLD = 200;
export const MAX_BARGE_IN_PCM16_THRESHOLD = 10000;
export const DEFAULT_VOICE_PERSONA: VoicePersona = 'friendly';
export const DEFAULT_GEMINI_FEMALE_VOICE_ID = 'Aoede';

export interface VoiceSettings {
  voiceModel: string;
  availableVoiceModels: string[];
  voiceId: string;
  availableVoices: Array<{ id: string; label: string; description: string }>;
  speakingRate: number;
  volume: number;
  autoPlayback: boolean;
  voiceOutputEnabled: boolean;
  autoListen: boolean;
  followupListenSeconds: number;
  bargeInThreshold: number;
  persona: VoicePersona;
  languageMode: LanguageMode;
}

export interface PublicSettingsDTO {
  assistantName: string;
  userName?: string;
  freeOnlyMode?: boolean;
  activeProvider?: AiProviderId;
  providers?: ProviderInfoDTO[];
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
  dailyLevel?: 'ok' | 'daily_cap_exceeded';
  monthlySpendUsd: number;
  dailySpendUsd: number;
  dailyCapUsd?: number;
  softCapUsd: number;
  hardCapUsd: number;
  percentOfDailyCap?: number | null;
  remainingDailyCapUsd?: number | null;
  percentOfSoftCap: number | null;
  percentOfHardCap: number | null;
  remainingSoftCapUsd: number | null;
  remainingHardCapUsd: number | null;
}

export type AlertEventReason =
  | 'crash'
  | 'high_error_rate'
  | 'daily_budget_exceeded'
  | 'uptime_down';

export interface AlertingStatusDTO {
  emailConfigured: boolean;
  telegramConfigured: boolean;
  errorRateThresholdPct: number;
  minSampleRequests: number;
  windowMinutes: number;
  currentWindowRequests: number;
  currentWindowErrors: number;
  currentErrorRatePct: number;
  cooldownMinutes: number;
  lastAlertAt: string | null;
  lastAlertReason: AlertEventReason | null;
  lastDeliveryStatus: 'idle' | 'sent' | 'partial_failure' | 'failed';
  alertsSentCount: number;
}

export interface ChannelUsageBreakdown {
  requests: number;
  errors: number;
  estimatedCostUsd: number;
  avgLatencyMs: number;
  totalTokens: number;
  voiceSeconds: number;
}

export interface UsagePeriodSummary {
  requestCount: number;
  errorCount: number;
  inputTokens: number;
  outputTokens: number;
  reasoningTokens: number;
  cachedTokens: number;
  totalTokens: number;
  voiceSeconds: number;
  estimatedCostUsd: number;
  avgLatencyMs: number;
  byKind: Record<UsageKind, ChannelUsageBreakdown>;
}

export interface UsageSummaryDTO {
  today: UsagePeriodSummary;
  month: UsagePeriodSummary;
  budgetStatus: BudgetStatusSummary;
  alerting?: AlertingStatusDTO;
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

export interface ConnectivityCheckDTO {
  checkedAt: string;
  apiKeyConfigured: boolean;
  xaiReachable: boolean;
  modelChecked: string;
  modelAvailable: boolean | null;
  availableModelCount: number | null;
  voiceModelChecked: string;
  availableVoiceCount: number | null;
  latencyMs: number | null;
  error: StructuredErrorPayload | null;
  note: string;
}

export const MJ_ACTIVE_STAGE = 'Stages 1, 2, 4 & 5 Complete' as const;

export const ALLOWLISTED_DESKTOP_SHORTCUTS = [
  'Ctrl+C',
  'Ctrl+V',
  'Ctrl+X',
  'Ctrl+Z',
  'Ctrl+Y',
  'Ctrl+A',
  'Ctrl+S',
  'Ctrl+W',
  'Ctrl+Tab',
  'Alt+Tab',
  'Alt+Left',
  'Alt+Right',
  'Win+M',
  'Win+D',
  'MediaPlayPause',
  'MediaNextTrack',
  'MediaPreviousTrack',
] as const;

export type AllowlistedDesktopShortcut = (typeof ALLOWLISTED_DESKTOP_SHORTCUTS)[number];

export type DesktopWindowActionKind = 'minimize_all' | 'maximize' | 'switch' | 'close_tab';

export type DesktopPowerActionKind = 'shutdown' | 'restart' | 'sleep' | 'logoff';

export type DesktopClientAction =
  | { kind: 'open_approved_url'; target: string }
  | { kind: 'open_approved_app'; target: string }
  | { kind: 'close_approved_app'; target: string }
  | { kind: 'volume_set'; level: number }
  | { kind: 'volume_mute'; muted?: boolean }
  | { kind: 'brightness_set'; level: number }
  | { kind: 'lock_screen' }
  | { kind: 'sleep_display' }
  | { kind: 'window_action'; action: DesktopWindowActionKind }
  | { kind: 'type_text'; text: string }
  | { kind: 'press_shortcut'; shortcut: AllowlistedDesktopShortcut }
  | { kind: 'power_action'; action: DesktopPowerActionKind };

export type ToolRiskLevel = 'safe' | 'confirm' | 'blocked';

export type ToolExecutionStatus =
  | 'executed'
  | 'denied'
  | 'cancelled'
  | 'timed_out'
  | 'confirmation_required'
  | 'error';

export interface ToolCatalogItemDTO {
  name: string;
  description: string;
  risk: ToolRiskLevel;
  requiredPermission: string;
  parametersSchema: Record<string, unknown>;
}

export interface PendingToolConfirmationDTO {
  confirmationId: string;
  toolName: string;
  args: Record<string, unknown>;
  summary: string;
  requiredPermission: string;
  conversationId?: string;
  channel: 'chat' | 'voice';
  callId?: string;
  createdAt: string;
  expiresAt: string;
  timeoutSeconds: number;
}

export interface SystemHealthDTO {
  status: 'online' | 'degraded';
  stage: typeof MJ_ACTIVE_STAGE;
  backend: 'online';
  database: 'healthy' | 'unavailable';
  aiEngine: EngineStatus;
  voiceEngine: EngineStatus;
  freeOnlyMode?: boolean;
  activeProvider?: AiProviderId;
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
    tools: boolean;
    automation: false;
    desktop: true;
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
  protocol?: 'gemini-live' | 'xai-realtime' | 'free-browser';
  fallbackReason?: string;
  toolsEnabled?: boolean;
  toolDeclarations?: Array<Record<string, unknown>>;
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
      type: 'tool_status';
      toolName: string;
      status: 'calling' | ToolExecutionStatus;
      detail: string;
      confirmation?: PendingToolConfirmationDTO;
      clientAction?: DesktopClientAction;
    }
  | {
      type: 'stream_reset';
      conversationId: string;
      assistantMessageId: string;
      model: string;
      reason?: string;
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
      replacedMessageId?: string;
    }
  | {
      type: 'error';
      error: StructuredErrorPayload;
      partialMessage?: MessageDTO;
      preservedMessageId?: string;
    };
