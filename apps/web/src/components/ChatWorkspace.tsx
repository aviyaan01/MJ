import { useEffect, useRef, useState, type FormEvent, type KeyboardEvent } from 'react';
import {
  AlertTriangle,
  AudioLines,
  Check,
  Copy,
  Edit3,
  Hand,
  Menu,
  MessageSquarePlus,
  Mic,
  MicOff,
  RefreshCw,
  RotateCcw,
  Search,
  Send,
  Square,
  Trash2,
  Volume2,
  X,
} from 'lucide-react';
import { BrandMark, Panel, StatusPill } from '@mj/ui';
import { VOICE_STATE_META } from '@mj/voice';
import {
  resolveProviderDisplay,
  type AiProviderId,
  type ConversationDTO,
  type MessageDTO,
  type PendingToolConfirmationDTO,
  type PublicSettingsDTO,
  type StructuredErrorPayload,
  type UsageSummaryDTO,
  type VoiceState,
  type WebSearchSourceDTO,
} from '@mj/shared';
import { MarkdownMessage } from './MarkdownMessage.js';
import { ToolConfirmationBanner } from './ToolConfirmationBanner.js';
import { VoiceStateBar } from './VoiceStateBar.js';
import { WebSourcesBar } from './WebSourcesBar.js';

interface ChatWorkspaceProps {
  conversations: ConversationDTO[];
  activeConversation: ConversationDTO | null;
  messages: MessageDTO[];
  searchQuery: string;
  onSearchChange: (value: string) => void;
  settings: PublicSettingsDTO | null;
  usage: UsageSummaryDTO | null;
  streamingState: 'idle' | 'connecting' | 'streaming' | 'error';
  streamStatusDetail: string;
  voiceState: VoiceState;
  voiceDetail: string;
  voiceMuted: boolean;
  liveUserTranscript: string;
  liveAssistantTranscript: string;
  activeError: StructuredErrorPayload | null;
  repeatErrorHint?: string | null;
  pendingConfirmation?: PendingToolConfirmationDTO | null;
  webSearchSources?: WebSearchSourceDTO[];
  appClipboardText?: string | null;
  onSyncAppClipboard?: (text: string) => Promise<void>;
  onConfirmToolAction?: () => void;
  onCancelToolAction?: () => void;
  selectedProviderOverride?: string;
  onSelectProviderOverride?: (provider: string) => void;
  selectedModelOverride: string;
  onSelectModelOverride: (model: string) => void;
  onSelectConversation: (id: string) => void;
  onCreateConversation: () => void;
  onRenameConversation: (id: string, title: string) => Promise<void>;
  onDeleteConversation: (id: string) => Promise<void>;
  onSendMessage: (content: string) => void;
  onRegenerate: () => void;
  onStopStream: () => void;
  onRetryLast: () => void;
  onStartVoice: () => void;
  onStopVoice: () => void;
  onToggleMute: () => void;
  onInterruptVoice: () => void;
  onSpeakText: (text: string) => void;
}

const STARTER_PROMPTS = [
  'Hey MJ, give me a concise architecture checklist for a Fastify + React app.',
  'Amar ekta project idea ache. Help me scope a clean MVP first.',
  'Explain exponential backoff with jitter in TypeScript with a short example.',
  'বাংলা এবং ইংরেজিতে আমাকে একটি short study plan তৈরি করে দাও।',
];

