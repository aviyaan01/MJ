import { memo, useEffect, useState, type FormEvent } from 'react';
import {
  Activity,
  AlertTriangle,
  ArrowRight,
  AudioLines,
  Code2,
  Cpu,
  Database,
  FileText,
  Globe,
  Hand,
  Laptop,
  Layers,
  MessageSquare,
  Mic,
  MicOff,
  RefreshCw,
  Send,
  ShieldCheck,
  Sparkles,
  Square,
  Volume2,
  Wifi,
} from 'lucide-react';
import { MJCoreOrb, Panel, StatusPill, type OrbState } from '@mj/ui';
import { VOICE_STATE_META } from '@mj/voice';
import {
  resolveProviderDisplay,
  type ConversationDTO,
  type LanguageMode,
  type MessageDTO,
  type PendingToolConfirmationDTO,
  type PublicSettingsDTO,
  type StructuredErrorPayload,
  type SystemHealthDTO,
  type UsageSummaryDTO,
  type VoiceState,
  type WebSearchSourceDTO,
} from '@mj/shared';
import { isTauriDesktop } from '../desktop/desktopBridge.js';
import { MarkdownMessage } from './MarkdownMessage.js';
import { ToolConfirmationBanner } from './ToolConfirmationBanner.js';
import { VoiceStateBar } from './VoiceStateBar.js';
import { WebSourcesBar } from './WebSourcesBar.js';

interface HomeDashboardProps {
  health: SystemHealthDTO | null;
  settings: PublicSettingsDTO | null;
  usage: UsageSummaryDTO | null;
  online: boolean;
  interactionMode: 'voice' | 'text';
  onChangeInteractionMode: (mode: 'voice' | 'text') => void;
  streamingState: 'idle' | 'connecting' | 'streaming' | 'error';
  streamStatusDetail: string;
  voiceState: VoiceState;
  voiceDetail: string;
  voiceMuted: boolean;
  voiceAudioLevel: number;
  liveUserTranscript: string;
  liveAssistantTranscript: string;
  hasLastResponseToSpeak: boolean;
  latestHomeExchange: {
    conversationId: string;
    userPrompt: string;
    assistantMessage: MessageDTO | null;
  } | null;
  activeError: StructuredErrorPayload | null;
  repeatErrorHint?: string | null;
  pendingConfirmation?: PendingToolConfirmationDTO | null;
  webSearchSources?: WebSearchSourceDTO[];
  confirmationBusy?: boolean;
  onConfirmToolAction?: () => void;
  onCancelToolAction?: () => void;
  conversations: ConversationDTO[];
  onStartVoice: () => void;
  onStopVoice: () => void;
  onToggleMute: () => void;
  onInterruptVoice: () => void;
  onRepeatLastResponse: () => void;
  onChangeLanguageMode: (mode: LanguageMode) => void;
  onQuickSend: (prompt: string) => void;
  onStopStream: () => void;
  onRetryLast: () => void;
  onOpenConversation: (conversationId: string) => void;
  onNavigateChat: () => void;
  onNavigateUsage: () => void;
  onNavigateSettings: () => void;
}

const QUICK_STARTERS = [
  {
    label: 'Ask Anything',
    hint: 'Direct analytical answer',
    icon: Sparkles,
    prompt: 'Give me a crisp overview of how you can help me today.',
  },
  {
    label: 'Code & Debug',
    hint: 'Architecture & TS help',
    icon: Code2,
    prompt: 'Help me design a clean TypeScript service with structured error handling.',
  },
  {
    label: 'Summarize',
    hint: 'Distill pasted text',
    icon: FileText,
    prompt: 'I have a technical note I want summarized into 5 concise key points. Ask me to paste it.',
  },
  {
    label: 'Project Plan',
    hint: 'Banglish / Multilingual',
    icon: Layers,
    prompt: 'Amar ekta new web project idea ache. Let’s break down an actionable MVP plan step by step.',
  },
];

const LANGUAGE_OPTIONS: Array<{ id: LanguageMode; label: string }> = [
  { id: 'auto', label: 'AUTO' },
  { id: 'en', label: 'English' },
  { id: 'bn', label: 'বাংলা' },
  { id: 'hi', label: 'हिन्दी' },
  { id: 'banglish', label: 'Banglish' },
  { id: 'hinglish', label: 'Hinglish' },
];

export function HomeDashboard({
  health,
  settings,
  usage,
  conversations,
  online,
  interactionMode,
  onChangeInteractionMode,
  streamingState,
  streamStatusDetail,
  voiceState,
  voiceDetail,
  voiceMuted,
  voiceAudioLevel,
  liveUserTranscript,
  liveAssistantTranscript,
  hasLastResponseToSpeak,
  latestHomeExchange,
  activeError,
  repeatErrorHint,
  pendingConfirmation,
  webSearchSources = [],
  onConfirmToolAction,
  onCancelToolAction,
  onStartVoice,
  onStopVoice,
  onToggleMute,
  onInterruptVoice,
  onRepeatLastResponse,
  onChangeLanguageMode,
  onQuickSend,
  onStopStream,
  onRetryLast,
  onOpenConversation,
  onNavigateChat,
  onNavigateUsage,
  onNavigateSettings,
}: HomeDashboardProps) {
  const [quickInput, setQuickInput] = useState('');

  const voiceActive =
    voiceState === 'requesting_permission' ||
    voiceState === 'connecting' ||
    voiceState === 'listening' ||
    voiceState === 'processing' ||
    voiceState === 'speaking' ||
    voiceState === 'interrupted' ||
    voiceState === 'reconnecting';

  const orbState: OrbState =
    voiceState !== 'idle'
      ? voiceState
      : activeError
        ? 'error'
        : streamingState === 'connecting'
          ? 'connecting'
          : streamingState === 'streaming'
            ? 'streaming'
            : 'idle';

  const orbStatusLabel =
    voiceState !== 'idle'
      ? VOICE_STATE_META[voiceState].label
      : activeError
        ? 'Attention needed'
        : streamingState === 'idle'
          ? health?.aiEngine === 'ready'
            ? 'Standing by'
            : 'Setup required'
          : streamStatusDetail;

  const isTextBusy = streamingState === 'connecting' || streamingState === 'streaming';
  const apiKeyReady = settings?.apiKeyConfigured ?? health?.aiEngine === 'ready';
  const budgetLevel = usage?.budgetStatus.level ?? 'ok';
  const hardCap = usage?.budgetStatus.hardCapUsd ?? 0;
  const softCap = usage?.budgetStatus.softCapUsd ?? 0;
  const monthSpend = usage?.month.estimatedCostUsd ?? 0;
  const budgetPct = hardCap > 0 ? Math.min(100, Math.round((monthSpend / hardCap) * 100)) : 0;
  const languageMode = settings?.voice.languageMode ?? 'auto';
  const inTauri = isTauriDesktop();

  const handleSubmit = (e: FormEvent) => {
    e.preventDefault();
    const trimmed = quickInput.trim();
    if (!trimmed || isTextBusy) return;
    setQuickInput('');
    onQuickSend(trimmed);
  };

  const formattedTopDate = new Date()
    .toLocaleDateString([], { weekday: 'long', month: 'short', day: 'numeric' })
    .toUpperCase();

  return (
    <div className="mx-auto w-full max-w-[1440px] px-4 py-6 sm:px-7 lg:px-10 lg:py-8">
      {/* Topbar */}
      <header className="mb-6 flex flex-wrap items-center justify-between gap-4">
        <div>
          <div
            className="text-[11px] font-medium tracking-[0.22em] uppercase"
            style={{ color: 'var(--mj-text-subtle)' }}
          >
            PERSONAL AI ASSISTANT · MONITORING &amp; REALTIME VOICE
          </div>
          <h1 className="mt-1.5 text-2xl font-normal tracking-tight text-[#F0F5F9] sm:text-3xl">
            MJ <span style={{ color: 'var(--mj-accent-ice)' }}>Assistant</span>
          </h1>
        </div>

        <div className="flex items-center gap-3">
          <span
            className="hidden border-r pr-3 text-xs tracking-[0.06em] sm:inline"
            style={{
              color: 'var(--mj-text-muted)',
              borderColor: 'var(--mj-border-subtle)',
            }}
          >
            {formattedTopDate}
          </span>
          <StatusPill
            tone={
              !online || health?.backend !== 'online'
                ? 'error'
                : apiKeyReady
                  ? 'good'
                  : 'warn'
            }
          >
            {!online
              ? 'Browser offline'
              : health?.backend !== 'online'
                ? 'Backend offline'
                : apiKeyReady
                  ? resolveProviderDisplay({
                      activeProvider: settings?.activeProvider ?? health?.activeProvider,
                      activeModel: settings?.activeModel ?? health?.activeModel,
                      activeVoiceModel: settings?.voice.voiceModel ?? health?.activeVoiceModel,
                      apiBaseHost: settings?.apiBaseHost ?? health?.apiBaseHost,
                      providers: settings?.providers,
                    }).readyBanner
                  : 'API Key Missing'}
          </StatusPill>
        </div>
      </header>

      {/* Main Responsive Grid */}
      <div className="grid grid-cols-1 gap-4 xl:grid-cols-[minmax(0,1fr)_330px]">
        <div className="flex min-w-0 flex-col gap-4">
          {/* Central Hero Card */}
          <Panel
            elevated
            className="relative flex flex-col items-center overflow-hidden px-5 py-7 sm:px-8 sm:py-8"
            style={{
              background:
                'radial-gradient(ellipse at 50% 42%, rgba(96, 149, 190, 0.13), transparent 46%), linear-gradient(155deg, rgba(18, 25, 35, 0.96), rgba(9, 12, 18, 0.98))',
            }}
          >
            <div className="flex w-full flex-wrap items-center justify-between gap-3">
              <div className="flex items-center gap-2.5">
                <span
                  className="text-[11px] font-medium tracking-[0.2em] uppercase"
                  style={{ color: 'var(--mj-text-subtle)' }}
                >
                  MJ CORE
                </span>
                <span
                  className="rounded-full px-2.5 py-0.5 font-mono text-[10px]"
                  style={{
                    backgroundColor: 'rgba(255, 255, 255, 0.03)',
                    border: '1px solid var(--mj-border-subtle)',
                    color: 'var(--mj-accent-ice)',
                  }}
                >
                  {interactionMode === 'voice'
                    ? settings?.voice.voiceModel ?? 'gemini-2.5-flash-native-audio-preview-12-2025'
                    : settings?.activeModel ?? 'gemini-2.5-flash'}
                </span>
              </div>

              {/* Voice / Text Mode Toggle (Section 04 & 05) */}
              <div
                className="inline-flex rounded-xl p-1"
                role="group"
                aria-label="Interaction mode"
                style={{
                  backgroundColor: 'rgba(7, 9, 14, 0.75)',
                  border: '1px solid var(--mj-border-subtle)',
                }}
              >
                <button
                  type="button"
                  onClick={() => onChangeInteractionMode('voice')}
                  className="rounded-lg px-3 py-1 text-xs font-medium transition"
                  style={{
                    backgroundColor:
                      interactionMode === 'voice' ? 'rgba(154, 198, 230, 0.18)' : 'transparent',
                    color:
                      interactionMode === 'voice'
                        ? 'var(--mj-accent-ice)'
                        : 'var(--mj-text-muted)',
                  }}
                >
                  Voice Mode
                </button>
                <button
                  type="button"
                  onClick={() => onChangeInteractionMode('text')}
                  className="rounded-lg px-3 py-1 text-xs font-medium transition"
                  style={{
                    backgroundColor:
                      interactionMode === 'text' ? 'rgba(154, 198, 230, 0.18)' : 'transparent',
                    color:
                      interactionMode === 'text'
                        ? 'var(--mj-accent-ice)'
                        : 'var(--mj-text-muted)',
                  }}
                >
                  Text Mode
                </button>
              </div>
            </div>

            <h2 className="mt-5 text-center text-2xl font-normal tracking-tight text-[#EDF3F8] sm:text-3xl">
              How can I <span style={{ color: 'var(--mj-accent-ice)' }}>assist you?</span>
            </h2>
            <p className="mt-1.5 text-center text-xs sm:text-sm" style={{ color: 'var(--mj-text-muted)' }}>
              {(() => {
                const detailLower = voiceDetail.toLowerCase();
                const isServerStt =
                  detailLower.includes('server transcription') ||
                  detailLower.includes('server stt');
                const effectiveVoiceModel = isServerStt
                  ? 'server-stt'
                  : (settings?.voice.voiceModel ??
                    health?.activeVoiceModel ??
                    'free-browser-voice');
                const display = resolveProviderDisplay({
                  activeProvider: settings?.activeProvider ?? health?.activeProvider,
                  activeModel: settings?.activeModel ?? health?.activeModel,
                  activeVoiceModel: effectiveVoiceModel,
                  apiBaseHost: settings?.apiBaseHost ?? health?.apiBaseHost,
                  providers: settings?.providers,
                });
                return interactionMode === 'voice'
                  ? `Speak naturally in English, বাংলা, हिन्दी, Banglish, or Hinglish with ${display.voiceLiveLabel}.`
                  : `Type in English, বাংলা, हिन्दी, Banglish, or Hinglish with ${display.textEngineLabel}.`;
              })()}
            </p>

            <div className="my-4">
              <MJCoreOrb
                state={orbState}
                statusLabel={orbStatusLabel}
                audioLevel={voiceAudioLevel}
                micActive={voiceActive && !voiceMuted}
              />
            </div>

            {/* 9-State Voice Machine Indicator */}
            <VoiceStateBar
              currentState={voiceState}
              detail={voiceDetail}
              micActive={voiceActive}
              muted={voiceMuted}
              repeatErrorHint={repeatErrorHint}
            />

            {/* Voice Interaction Controls (Section 05) */}
            <div className="mt-5 flex flex-wrap items-center justify-center gap-3">
              {/* Stop Listening */}
              <button
                type="button"
                onClick={onStopVoice}
                disabled={!voiceActive}
                title="Stop listening"
                aria-label="Stop listening"
                className="flex h-11 items-center gap-2 rounded-2xl px-3.5 text-xs font-medium transition disabled:cursor-not-allowed disabled:opacity-40"
                style={{
                  backgroundColor: 'rgba(255, 255, 255, 0.03)',
                  border: '1px solid var(--mj-border-strong)',
                  color: 'var(--mj-text-secondary)',
                }}
              >
                <Square className="h-3.5 w-3.5" />
                <span>Stop</span>
              </button>

              {/* Mute / Unmute */}
              <button
                type="button"
                onClick={onToggleMute}
                disabled={!voiceActive}
                title={voiceMuted ? 'Unmute microphone' : 'Mute microphone'}
                aria-label={voiceMuted ? 'Unmute microphone' : 'Mute microphone'}
                className="flex h-11 items-center gap-2 rounded-2xl px-3.5 text-xs font-medium transition disabled:cursor-not-allowed disabled:opacity-40"
                style={{
                  backgroundColor: voiceMuted
                    ? 'rgba(227, 190, 126, 0.14)'
                    : 'rgba(255, 255, 255, 0.03)',
                  border: voiceMuted
                    ? '1px solid rgba(227, 190, 126, 0.35)'
                    : '1px solid var(--mj-border-strong)',
                  color: voiceMuted ? 'var(--mj-status-warn)' : 'var(--mj-text-secondary)',
                }}
              >
                {voiceMuted ? <MicOff className="h-4 w-4" /> : <Mic className="h-4 w-4" />}
                <span>{voiceMuted ? 'Unmute' : 'Mute'}</span>
              </button>

              {/* Primary Talk / Start Listening Button */}
              <button
                type="button"
                onClick={voiceActive ? onStopVoice : onStartVoice}
                aria-label={voiceActive ? 'Stop voice session' : 'Start listening'}
                title={voiceActive ? 'Stop voice session' : 'Start listening'}
                className="grid h-14 w-14 place-items-center rounded-2xl transition hover:-translate-y-0.5"
                style={{
                  background: voiceActive
                    ? 'linear-gradient(145deg, rgba(127, 209, 174, 0.3), rgba(90, 165, 134, 0.16))'
                    : 'linear-gradient(145deg, #E7F4FC, #9BC8E5 70%, #75A6C8)',
                  border: voiceActive
                    ? '1px solid rgba(127, 209, 174, 0.6)'
                    : '1px solid rgba(225, 243, 255, 0.72)',
                  color: voiceActive ? '#E8FFF4' : '#0B141D',
                  boxShadow: voiceActive
                    ? '0 0 28px rgba(127, 209, 174, 0.28)'
                    : '0 8px 30px rgba(113, 175, 216, 0.26)',
                }}
              >
                {voiceActive ? <AudioLines className="h-6 w-6" /> : <Mic className="h-6 w-6" />}
              </button>

              {/* Interrupt */}
              <button
                type="button"
                onClick={onInterruptVoice}
                disabled={voiceState !== 'speaking' && voiceState !== 'processing'}
                title="Interrupt assistant response"
                aria-label="Interrupt assistant response"
                className="flex h-11 items-center gap-2 rounded-2xl px-3.5 text-xs font-medium transition disabled:cursor-not-allowed disabled:opacity-40"
                style={{
                  backgroundColor: 'rgba(255, 255, 255, 0.03)',
                  border: '1px solid var(--mj-border-strong)',
                  color: 'var(--mj-text-secondary)',
                }}
              >
                <Hand className="h-3.5 w-3.5" />
                <span>Interrupt</span>
              </button>

              {/* Repeat Response */}
              <button
                type="button"
                onClick={onRepeatLastResponse}
                disabled={!hasLastResponseToSpeak || !settings?.voice.voiceOutputEnabled}
                title="Repeat last response aloud"
                aria-label="Repeat last response aloud"
                className="flex h-11 items-center gap-2 rounded-2xl px-3.5 text-xs font-medium transition disabled:cursor-not-allowed disabled:opacity-40"
                style={{
                  backgroundColor: 'rgba(255, 255, 255, 0.03)',
                  border: '1px solid var(--mj-border-strong)',
                  color: 'var(--mj-text-secondary)',
                }}
              >
                <Volume2 className="h-4 w-4" />
                <span>Repeat</span>
              </button>
            </div>

            {/* Language Quick Switch */}
            <div className="mt-3 flex flex-wrap items-center justify-center gap-1.5 text-[11px]">
              <span className="mr-1" style={{ color: 'var(--mj-text-subtle)' }}>
                Language:
              </span>
              {LANGUAGE_OPTIONS.map((opt) => {
                const selected = languageMode === opt.id;
                return (
                  <button
                    key={opt.id}
                    type="button"
                    onClick={() => onChangeLanguageMode(opt.id)}
                    className="rounded-lg px-2.5 py-1 transition"
                    style={{
                      backgroundColor: selected
                        ? 'rgba(154, 198, 230, 0.16)'
                        : 'rgba(255, 255, 255, 0.025)',
                      border: selected
                        ? '1px solid rgba(177, 215, 241, 0.28)'
                        : '1px solid var(--mj-border-subtle)',
                      color: selected ? 'var(--mj-accent-ice)' : 'var(--mj-text-muted)',
                    }}
                  >
                    {opt.label}
                  </button>
                );
              })}
            </div>

            {/* Live Voice Transcript Preview */}
            {(liveUserTranscript || liveAssistantTranscript) && (
              <div
                className="mt-4 w-full max-w-xl space-y-2 rounded-xl p-3.5 text-xs"
                style={{
                  backgroundColor: 'rgba(7, 9, 14, 0.72)',
                  border: '1px solid var(--mj-border-subtle)',
                }}
              >
                <div
                  className="text-[10px] font-medium tracking-[0.14em] uppercase"
                  style={{ color: 'var(--mj-text-subtle)' }}
                >
                  Live Voice Transcript
                </div>
                {liveUserTranscript && (
                  <div className="text-[#C7E3F5]">
                    <span className="font-semibold">You: </span>
                    {liveUserTranscript}
                  </div>
                )}
                {liveAssistantTranscript && (
                  <div className="text-[#EDF3F8]">
                    <span className="font-semibold text-[#9AC6E6]">MJ: </span>
                    {liveAssistantTranscript}
                  </div>
                )}
              </div>
            )}

            {/* API Key Setup Notice */}
            {!apiKeyReady && (
              <div
                role="status"
                className="mt-4 flex w-full max-w-xl items-start gap-3 rounded-xl px-4 py-3 text-xs"
                style={{
                  backgroundColor: 'rgba(227, 190, 126, 0.08)',
                  border: '1px solid rgba(227, 190, 126, 0.28)',
                  color: 'var(--mj-status-warn)',
                }}
              >
                <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
                <div className="space-y-1">
                  <div className="font-medium text-[#F5DFB5]">
                    No active AI provider key or local runtime is configured
                  </div>
                  <p style={{ color: 'var(--mj-text-secondary)' }}>
                    {resolveProviderDisplay({
                      activeProvider: settings?.activeProvider ?? health?.activeProvider,
                      activeModel: settings?.activeModel ?? health?.activeModel,
                      apiBaseHost: settings?.apiBaseHost ?? health?.apiBaseHost,
                      providers: settings?.providers,
                    }).missingKeyHint}
                  </p>
                </div>
              </div>
            )}

            {/* Structured Error Banner */}
            {activeError && (
              <div
                role="alert"
                className="mt-4 flex w-full max-w-xl flex-wrap items-center justify-between gap-3 rounded-xl px-4 py-3 text-xs"
                style={{
                  backgroundColor: 'rgba(240, 138, 138, 0.09)',
                  border: '1px solid rgba(240, 138, 138, 0.3)',
                  color: 'var(--mj-status-error)',
                }}
              >
                <div className="min-w-0 flex-1">
                  <span className="mr-2 font-mono text-[10px] uppercase opacity-90">
                    [{activeError.code}]
                  </span>
                  <span style={{ color: '#FBE4E4' }}>{activeError.message}</span>
                </div>
                {repeatErrorHint ? (
                  <div className="flex items-center gap-2">
                    <span
                      className="rounded-lg px-2.5 py-1.5 text-[11px] font-medium"
                      style={{
                        backgroundColor: 'rgba(227, 190, 126, 0.12)',
                        border: '1px solid rgba(227, 190, 126, 0.32)',
                        color: 'var(--mj-status-warn)',
                      }}
                    >
                      {repeatErrorHint}
                    </span>
                    <button
                      type="button"
                      onClick={onNavigateSettings}
                      className="inline-flex items-center rounded-lg px-2.5 py-1.5 text-xs font-medium transition hover:bg-white/10"
                      style={{
                        border: '1px solid rgba(227, 190, 126, 0.38)',
                        color: '#F5DFB5',
                      }}
                    >
                      Settings
                    </button>
                  </div>
                ) : (
                  activeError.retryable && (
                    <button
                      type="button"
                      onClick={onRetryLast}
                      className="inline-flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-xs font-medium transition hover:bg-white/10"
                      style={{
                        border: '1px solid rgba(240, 138, 138, 0.35)',
                        color: '#FBE4E4',
                      }}
                    >
                      <RefreshCw className="h-3.5 w-3.5" />
                      Retry
                    </button>
                  )
                )}
              </div>
            )}

            {/* 20s Confirmation Prompt for Risky Tool Calls */}
            {pendingConfirmation && onConfirmToolAction && onCancelToolAction && (
              <div className="mt-4 w-full">
                <ToolConfirmationBanner
                  confirmation={pendingConfirmation}
                  onConfirm={onConfirmToolAction}
                  onCancel={onCancelToolAction}
                />
              </div>
            )}

            {/* Quick Text Composer */}
            <form
              onSubmit={handleSubmit}
              className="mt-4 flex w-full max-w-xl items-center gap-2 rounded-2xl px-4 py-2 transition"
              style={{
                backgroundColor: 'rgba(4, 8, 13, 0.65)',
                border: '1px solid rgba(181, 210, 232, 0.18)',
                boxShadow: 'inset 0 1px rgba(255, 255, 255, 0.03), 0 8px 24px rgba(0, 0, 0, 0.2)',
              }}
            >
              <input
                type="text"
                value={quickInput}
                onChange={(e) => setQuickInput(e.target.value)}
                placeholder="Type a message in English, বাংলা, or Banglish…"
                aria-label="Message MJ Assistant"
                className="min-w-0 flex-1 bg-transparent py-2 text-sm text-[#EDF3F8] outline-none placeholder:text-[#8B9CB0]"
                disabled={isTextBusy}
              />

              {isTextBusy ? (
                <button
                  type="button"
                  onClick={onStopStream}
                  className="inline-flex items-center gap-1.5 rounded-xl px-3.5 py-2 text-xs font-medium transition"
                  style={{
                    backgroundColor: 'rgba(240, 138, 138, 0.14)',
                    border: '1px solid rgba(240, 138, 138, 0.35)',
                    color: 'var(--mj-status-error)',
                  }}
                >
                  <Square className="h-3.5 w-3.5 fill-current" />
                  Stop
                </button>
              ) : (
                <button
                  type="submit"
                  disabled={!quickInput.trim()}
                  aria-label="Send message"
                  className="grid h-9 w-9 place-items-center rounded-xl transition disabled:cursor-not-allowed disabled:opacity-40"
                  style={{
                    background:
                      'linear-gradient(145deg, rgba(160, 205, 234, 0.28), rgba(121, 170, 205, 0.14))',
                    color: 'var(--mj-accent-ice)',
                  }}
                >
                  <Send className="h-4 w-4" />
                </button>
              )}
            </form>

            {/* Live Home Exchange Preview */}
            {latestHomeExchange && (
              <div
                className="mt-4 w-full max-w-xl rounded-xl p-4"
                style={{
                  backgroundColor: 'rgba(7, 9, 14, 0.72)',
                  border: '1px solid var(--mj-border-subtle)',
                }}
              >
                <div className="mb-2 flex items-center justify-between gap-2 text-xs">
                  <span style={{ color: 'var(--mj-text-subtle)' }}>Latest response</span>
                  <button
                    type="button"
                    onClick={() => onOpenConversation(latestHomeExchange.conversationId)}
                    className="inline-flex items-center gap-1 font-medium transition hover:underline"
                    style={{ color: 'var(--mj-accent-ice)' }}
                  >
                    Continue in Chat
                    <ArrowRight className="h-3.5 w-3.5" />
                  </button>
                </div>
                <div
                  className="mb-2.5 truncate text-xs font-medium"
                  style={{ color: 'var(--mj-text-secondary)' }}
                >
                  You: {latestHomeExchange.userPrompt}
                </div>
                <div className="max-h-44 overflow-y-auto pr-1 text-sm">
                  {latestHomeExchange.assistantMessage?.content ? (
                    <MarkdownMessage content={latestHomeExchange.assistantMessage.content} />
                  ) : (
                    <span className="text-xs" style={{ color: 'var(--mj-text-muted)' }}>
                      {streamStatusDetail}
                    </span>
                  )}
                </div>
                <WebSourcesBar sources={webSearchSources} />
              </div>
            )}

            <div className="mt-4 flex flex-wrap items-center justify-center gap-3 text-xs">
              <button
                type="button"
                onClick={onNavigateChat}
                className="inline-flex items-center gap-1.5 rounded-xl px-3.5 py-2 font-medium transition hover:bg-white/5"
                style={{
                  border: '1px solid var(--mj-border-subtle)',
                  color: 'var(--mj-accent-ice)',
                }}
              >
                <MessageSquare className="h-3.5 w-3.5" />
                Open Shared Chat History
              </button>
              <button
                type="button"
                onClick={onNavigateSettings}
                className="inline-flex items-center gap-1.5 rounded-xl px-3.5 py-2 transition hover:bg-white/5"
                style={{
                  border: '1px solid var(--mj-border-subtle)',
                  color: 'var(--mj-text-secondary)',
                }}
              >
                Voice, Language &amp; Budget Settings
              </button>
            </div>
          </Panel>

          {/* Bottom Cards: Quick Starters + Recent Conversations */}
          <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
            <Panel className="p-5">
              <div className="mb-4 flex items-center justify-between">
                <h3 className="text-sm font-medium text-[#DCE7F0]">Quick Starters</h3>
                <span
                  className="text-[11px] tracking-[0.12em] uppercase"
                  style={{ color: 'var(--mj-text-subtle)' }}
                >
                  TEXT &amp; CONTEXT
                </span>
              </div>
              <div className="grid grid-cols-2 gap-2.5">
                {QUICK_STARTERS.map((starter) => {
                  const Icon = starter.icon;
                  return (
                    <button
                      key={starter.label}
                      type="button"
                      disabled={isTextBusy}
                      onClick={() => onQuickSend(starter.prompt)}
                      className="flex flex-col items-start gap-1.5 rounded-xl p-3 text-left transition hover:-translate-y-0.5 disabled:cursor-not-allowed disabled:opacity-50"
                      style={{
                        background:
                          'linear-gradient(145deg, rgba(255, 255, 255, 0.035), rgba(255, 255, 255, 0.01))',
                        border: '1px solid var(--mj-border-subtle)',
                      }}
                    >
                      <Icon className="h-4 w-4" style={{ color: 'var(--mj-accent-blue)' }} />
                      <div className="text-xs font-medium text-[#EDF3F8]">{starter.label}</div>
                      <div className="text-[11px]" style={{ color: 'var(--mj-text-subtle)' }}>
                        {starter.hint}
                      </div>
                    </button>
                  );
                })}
              </div>
            </Panel>

            <Panel className="p-5">
              <div className="mb-4 flex items-center justify-between">
                <h3 className="text-sm font-medium text-[#DCE7F0]">Recent Conversations</h3>
                <button
                  type="button"
                  onClick={onNavigateChat}
                  className="text-xs transition hover:underline"
                  style={{ color: 'var(--mj-accent-ice)' }}
                >
                  View all
                </button>
              </div>
              {conversations.length === 0 ? (
                <div
                  className="rounded-xl p-4 text-xs leading-relaxed"
                  style={{
                    backgroundColor: 'rgba(255, 255, 255, 0.02)',
                    border: '1px solid var(--mj-border-subtle)',
                    color: 'var(--mj-text-muted)',
                  }}
                >
                  No saved conversations yet. Start speaking or send a text message above to begin.
                </div>
              ) : (
                <ul className="divide-y" style={{ borderColor: 'var(--mj-border-subtle)' }}>
                  {conversations.slice(0, 4).map((conv) => (
                    <li key={conv.id} className="py-2 first:pt-0 last:pb-0">
                      <button
                        type="button"
                        onClick={() => onOpenConversation(conv.id)}
                        className="flex w-full items-center justify-between gap-3 rounded-lg px-2 py-1.5 text-left transition hover:bg-white/5"
                      >
                        <div className="min-w-0 flex-1">
                          <div className="truncate text-xs font-medium text-[#EDF3F8]">
                            {conv.title}
                          </div>
                          <div
                            className="mt-0.5 truncate text-[11px]"
                            style={{ color: 'var(--mj-text-subtle)' }}
                          >
                            {conv.lastMessagePreview || 'Empty conversation'}
                          </div>
                        </div>
                        <span
                          className="shrink-0 text-[11px]"
                          style={{ color: 'var(--mj-text-subtle)' }}
                        >
                          {conv.messageCount} msg
                        </span>
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </Panel>
          </div>
        </div>

        {/* Right Information Panel */}
        <aside className="flex min-w-0 flex-col gap-4">
          {/* Isolated Clock Card (prevents 1s interval rerenders across orb/feed) */}
          <LocalClockCard />

          {/* System Status (100% real data) */}
          <Panel className="p-5">
            <div className="mb-3 flex items-center justify-between">
              <h3 className="text-sm font-medium text-[#DCE7F0]">System Status</h3>
              <StatusPill tone={health?.backend === 'online' ? 'good' : 'error'}>
                {health?.backend === 'online' ? 'Online' : 'Offline'}
              </StatusPill>
            </div>

            <div className="divide-y text-xs" style={{ borderColor: 'rgba(216, 231, 245, 0.06)' }}>
              <StatusRow
                icon={<Cpu className="h-4 w-4" />}
                label="AI Engine"
                value={
                  apiKeyReady
                    ? 'Connected'
                    : health?.backend === 'online'
                      ? 'Disconnected'
                      : 'Unavailable'
                }
                tone={apiKeyReady ? 'good' : 'warn'}
              />
              <StatusRow
                icon={<AudioLines className="h-4 w-4" />}
                label="Voice Engine"
                value={
                  voiceActive
                    ? VOICE_STATE_META[voiceState].label
                    : apiKeyReady
                      ? 'Connected'
                      : 'Disconnected'
                }
                tone={
                  voiceState === 'error'
                    ? 'error'
                    : voiceActive || apiKeyReady
                      ? 'good'
                      : 'warn'
                }
              />
              <StatusRow
                icon={<Wifi className="h-4 w-4" />}
                label="WebSocket"
                value={
                  voiceActive
                    ? VOICE_STATE_META[voiceState].label
                    : voiceState === 'error'
                      ? 'Error'
                      : 'Standby'
                }
                tone={voiceState === 'error' ? 'error' : voiceActive ? 'good' : 'neutral'}
              />
              <StatusRow
                icon={<Database className="h-4 w-4" />}
                label="Database"
                value={health?.database === 'healthy' ? 'Healthy' : 'Unavailable'}
                tone={health?.database === 'healthy' ? 'good' : 'error'}
              />
              <StatusRow
                icon={<Globe className="h-4 w-4" />}
                label="Network"
                value={online ? 'Connected' : 'Offline'}
                tone={online ? 'good' : 'warn'}
              />
              <StatusRow
                icon={<Laptop className="h-4 w-4" />}
                label="Desktop"
                value={inTauri ? 'Tauri Native' : 'Host Bridge'}
                tone={inTauri || health?.backend === 'online' ? 'good' : 'warn'}
              />
              <StatusRow
                icon={<Sparkles className="h-4 w-4" />}
                label="Models"
                value={`${settings?.activeModel ?? health?.activeModel ?? 'gemini-2.5-flash'} · ${settings?.voice.voiceModel ?? health?.activeVoiceModel ?? 'free-browser-voice'}`}
                tone="neutral"
              />
            </div>
          </Panel>

          {/* API Usage & Spend-vs-Budget Summary */}
          <Panel className="p-5">
            <div className="mb-3 flex items-center justify-between">
              <h3 className="text-sm font-medium text-[#DCE7F0]">Spend vs Budget</h3>
              <button
                type="button"
                onClick={onNavigateUsage}
                className="inline-flex items-center gap-1 text-[11px] font-medium transition hover:underline"
                style={{ color: 'var(--mj-accent-ice)' }}
              >
                <Activity className="h-3 w-3" />
                Full Monitor
              </button>
            </div>

            <div className="grid grid-cols-2 gap-3 text-xs">
              <div
                className="rounded-xl p-3"
                style={{
                  backgroundColor: 'rgba(255, 255, 255, 0.02)',
                  border: '1px solid var(--mj-border-subtle)',
                }}
              >
                <div style={{ color: 'var(--mj-text-subtle)' }}>Est. month spend</div>
                <div className="mt-1 text-lg font-medium text-[#EDF3F8] tabular-nums">
                  ${monthSpend.toFixed(4)}
                </div>
              </div>
              <div
                className="rounded-xl p-3"
                style={{
                  backgroundColor: 'rgba(255, 255, 255, 0.02)',
                  border: '1px solid var(--mj-border-subtle)',
                }}
              >
                <div style={{ color: 'var(--mj-text-subtle)' }}>Avg latency / Voice</div>
                <div className="mt-1 text-sm font-medium text-[#EDF3F8] tabular-nums">
                  {usage?.month.avgLatencyMs ?? 0}ms · {((usage?.month.voiceSeconds ?? 0) / 60).toFixed(1)}m
                </div>
              </div>
            </div>

            <div className="mt-3.5">
              <div className="flex items-center justify-between text-[11px]">
                <span style={{ color: 'var(--mj-text-subtle)' }}>
                  Cap: {softCap > 0 ? `$${softCap.toFixed(0)} warn / ` : ''}{hardCap > 0 ? `$${hardCap.toFixed(2)} hard` : 'No hard cap'}
                </span>
                <span
                  style={{
                    color:
                      budgetLevel === 'hard_cap_reached'
                        ? 'var(--mj-status-error)'
                        : budgetLevel === 'soft_cap_warning'
                          ? 'var(--mj-status-warn)'
                          : 'var(--mj-accent-ice)',
                  }}
                >
                  {hardCap > 0 ? `${budgetPct}%` : `${usage?.month.totalTokens ?? 0} tok`}
                </span>
              </div>
              <div
                className="mt-2 h-1.5 w-full overflow-hidden rounded-full"
                style={{ backgroundColor: 'rgba(255, 255, 255, 0.08)' }}
              >
                <div
                  className="h-full rounded-full transition-all"
                  style={{
                    width: `${hardCap > 0 ? Math.max(budgetPct, monthSpend > 0 ? 4 : 0) : 0}%`,
                    background:
                      budgetLevel === 'hard_cap_reached'
                        ? 'var(--mj-status-error)'
                        : budgetLevel === 'soft_cap_warning'
                          ? 'var(--mj-status-warn)'
                          : 'linear-gradient(90deg, #5F8EAE, #B3D6EC)',
                  }}
                />
              </div>
            </div>
          </Panel>

          {/* Privacy & Ephemeral Token Note */}
          <Panel className="p-5">
            <div className="flex items-start gap-3">
              <div
                className="grid h-9 w-9 shrink-0 place-items-center rounded-xl"
                style={{
                  backgroundColor: 'rgba(154, 198, 230, 0.08)',
                  border: '1px solid rgba(171, 211, 239, 0.16)',
                  color: 'var(--mj-accent-ice)',
                }}
              >
                <ShieldCheck className="h-4 w-4" />
              </div>
              <div className="text-xs">
                <div className="font-medium text-[#DCE6EE]">Ephemeral voice tokens</div>
                <p className="mt-1 leading-relaxed" style={{ color: 'var(--mj-text-muted)' }}>
                  Your mic stays off until you press Talk. Realtime voice stays isolated via server-side sessions and browser/free fallbacks ({resolveProviderDisplay({
                    activeProvider: settings?.activeProvider ?? health?.activeProvider,
                    activeModel: settings?.activeModel ?? health?.activeModel,
                    activeVoiceModel: settings?.voice.voiceModel ?? health?.activeVoiceModel,
                    apiBaseHost: settings?.apiBaseHost ?? health?.apiBaseHost,
                    providers: settings?.providers,
                  }).voiceLiveLabel}).
                </p>
              </div>
            </div>
          </Panel>
        </aside>
      </div>
    </div>
  );
}

const LocalClockCard = memo(function LocalClockCard() {
  const [now, setNow] = useState(() => new Date());

  useEffect(() => {
    const timer = setInterval(() => setNow(new Date()), 10_000);
    return () => clearInterval(timer);
  }, []);

  const formattedTime = now.toLocaleTimeString([], {
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
  const formattedFullDate = now.toLocaleDateString([], {
    weekday: 'long',
    month: 'long',
    day: 'numeric',
    year: 'numeric',
  });
  const greeting =
    now.getHours() < 12
      ? 'Good morning.'
      : now.getHours() < 18
        ? 'Good afternoon.'
        : 'Good evening.';

  return (
    <Panel
      className="relative overflow-hidden p-5"
      style={{
        background:
          'radial-gradient(ellipse at 90% 10%, rgba(115, 161, 197, 0.14), transparent 45%), linear-gradient(145deg, rgba(18, 25, 36, 0.94), rgba(10, 14, 21, 0.94))',
      }}
    >
      <div
        className="text-[11px] font-medium tracking-[0.18em] uppercase"
        style={{ color: 'var(--mj-text-subtle)' }}
      >
        LOCAL TIME
      </div>
      <div className="mt-2.5 text-4xl font-light tracking-tight text-[#EDF5FB] tabular-nums">
        {formattedTime}
      </div>
      <div className="mt-1 text-xs" style={{ color: 'var(--mj-text-muted)' }}>
        {formattedFullDate}
      </div>
      <div
        className="mt-4 flex items-center justify-between border-t pt-3 text-xs"
        style={{ borderColor: 'var(--mj-border-subtle)' }}
      >
        <span className="font-medium text-[#DCE6EE]">{greeting}</span>
        <span style={{ color: 'var(--mj-text-subtle)' }}>Shared Context</span>
      </div>
    </Panel>
  );
});

function StatusRow({
  icon,
  label,
  value,
  tone,
}: {
  icon: React.ReactNode;
  label: string;
  value: string;
  tone: 'good' | 'warn' | 'error' | 'neutral';
}) {
  const valueColor =
    tone === 'good'
      ? 'var(--mj-status-good)'
      : tone === 'warn'
        ? 'var(--mj-status-warn)'
        : tone === 'error'
          ? 'var(--mj-status-error)'
          : 'var(--mj-accent-ice)';

  return (
    <div className="flex items-center justify-between gap-3 py-2.5">
      <div className="flex items-center gap-2.5" style={{ color: 'var(--mj-text-secondary)' }}>
        <span style={{ color: 'var(--mj-accent-blue)' }}>{icon}</span>
        <span>{label}</span>
      </div>
      <span className="truncate font-mono text-[11px]" style={{ color: valueColor }}>
        {value}
      </span>
    </div>
  );
}