export function ChatWorkspace({
  conversations,
  activeConversation,
  messages,
  searchQuery,
  onSearchChange,
  settings,
  usage,
  streamingState,
  streamStatusDetail,
  voiceState,
  voiceDetail,
  voiceMuted,
  liveUserTranscript,
  liveAssistantTranscript,
  activeError,
  repeatErrorHint,
  pendingConfirmation,
  webSearchSources = [],
  appClipboardText,
  onSyncAppClipboard,
  onConfirmToolAction,
  onCancelToolAction,
  selectedProviderOverride = settings?.activeProvider ?? 'auto',
  onSelectProviderOverride,
  selectedModelOverride,
  onSelectModelOverride,
  onSelectConversation,
  onCreateConversation,
  onRenameConversation,
  onDeleteConversation,
  onSendMessage,
  onRegenerate,
  onStopStream,
  onRetryLast,
  onStartVoice,
  onStopVoice,
  onToggleMute,
  onInterruptVoice,
  onSpeakText,
}: ChatWorkspaceProps) {
  const [composerText, setComposerText] = useState('');
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editingTitle, setEditingTitle] = useState('');
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
  const [copiedMessageId, setCopiedMessageId] = useState<string | null>(null);

  const threadEndRef = useRef<HTMLDivElement | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);

  const isTextBusy = streamingState === 'connecting' || streamingState === 'streaming';
  const providerDisplay = resolveProviderDisplay({
    activeProvider: (selectedProviderOverride as AiProviderId | undefined) ?? settings?.activeProvider,
    activeModel: selectedModelOverride || settings?.activeModel,
    activeVoiceModel: settings?.voice.voiceModel,
    apiBaseHost: settings?.apiBaseHost,
    providers: settings?.providers,
  });

  const providerOptions: Array<{ id: string; label: string }> = [
    { id: 'auto', label: 'Auto' },
    ...(settings?.providers && settings.providers.length > 0
      ? settings.providers.map((p) => ({
          id: p.id,
          label:
            p.id === 'gemini'
              ? 'Gemini'
              : p.id === 'ollama'
                ? 'Ollama'
                : p.id === 'groq'
                  ? 'Groq'
                  : p.name,
        }))
      : [
          { id: 'gemini', label: 'Gemini' },
          { id: 'ollama', label: 'Ollama' },
          { id: 'groq', label: 'Groq' },
          { id: 'xai', label: 'xAI Grok' },
        ]),
  ];

  const activeProviderEntry =
    selectedProviderOverride && selectedProviderOverride !== 'auto'
      ? settings?.providers?.find((p) => p.id === selectedProviderOverride)
      : undefined;

  const selectableModels = Array.from(
    new Set([
      ...(activeProviderEntry?.models ?? settings?.availableModels ?? ['gemini-2.5-flash']),
      ...(selectedModelOverride ? [selectedModelOverride] : []),
    ]),
  ).filter(Boolean);
  const voiceActive =
    voiceState === 'requesting_permission' ||
    voiceState === 'connecting' ||
    voiceState === 'listening' ||
    voiceState === 'processing' ||
    voiceState === 'speaking' ||
    voiceState === 'interrupted' ||
    voiceState === 'reconnecting';
  const compact = settings?.compactDensity ?? false;
  const apiKeyReady = settings?.apiKeyConfigured ?? true;
  const budgetLevel = usage?.budgetStatus.level ?? 'ok';

  useEffect(() => {
    threadEndRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' });
  }, [
    messages.length,
    messages[messages.length - 1]?.content,
    liveUserTranscript,
    liveAssistantTranscript,
  ]);

  useEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 180)}px`;
  }, [composerText]);

  const handleSubmit = (e?: FormEvent) => {
    e?.preventDefault();
    const trimmed = composerText.trim();
    if (!trimmed || isTextBusy) return;
    setComposerText('');
    onSendMessage(trimmed);
  };

  const handleKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSubmit();
    }
  };

  const handleCopyMessage = async (msg: MessageDTO) => {
    try {
      await navigator.clipboard.writeText(msg.content);
      setCopiedMessageId(msg.id);
      setTimeout(() => setCopiedMessageId(null), 1800);
    } catch {
      // ignore clipboard restrictions
    }
  };

  const startRename = (conv: ConversationDTO) => {
    setEditingId(conv.id);
    setEditingTitle(conv.title);
    setConfirmDeleteId(null);
  };

  const submitRename = async (id: string) => {
    const trimmed = editingTitle.trim();
    if (!trimmed) {
      setEditingId(null);
      return;
    }
    await onRenameConversation(id, trimmed);
    setEditingId(null);
  };

  const lastAssistantId = [...messages].reverse().find((m) => m.role === 'assistant')?.id;

  const historyListContent = (
    <div className="flex h-full flex-col">
      <div className="flex items-center justify-between gap-2 p-3.5">
        <button
          type="button"
          onClick={() => {
            onCreateConversation();
            setDrawerOpen(false);
          }}
          className="flex flex-1 items-center justify-center gap-2 rounded-xl px-3.5 py-2.5 text-xs font-medium transition"
          style={{
            background:
              'linear-gradient(145deg, rgba(164, 205, 232, 0.2), rgba(121, 170, 205, 0.08))',
            border: '1px solid rgba(177, 215, 241, 0.24)',
            color: 'var(--mj-accent-ice)',
          }}
        >
          <MessageSquarePlus className="h-4 w-4" />
          <span>New Conversation</span>
        </button>

        <button
          type="button"
          onClick={() => setDrawerOpen(false)}
          className="rounded-lg p-2 lg:hidden"
          style={{ color: 'var(--mj-text-muted)' }}
          aria-label="Close conversation list"
        >
          <X className="h-4 w-4" />
        </button>
      </div>

      <div className="px-3.5 pb-3">
        <div
          className="flex items-center gap-2 rounded-xl px-3 py-2"
          style={{
            backgroundColor: '#07090E',
            border: '1px solid var(--mj-border-subtle)',
          }}
        >
          <Search className="h-3.5 w-3.5 shrink-0" style={{ color: 'var(--mj-text-subtle)' }} />
          <input
            type="search"
            value={searchQuery}
            onChange={(e) => onSearchChange(e.target.value)}
            placeholder="Search conversations…"
            aria-label="Search conversations"
            className="w-full bg-transparent text-xs text-[#EDF3F8] outline-none placeholder:text-[#8B9CB0]"
          />
        </div>
      </div>

      <div className="flex-1 overflow-y-auto px-2.5 pb-4">
        {conversations.length === 0 ? (
          <div className="px-3 py-6 text-center text-xs" style={{ color: 'var(--mj-text-subtle)' }}>
            {searchQuery ? 'No conversations match your search.' : 'No saved conversations yet.'}
          </div>
        ) : (
          <ul className="space-y-1">
            {conversations.map((conv) => {
              const isSelected = activeConversation?.id === conv.id;
              const isEditing = editingId === conv.id;
              const isConfirmDelete = confirmDeleteId === conv.id;

              return (
                <li
                  key={conv.id}
                  className="group rounded-xl transition"
                  style={{
                    backgroundColor: isSelected ? 'rgba(154, 198, 230, 0.11)' : 'transparent',
                    border: isSelected
                      ? '1px solid rgba(177, 215, 241, 0.2)'
                      : '1px solid transparent',
                  }}
                >
                  {isEditing ? (
                    <form
                      onSubmit={(e) => {
                        e.preventDefault();
                        void submitRename(conv.id);
                      }}
                      className="flex items-center gap-1.5 p-2"
                    >
                      <input
                        type="text"
                        value={editingTitle}
                        onChange={(e) => setEditingTitle(e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === 'Escape') setEditingId(null);
                        }}
                        className="min-w-0 flex-1 rounded-lg bg-[#07090E] px-2.5 py-1.5 text-xs text-[#EDF3F8] outline-none"
                        style={{ border: '1px solid var(--mj-border-strong)' }}
                        autoFocus
                      />
                      <button
                        type="submit"
                        aria-label="Save conversation name"
                        className="rounded-lg p-1.5 hover:bg-white/10"
                        style={{ color: 'var(--mj-status-good)' }}
                      >
                        <Check className="h-3.5 w-3.5" />
                      </button>
                      <button
                        type="button"
                        onClick={() => setEditingId(null)}
                        aria-label="Cancel rename"
                        className="rounded-lg p-1.5 hover:bg-white/10"
                        style={{ color: 'var(--mj-text-subtle)' }}
                      >
                        <X className="h-3.5 w-3.5" />
                      </button>
                    </form>
                  ) : (
                    <div className="flex items-center gap-1 px-2.5 py-2">
                      <button
                        type="button"
                        onClick={() => {
                          onSelectConversation(conv.id);
                          setDrawerOpen(false);
                        }}
                        className="min-w-0 flex-1 text-left"
                      >
                        <div
                          className="truncate text-xs font-medium"
                          style={{
                            color: isSelected ? 'var(--mj-accent-ice)' : 'var(--mj-text-primary)',
                          }}
                        >
                          {conv.title}
                        </div>
                        <div
                          className="mt-0.5 flex items-center gap-2 text-[11px]"
                          style={{ color: 'var(--mj-text-subtle)' }}
                        >
                          <span>{conv.messageCount} msg</span>
                          <span>·</span>
                          <span>{formatShortDate(conv.updatedAt)}</span>
                        </div>
                      </button>

                      {isConfirmDelete ? (
                        <div className="flex items-center gap-1">
                          <button
                            type="button"
                            onClick={() => {
                              setConfirmDeleteId(null);
                              void onDeleteConversation(conv.id);
                            }}
                            className="rounded-md px-2 py-1 text-[11px] font-medium"
                            style={{
                              backgroundColor: 'rgba(240, 138, 138, 0.16)',
                              color: 'var(--mj-status-error)',
                            }}
                          >
                            Delete
                          </button>
                          <button
                            type="button"
                            onClick={() => setConfirmDeleteId(null)}
                            className="rounded-md px-1.5 py-1 text-[11px]"
                            style={{ color: 'var(--mj-text-muted)' }}
                          >
                            No
                          </button>
                        </div>
                      ) : (
                        <div className="flex items-center gap-0.5 opacity-80 transition lg:opacity-0 lg:group-hover:opacity-100 lg:group-focus-within:opacity-100">
                          <button
                            type="button"
                            onClick={() => startRename(conv)}
                            aria-label={`Rename ${conv.title}`}
                            title="Rename"
                            className="rounded-lg p-1.5 transition hover:bg-white/10"
                            style={{ color: 'var(--mj-text-muted)' }}
                          >
                            <Edit3 className="h-3.5 w-3.5" />
                          </button>
                          <button
                            type="button"
                            onClick={() => setConfirmDeleteId(conv.id)}
                            aria-label={`Delete ${conv.title}`}
                            title="Delete"
                            className="rounded-lg p-1.5 transition hover:bg-white/10"
                            style={{ color: 'var(--mj-text-muted)' }}
                          >
                            <Trash2 className="h-3.5 w-3.5" />
                          </button>
                        </div>
                      )}
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </div>
  );

  return (
    <div className="relative flex h-[calc(100vh-72px)] min-h-[540px] w-full overflow-hidden md:h-screen">
      {/* Desktop History Sidebar */}
      <aside
        className="hidden w-72 shrink-0 border-r lg:block"
        style={{
          backgroundColor: 'rgba(10, 13, 19, 0.85)',
          borderColor: 'var(--mj-border-subtle)',
        }}
      >
        {historyListContent}
      </aside>

      {/* Mobile History Drawer */}
      {drawerOpen && (
        <div className="fixed inset-0 z-40 flex lg:hidden">
          <div
            className="fixed inset-0 bg-black/70 backdrop-blur-xs"
            onClick={() => setDrawerOpen(false)}
            aria-hidden="true"
          />
          <aside
            className="relative z-50 w-72 max-w-[85vw] border-r"
            style={{
              backgroundColor: '#0D1017',
              borderColor: 'var(--mj-border-strong)',
            }}
          >
            {historyListContent}
          </aside>
        </div>
      )}

      {/* Main Chat Column */}
      <div className="flex min-w-0 flex-1 flex-col">
        {/* Chat Header */}
        <header
          className="flex flex-wrap items-center justify-between gap-3 border-b px-4 py-3 sm:px-6"
          style={{
            backgroundColor: 'rgba(13, 16, 23, 0.72)',
            borderColor: 'var(--mj-border-subtle)',
            backdropFilter: 'blur(16px)',
          }}
        >
          <div className="flex min-w-0 items-center gap-3">
            <button
              type="button"
              onClick={() => setDrawerOpen(true)}
              aria-label="Open conversation history"
              className="rounded-xl p-2 transition hover:bg-white/5 lg:hidden"
              style={{
                border: '1px solid var(--mj-border-subtle)',
                color: 'var(--mj-text-secondary)',
              }}
            >
              <Menu className="h-4 w-4" />
            </button>

            <div className="min-w-0">
              <h1 className="truncate text-sm font-medium text-[#EDF3F8] sm:text-base">
                {activeConversation?.title ?? 'New Conversation'}
              </h1>
              <div className="text-[11px]" style={{ color: 'var(--mj-text-subtle)' }}>
                {voiceActive
                  ? `Voice: ${VOICE_STATE_META[voiceState].label}`
                  : isTextBusy
                    ? streamStatusDetail
                    : 'Shared Text + Voice Context'}
              </div>
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            {/* Inline Voice Session Trigger */}
            <button
              type="button"
              onClick={voiceActive ? onStopVoice : onStartVoice}
              className="inline-flex items-center gap-1.5 rounded-xl px-3 py-1.5 text-xs font-medium transition"
              style={{
                backgroundColor: voiceActive
                  ? 'rgba(127, 209, 174, 0.14)'
                  : 'rgba(154, 198, 230, 0.12)',
                border: voiceActive
                  ? '1px solid rgba(127, 209, 174, 0.36)'
                  : '1px solid rgba(177, 215, 241, 0.24)',
                color: voiceActive ? 'var(--mj-status-good)' : 'var(--mj-accent-ice)',
              }}
            >
              {voiceActive ? <AudioLines className="h-3.5 w-3.5" /> : <Mic className="h-3.5 w-3.5" />}
              <span>{voiceActive ? 'Stop Voice' : 'Talk'}</span>
            </button>

            {voiceActive && (
              <>
                <button
                  type="button"
                  onClick={onToggleMute}
                  className="inline-flex items-center gap-1 rounded-xl px-2.5 py-1.5 text-xs transition"
                  style={{
                    backgroundColor: voiceMuted
                      ? 'rgba(227, 190, 126, 0.14)'
                      : 'rgba(255, 255, 255, 0.04)',
                    border: '1px solid var(--mj-border-subtle)',
                    color: voiceMuted ? 'var(--mj-status-warn)' : 'var(--mj-text-secondary)',
                  }}
                >
                  {voiceMuted ? <MicOff className="h-3.5 w-3.5" /> : <Mic className="h-3.5 w-3.5" />}
                  <span>{voiceMuted ? 'Unmute' : 'Mute'}</span>
                </button>
                {(voiceState === 'speaking' || voiceState === 'processing') && (
                  <button
                    type="button"
                    onClick={onInterruptVoice}
                    className="inline-flex items-center gap-1 rounded-xl px-2.5 py-1.5 text-xs transition"
                    style={{
                      backgroundColor: 'rgba(240, 138, 138, 0.12)',
                      border: '1px solid rgba(240, 138, 138, 0.3)',
                      color: 'var(--mj-status-error)',
                    }}
                  >
                    <Hand className="h-3.5 w-3.5" />
                    <span>Interrupt</span>
                  </button>
                )}
              </>
            )}

            <label htmlFor="chat-provider-select" className="sr-only">
              Active AI Provider
            </label>
            <select
              id="chat-provider-select"
              aria-label="AI Provider"
              value={selectedProviderOverride}
              onChange={(e) => onSelectProviderOverride?.(e.target.value)}
              disabled={isTextBusy}
              className="rounded-xl px-2.5 py-1.5 font-mono text-xs outline-none disabled:opacity-50"
              style={{
                backgroundColor: '#0D1017',
                border: '1px solid var(--mj-border-subtle)',
                color: '#DCE6EE',
              }}
            >
              {providerOptions.map((opt) => (
                <option key={opt.id} value={opt.id}>
                  {opt.label}
                </option>
              ))}
            </select>

            <label htmlFor="chat-model-select" className="sr-only">
              Active Model
            </label>
            <select
              id="chat-model-select"
              value={selectedModelOverride || settings?.activeModel || 'gemini-2.5-flash'}
              onChange={(e) => onSelectModelOverride(e.target.value)}
              disabled={isTextBusy}
              className="rounded-xl px-3 py-1.5 font-mono text-xs outline-none disabled:opacity-50"
              style={{
                backgroundColor: '#0D1017',
                border: '1px solid var(--mj-border-subtle)',
                color: 'var(--mj-accent-ice)',
              }}
            >
              {selectableModels.map((modelId) => (
                <option key={modelId} value={modelId}>
                  {modelId}
                </option>
              ))}
            </select>

            <StatusPill
              tone={
                activeError || voiceState === 'error'
                  ? 'error'
                  : isTextBusy || voiceActive
                    ? 'good'
                    : apiKeyReady
                      ? 'good'
                      : 'warn'
              }
              pulse={isTextBusy || voiceActive}
            >
              {voiceActive
                ? VOICE_STATE_META[voiceState].label
                : activeError
                  ? 'Error'
                  : isTextBusy
                    ? 'Streaming'
                    : apiKeyReady
                      ? 'Ready'
                      : 'No Key'}
            </StatusPill>
          </div>
        </header>

        {/* Active Voice Bar inside Chat */}
        {voiceState !== 'idle' && (
          <div className="flex justify-center px-4 pt-3 sm:px-6">
            <VoiceStateBar
              currentState={voiceState}
              detail={voiceDetail}
              micActive={voiceActive}
              muted={voiceMuted}
            />
          </div>
        )}

        {/* Budget / Setup Notices */}
        {(budgetLevel !== 'ok' || !apiKeyReady) && (
          <div className="space-y-2 px-4 pt-3 sm:px-6">
            {!apiKeyReady && (
              <div
                className="flex items-center gap-2.5 rounded-xl px-4 py-2.5 text-xs"
                style={{
                  backgroundColor: 'rgba(227, 190, 126, 0.08)',
                  border: '1px solid rgba(227, 190, 126, 0.28)',
                  color: 'var(--mj-status-warn)',
                }}
              >
                <AlertTriangle className="h-4 w-4 shrink-0" />
                <span>{providerDisplay.missingKeyHint}</span>
              </div>
            )}

            {budgetLevel === 'soft_cap_warning' && (
              <div
                className="flex items-center gap-2.5 rounded-xl px-4 py-2.5 text-xs"
                style={{
                  backgroundColor: 'rgba(227, 190, 126, 0.08)',
                  border: '1px solid rgba(227, 190, 126, 0.28)',
                  color: 'var(--mj-status-warn)',
                }}
              >
                <AlertTriangle className="h-4 w-4 shrink-0" />
                <span>
                  Soft budget cap reached: estimated monthly spend is $
                  {usage?.month.estimatedCostUsd.toFixed(4)} (soft cap $
                  {usage?.budgetStatus.softCapUsd.toFixed(2)}).
                </span>
              </div>
            )}

            {budgetLevel === 'hard_cap_reached' && (
              <div
                className="flex items-center gap-2.5 rounded-xl px-4 py-2.5 text-xs"
                style={{
                  backgroundColor: 'rgba(240, 138, 138, 0.09)',
                  border: '1px solid rgba(240, 138, 138, 0.3)',
                  color: 'var(--mj-status-error)',
                }}
              >
                <AlertTriangle className="h-4 w-4 shrink-0" />
                <span>
                  Hard budget cap reached (${usage?.budgetStatus.hardCapUsd.toFixed(2)}). Adjust your cap in Settings -&gt; Usage &amp; Budget to continue.
                </span>
              </div>
            )}
          </div>
        )}

        {/* Messages Area */}
        <div className="flex-1 overflow-y-auto px-4 py-6 sm:px-6">
          <div className="mx-auto flex w-full max-w-3xl flex-col gap-4">
            {messages.length === 0 && !liveUserTranscript && !liveAssistantTranscript ? (
              <div className="my-auto py-8 text-center">
                <div
                  className="mx-auto grid h-14 w-14 place-items-center rounded-2xl"
                  style={{
                    background:
                      'linear-gradient(145deg, rgba(164, 205, 232, 0.16), rgba(255, 255, 255, 0.02))',
                    border: '1px solid rgba(199, 227, 245, 0.24)',
                  }}
                >
                  <BrandMark className="h-7 w-7" />
                </div>
                <h2 className="mt-4 text-xl font-normal tracking-tight text-[#EDF3F8]">
                  Hello! I’m <span style={{ color: 'var(--mj-accent-ice)' }}>MJ Assistant</span>.
                </h2>
                <p
                  className="mx-auto mt-1.5 max-w-md text-xs leading-relaxed sm:text-sm"
                  style={{ color: 'var(--mj-text-muted)' }}
                >
                  Press <strong>Talk</strong> for realtime bidirectional speech or type below in English, বাংলা, or Banglish.
                </p>

                <div className="mt-6 grid grid-cols-1 gap-2.5 text-left sm:grid-cols-2">
                  {STARTER_PROMPTS.map((prompt) => (
                    <button
                      key={prompt}
                      type="button"
                      disabled={isTextBusy}
                      onClick={() => onSendMessage(prompt)}
                      className="rounded-xl p-3.5 text-xs leading-relaxed transition hover:-translate-y-0.5 disabled:opacity-50"
                      style={{
                        backgroundColor: 'rgba(18, 23, 34, 0.72)',
                        border: '1px solid var(--mj-border-subtle)',
                        color: 'var(--mj-text-secondary)',
                      }}
                    >
                      {prompt}
                    </button>
                  ))}
                </div>
              </div>
            ) : (
              <>
                {messages.map((msg) => {
                  const isUser = msg.role === 'user';
                  const isLastAssistant = msg.id === lastAssistantId;
                  const isCopied = copiedMessageId === msg.id;

                  if (isUser) {
                    return (
                      <div key={msg.id} className="flex flex-col items-end gap-1">
                        {msg.channel === 'voice' && (
                          <span
                            className="inline-flex items-center gap-1 text-[10px] uppercase tracking-[0.12em]"
                            style={{ color: 'var(--mj-text-subtle)' }}
                          >
                            <Mic className="h-3 w-3" /> Voice transcript
                          </span>
                        )}
                        <div
                          className={`max-w-[85%] rounded-2xl rounded-br-sm text-sm leading-relaxed whitespace-pre-wrap break-words ${
                            compact ? 'px-3.5 py-2.5' : 'px-4 py-3'
                          }`}
                          style={{
                            background:
                              'linear-gradient(145deg, rgba(124, 171, 201, 0.16), rgba(92, 138, 170, 0.1))',
                            border: '1px solid rgba(156, 198, 225, 0.24)',
                            color: '#E5F2FC',
                          }}
                        >
                          {msg.content}
                        </div>
                      </div>
                    );
                  }

                  return (
                    <div key={msg.id} className="flex justify-start">
                      <Panel
                        className={`w-full max-w-[95%] rounded-2xl rounded-bl-sm ${
                          compact ? 'p-3.5' : 'p-4 sm:p-5'
                        }`}
                      >
                        <div className="mb-2 flex flex-wrap items-center justify-between gap-2 text-[11px]">
                          <div className="flex items-center gap-2">
                            <span className="font-medium text-[#C7E3F5]">MJ Assistant</span>
                            {msg.channel === 'voice' && (
                              <span
                                className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px]"
                                style={{
                                  backgroundColor: 'rgba(127, 209, 174, 0.1)',
                                  color: 'var(--mj-status-good)',
                                }}
                              >
                                <AudioLines className="h-3 w-3" /> Voice
                              </span>
                            )}
                            {msg.model && (
                              <span
                                className="rounded px-1.5 py-0.5 font-mono text-[10px]"
                                style={{
                                  backgroundColor: 'rgba(255, 255, 255, 0.04)',
                                  color: 'var(--mj-text-subtle)',
                                }}
                              >
                                {msg.model}
                              </span>
                            )}
                            {msg.status === 'streaming' && (
                              <span style={{ color: 'var(--mj-accent-blue)' }}>Streaming…</span>
                            )}
                            {msg.status === 'aborted' && (
                              <span style={{ color: 'var(--mj-status-warn)' }}>Stopped</span>
                            )}
                            {msg.status === 'error' && (
                              <span style={{ color: 'var(--mj-status-error)' }}>
                                Interrupted ({msg.errorCode ?? 'ERROR'})
                              </span>
                            )}
                          </div>

                          {msg.status !== 'streaming' && (
                            <div className="flex items-center gap-1.5">
                              {msg.content && settings?.voice.voiceOutputEnabled && (
                                <button
                                  type="button"
                                  onClick={() => onSpeakText(msg.content)}
                                  className="inline-flex items-center gap-1 rounded-lg px-2 py-1 text-[11px] transition hover:bg-white/5"
                                  style={{ color: 'var(--mj-text-muted)' }}
                                  aria-label="Read response aloud"
                                >
                                  <Volume2 className="h-3.5 w-3.5" />
                                  <span>Read aloud</span>
                                </button>
                              )}

                              {msg.content && (
                                <button
                                  type="button"
                                  onClick={() => void handleCopyMessage(msg)}
                                  className="inline-flex items-center gap-1 rounded-lg px-2 py-1 text-[11px] transition hover:bg-white/5"
                                  style={{
                                    color: isCopied
                                      ? 'var(--mj-status-good)'
                                      : 'var(--mj-text-muted)',
                                  }}
                                  aria-label="Copy response"
                                >
                                  {isCopied ? (
                                    <Check className="h-3.5 w-3.5" />
                                  ) : (
                                    <Copy className="h-3.5 w-3.5" />
                                  )}
                                  <span>{isCopied ? 'Copied' : 'Copy'}</span>
                                </button>
                              )}

                              {isLastAssistant && !isTextBusy && msg.channel === 'text' && (
                                <button
                                  type="button"
                                  onClick={onRegenerate}
                                  className="inline-flex items-center gap-1 rounded-lg px-2 py-1 text-[11px] transition hover:bg-white/5"
                                  style={{ color: 'var(--mj-text-muted)' }}
                                  aria-label="Regenerate response"
                                >
                                  <RotateCcw className="h-3.5 w-3.5" />
                                  <span>Regenerate</span>
                                </button>
                              )}
                            </div>
                          )}
                        </div>

                        {msg.content ? (
                          <MarkdownMessage content={msg.content} />
                        ) : msg.status === 'streaming' ? (
                          <div
                            className="flex items-center gap-2 text-xs"
                            style={{ color: 'var(--mj-text-muted)' }}
                          >
                            <span className="inline-block h-2 w-2 animate-pulse rounded-full bg-[#9AC6E6]" />
                            <span>{streamStatusDetail}</span>
                          </div>
                        ) : (
                          <div className="text-xs italic" style={{ color: 'var(--mj-text-subtle)' }}>
                            No output was received before this turn ended.
                          </div>
                        )}

                        {(msg.outputTokens || msg.latencyMs) && msg.status === 'completed' ? (
                          <div
                            className="mt-3 flex flex-wrap items-center gap-3 border-t pt-2 font-mono text-[10px]"
                            style={{
                              borderColor: 'var(--mj-border-subtle)',
                              color: 'var(--mj-text-subtle)',
                            }}
                          >
                            {msg.inputTokens !== null && msg.inputTokens !== undefined && (
                              <span>in: {msg.inputTokens}</span>
                            )}
                            {msg.outputTokens !== null && msg.outputTokens !== undefined && (
                              <span>out: {msg.outputTokens}</span>
                            )}
                            {msg.reasoningTokens ? <span>reasoning: {msg.reasoningTokens}</span> : null}
                            {msg.latencyMs ? <span>{msg.latencyMs}ms</span> : null}
                            {msg.estimatedCostUsd !== null && msg.estimatedCostUsd !== undefined && (
                              <span>est: ${msg.estimatedCostUsd.toFixed(5)}</span>
                            )}
                          </div>
                        ) : null}
                      </Panel>
                    </div>
                  );
                })}

                {/* In-progress Voice Transcript Bubbles */}
                {liveUserTranscript && (
                  <div className="flex justify-end">
                    <div
                      className="max-w-[85%] rounded-2xl px-4 py-2.5 text-sm italic"
                      style={{
                        backgroundColor: 'rgba(124, 171, 201, 0.1)',
                        border: '1px dashed rgba(156, 198, 225, 0.28)',
                        color: '#C7E3F5',
                      }}
                    >
                      {liveUserTranscript}
                    </div>
                  </div>
                )}
                {liveAssistantTranscript && (
                  <div className="flex justify-start">
                    <Panel className="w-full max-w-[95%] rounded-2xl p-4">
                      <div className="mb-1 text-[11px]" style={{ color: 'var(--mj-status-good)' }}>
                        MJ Assistant (Speaking…)
                      </div>
                      <MarkdownMessage content={liveAssistantTranscript} />
                    </Panel>
                  </div>
                )}
              </>
            )}

            {/* Centralized Error Banner */}
            {activeError && (
              <div
                role="alert"
                className="flex flex-wrap items-center justify-between gap-3 rounded-2xl px-4 py-3 text-xs"
                style={{
                  backgroundColor: 'rgba(240, 138, 138, 0.09)',
                  border: '1px solid rgba(240, 138, 138, 0.3)',
                }}
              >
                <div className="min-w-0 flex-1 space-y-0.5">
                  <div className="font-mono text-[11px]" style={{ color: 'var(--mj-status-error)' }}>
                    {activeError.code}
                    {activeError.requestId ? ` · req ${activeError.requestId}` : ''}
                  </div>
                  <div className="text-xs text-[#FBE4E4]">{activeError.message}</div>
                </div>
                {repeatErrorHint ? (
                  <span
                    className="rounded-xl px-3 py-1.5 text-[11px] font-medium"
                    style={{
                      backgroundColor: 'rgba(227, 190, 126, 0.12)',
                      border: '1px solid rgba(227, 190, 126, 0.32)',
                      color: 'var(--mj-status-warn)',
                    }}
                  >
                    {repeatErrorHint}
                  </span>
                ) : (
                  activeError.retryable && (
                    <button
                      type="button"
                      onClick={onRetryLast}
                      className="inline-flex items-center gap-1.5 rounded-xl px-3 py-1.5 text-xs font-medium transition hover:bg-white/10"
                      style={{
                        border: '1px solid rgba(240, 138, 138, 0.38)',
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
              <ToolConfirmationBanner
                confirmation={pendingConfirmation}
                onConfirm={onConfirmToolAction}
                onCancel={onCancelToolAction}
              />
            )}

            <WebSourcesBar sources={webSearchSources} />

            <div ref={threadEndRef} />
          </div>
        </div>

        {/* Composer Footer */}
        <footer
          className="border-t px-4 py-3.5 sm:px-6"
          style={{
            backgroundColor: 'rgba(7, 8, 11, 0.88)',
            borderColor: 'var(--mj-border-subtle)',
            backdropFilter: 'blur(16px)',
          }}
        >
          <form
            onSubmit={handleSubmit}
            className="mx-auto flex w-full max-w-3xl items-end gap-2.5 rounded-2xl px-4 py-2.5"
            style={{
              backgroundColor: 'rgba(13, 16, 23, 0.92)',
              border: '1px solid rgba(181, 210, 232, 0.18)',
            }}
          >
            <textarea
              ref={textareaRef}
              rows={1}
              value={composerText}
              onChange={(e) => setComposerText(e.target.value)}
              onPaste={(e) => {
                const pasted = e.clipboardData?.getData('text/plain')?.trim();
                if (pasted && onSyncAppClipboard) {
                  void onSyncAppClipboard(pasted);
                }
              }}
              onKeyDown={handleKeyDown}
              placeholder="Message MJ Assistant… (Enter to send, Shift+Enter for new line)"
              aria-label="Message MJ Assistant"
              disabled={isTextBusy}
              className="max-h-44 min-w-0 flex-1 resize-none bg-transparent py-1.5 text-sm text-[#EDF3F8] outline-none placeholder:text-[#8B9CB0] disabled:opacity-60"
            />
            {appClipboardText && (
              <span
                className="hidden sm:inline-block rounded-lg px-2 py-1 text-[10px]"
                title={appClipboardText}
                style={{
                  backgroundColor: 'rgba(154, 198, 230, 0.08)',
                  color: 'var(--mj-text-subtle)',
                }}
              >
                App clipboard ({appClipboardText.length} chars)
              </span>
            )}

            {isTextBusy ? (
              <button
                type="button"
                onClick={onStopStream}
                aria-label="Stop generation"
                className="inline-flex shrink-0 items-center gap-1.5 rounded-xl px-3.5 py-2 text-xs font-medium transition"
                style={{
                  backgroundColor: 'rgba(240, 138, 138, 0.16)',
                  border: '1px solid rgba(240, 138, 138, 0.36)',
                  color: 'var(--mj-status-error)',
                }}
              >
                <Square className="h-3.5 w-3.5 fill-current" />
                <span>Stop</span>
              </button>
            ) : (
              <button
                type="submit"
                disabled={!composerText.trim()}
                aria-label="Send message"
                className="grid h-9 w-9 shrink-0 place-items-center rounded-xl transition disabled:cursor-not-allowed disabled:opacity-40"
                style={{
                  background: 'linear-gradient(145deg, #DCEEF9, #9AC6E6)',
                  color: '#070B11',
                }}
              >
                <Send className="h-4 w-4" />
              </button>
            )}
          </form>
        </footer>
      </div>
    </div>
  );
}

function formatShortDate(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  return date.toLocaleDateString([], { month: 'short', day: 'numeric' });
}
