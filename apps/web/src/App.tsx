import { Suspense, lazy, useCallback, useEffect, useRef, useState } from 'react';
import {
  DEFAULT_PERMISSIONS_STATE,
  ErrorCodes,
  VoiceStates,
  acceleratorFromKeyboardEvent,
  type AllowlistEntryDTO,
  type AllowlistKind,
  type AuditLogEntryDTO,
  type AuthSessionDTO,
  type ChatStreamEvent,
  type ConfigurableShortcutDTO,
  type ConnectivityCheckDTO,
  type ControllablePermissionKey,
  type ConversationDTO,
  type LanguageMode,
  type MessageDTO,
  type PermissionsStateDTO,
  type PublicSettingsDTO,
  type StructuredErrorPayload,
  type SystemHealthDTO,
  type UsageSummaryDTO,
  type VoiceState,
} from '@mj/shared';
import { MjVoiceService, VOICE_STATE_META } from '@mj/voice';
import { ApiClientError, mjApi } from './api/client.js';
import { MicActiveBanner } from './components/MicActiveBanner.js';
import { Sidebar, type ActiveNavTab } from './components/Sidebar.js';
import {
  isTauriDesktop,
  syncTauriMicTray,
  tauriOpenApprovedApp,
  tauriOpenApprovedUrl,
  tauriRevokeAllPermissions,
  tauriSetSinglePermission,
  tauriValidateShortcutTrigger,
} from './desktop/desktopBridge.js';
import { WakeWordListener } from './voice/wakeWordListener.js';
import {
  isFreeBrowserVoiceSupported,
  speakWithBrowserSpeechSynthesis,
  startFreeBrowserVoiceSession,
  type FreeBrowserVoiceController,
} from './voice/freeBrowserVoice.js';

const HomeDashboard = lazy(() =>
  import('./components/HomeDashboard.js').then((m) => ({ default: m.HomeDashboard })),
);
const UnlockGate = lazy(() =>
  import('./components/UnlockGate.js').then((m) => ({ default: m.UnlockGate })),
);
const ChatWorkspace = lazy(() =>
  import('./components/ChatWorkspace.js').then((m) => ({ default: m.ChatWorkspace })),
);
const DesktopView = lazy(() =>
  import('./components/DesktopView.js').then((m) => ({ default: m.DesktopView })),
);
const PrivacyCenterView = lazy(() =>
  import('./components/PrivacyCenterView.js').then((m) => ({ default: m.PrivacyCenterView })),
);
const UsageDashboardView = lazy(() =>
  import('./components/UsageDashboardView.js').then((m) => ({ default: m.UsageDashboardView })),
);
const SettingsView = lazy(() =>
  import('./components/SettingsView.js').then((m) => ({ default: m.SettingsView })),
);

export function App() {
  const [activeTab, setActiveTab] = useState<ActiveNavTab>('home');
  const [interactionMode, setInteractionMode] = useState<'voice' | 'text'>('voice');
  const [online, setOnline] = useState(() => navigator.onLine);
  const [session, setSession] = useState<AuthSessionDTO | null>(null);
  const [authLoading, setAuthLoading] = useState(true);
  const [authError, setAuthError] = useState<string | null>(null);

  const [health, setHealth] = useState<SystemHealthDTO | null>(null);
  const [backendLatencyMs, setBackendLatencyMs] = useState<number | null>(null);
  const [connectivityCheck, setConnectivityCheck] = useState<ConnectivityCheckDTO | null>(null);
  const [checkingConnectivity, setCheckingConnectivity] = useState(false);
  const [settings, setSettings] = useState<PublicSettingsDTO | null>(null);
  const [usage, setUsage] = useState<UsageSummaryDTO | null>(null);
  const [availableVoices, setAvailableVoices] = useState<
    Array<{ id: string; label: string; description: string }>
  >([]);

  const [conversations, setConversations] = useState<ConversationDTO[]>([]);
  const [searchQuery, setSearchQuery] = useState('');
  const [activeConversation, setActiveConversation] = useState<ConversationDTO | null>(null);
  const [messages, setMessages] = useState<MessageDTO[]>([]);
  const [selectedProviderOverride, setSelectedProviderOverride] = useState<string>('auto');
  const [selectedModelOverride, setSelectedModelOverride] = useState('');

  const [streamingState, setStreamingState] = useState<
    'idle' | 'connecting' | 'streaming' | 'error'
  >('idle');
  const [streamStatusDetail, setStreamStatusDetail] = useState('Standing by');

  const [voiceState, setVoiceState] = useState<VoiceState>(VoiceStates.IDLE);
  const [voiceDetail, setVoiceDetail] = useState(VOICE_STATE_META.idle.description);
  const [voiceMuted, setVoiceMuted] = useState(false);
  const [voiceAudioLevel, setVoiceAudioLevel] = useState(0);
  const [liveUserTranscript, setLiveUserTranscript] = useState('');
  const [liveAssistantTranscript, setLiveAssistantTranscript] = useState('');
  const [hasLastResponseToSpeak, setHasLastResponseToSpeak] = useState(false);

  const [permissions, setPermissions] = useState<PermissionsStateDTO>(DEFAULT_PERMISSIONS_STATE);
  const [allowlist, setAllowlist] = useState<AllowlistEntryDTO[]>([]);
  const [shortcuts, setShortcuts] = useState<ConfigurableShortcutDTO[]>([]);
  const [auditLogs, setAuditLogs] = useState<AuditLogEntryDTO[]>([]);
  const [wakeWordActive, setWakeWordActive] = useState(false);
  const [wakeWordStatusMessage, setWakeWordStatusMessage] = useState(
    'Wake-word standby is OFF.',
  );

  const [activeError, setActiveError] = useState<StructuredErrorPayload | null>(null);
  const [lastRetryAction, setLastRetryAction] = useState<(() => void) | null>(null);
  const [latestHomeExchange, setLatestHomeExchange] = useState<{
    conversationId: string;
    userPrompt: string;
    assistantMessage: MessageDTO | null;
  } | null>(null);

  const streamAbortRef = useRef<AbortController | null>(null);
  const voiceServiceRef = useRef<MjVoiceService | null>(null);
  const freeVoiceRef = useRef<FreeBrowserVoiceController | null>(null);
  const wakeListenerRef = useRef<WakeWordListener | null>(null);
  const startVoiceRef = useRef<() => Promise<void>>(async () => { });
  const freeVoiceFallbackRef = useRef<() => Promise<void>>(async () => { });
  const browserTtsFallbackRef = useRef<(text: string) => boolean>(() => false);
  const permissionsRef = useRef<PermissionsStateDTO>(DEFAULT_PERMISSIONS_STATE);
  const activeConversationRef = useRef<ConversationDTO | null>(null);
  const settingsRef = useRef<PublicSettingsDTO | null>(null);

  useEffect(() => {
    permissionsRef.current = permissions;
  }, [permissions]);

  useEffect(() => {
    activeConversationRef.current = activeConversation;
  }, [activeConversation]);

  useEffect(() => {
    settingsRef.current = settings;
    voiceServiceRef.current?.updateOptions({
      voiceId: settings?.voice.voiceId ?? 'ara',
      languageMode: settings?.voice.languageMode ?? 'auto',
      speakingRate: settings?.voice.speakingRate ?? 1.0,
      volume: settings?.voice.volume ?? 0.9,
      voiceOutputEnabled: settings?.voice.voiceOutputEnabled ?? true,
    });
  }, [settings]);

  // Sync reduced motion preference to <html data-motion="...">
  useEffect(() => {
    const mode = settings?.reducedMotionOverride ?? 'system';
    document.documentElement.setAttribute('data-motion', mode);
  }, [settings?.reducedMotionOverride]);

  // Browser online/offline tracking
  useEffect(() => {
    const onOnline = () => setOnline(true);
    const onOffline = () => setOnline(false);
    window.addEventListener('online', onOnline);
    window.addEventListener('offline', onOffline);
    return () => {
      window.removeEventListener('online', onOnline);
      window.removeEventListener('offline', onOffline);
    };
  }, []);

  const ensureActiveConversationId = useCallback(async (): Promise<string> => {
    if (activeConversationRef.current) {
      return activeConversationRef.current.id;
    }
    const { conversation } = await mjApi.createConversation({
      model: selectedModelOverride || settingsRef.current?.activeModel,
    });
    activeConversationRef.current = conversation;
    setActiveConversation(conversation);
    setConversations((prev) => [conversation, ...prev]);
    return conversation.id;
  }, [selectedModelOverride]);

  // Initialize independent Voice Service (Section 03)
  useEffect(() => {
    const service = new MjVoiceService(
      {
        fetchClientSecret: async () => {
          const convId = activeConversationRef.current?.id;
          return mjApi.requestVoiceClientSecret({
            ...(convId ? { conversationId: convId } : {}),
          });
        },
        fetchTtsAudio: async (text, signal) => {
          const s = settingsRef.current;
          return mjApi.fetchTtsAudio(
            text,
            {
              voiceId: s?.voice.voiceId,
              languageMode: s?.voice.languageMode,
            },
            signal,
          );
        },
        onStateChange: (nextState, detail) => {
          setVoiceState(nextState);
          setVoiceDetail(detail);
          if (nextState === VoiceStates.IDLE) {
            setLiveUserTranscript('');
            setLiveAssistantTranscript('');
          }
        },
        onMuteChange: (muted) => {
          setVoiceMuted(muted);
        },
        onAudioLevel: ({ inputLevel, outputLevel }) => {
          setVoiceAudioLevel(Math.max(inputLevel, outputLevel));
        },
        onUserTranscript: (transcript) => {
          setLiveUserTranscript(transcript);
          void (async () => {
            try {
              const convId = await ensureActiveConversationId();
              const res = await mjApi.saveVoiceTurn(convId, {
                role: 'user',
                content: transcript,
                model: settingsRef.current?.voice.voiceModel,
              });
              setMessages((prev) => [...prev, res.message]);
              setActiveConversation(res.conversation);
              setConversations((prev) => {
                const rest = prev.filter((c) => c.id !== res.conversation.id);
                return [res.conversation, ...rest];
              });
              setLiveUserTranscript('');
            } catch {
              // ignore background persistence failure
            }
          })();
        },
        onAssistantTranscriptDelta: (delta) => {
          setLiveAssistantTranscript((prev) => prev + delta);
        },
        onAssistantTranscriptDone: (fullText) => {
          setHasLastResponseToSpeak(true);
          setLiveAssistantTranscript('');
          void (async () => {
            try {
              const convId = await ensureActiveConversationId();
              const res = await mjApi.saveVoiceTurn(convId, {
                role: 'assistant',
                content: fullText,
                model: settingsRef.current?.voice.voiceModel,
              });
              setMessages((prev) => [...prev, res.message]);
              setActiveConversation(res.conversation);
              setConversations((prev) => {
                const rest = prev.filter((c) => c.id !== res.conversation.id);
                return [res.conversation, ...rest];
              });
            } catch {
              // ignore background persistence failure
            }
          })();
        },
        onFreeFallbackRequested: () => {
          if (
            permissionsRef.current.microphoneAccess &&
            permissionsRef.current.voiceSessionAccess
          ) {
            void freeVoiceFallbackRef.current();
          }
        },
        onTtsFallbackRequested: (text) => browserTtsFallbackRef.current(text),
        onError: (errPayload) => {
          if (
            (errPayload.code === ErrorCodes.INSUFFICIENT_CREDITS ||
              errPayload.code === ErrorCodes.INVALID_API_KEY ||
              errPayload.code === ErrorCodes.UNAUTHORIZED ||
              errPayload.code === ErrorCodes.VOICE_SERVICE_UNAVAILABLE ||
              errPayload.code === ErrorCodes.WEBSOCKET_CONNECTION_FAILED) &&
            permissionsRef.current.microphoneAccess &&
            permissionsRef.current.voiceSessionAccess
          ) {
            void freeVoiceFallbackRef.current();
            return;
          }
          setActiveError(errPayload);
        },
        onSessionEnded: (summary) => {
          void (async () => {
            try {
              if (summary.durationSeconds > 0) {
                await mjApi.recordVoiceUsage({
                  ...(activeConversationRef.current?.id
                    ? { conversationId: activeConversationRef.current.id }
                    : {}),
                  model:
                    summary.modelUsed ??
                    settingsRef.current?.voice.voiceModel ??
                    'gemini-2.5-flash-native-audio-preview-12-2025',
                  durationSeconds: summary.durationSeconds,
                  status: summary.status,
                  errorCode: summary.errorCode,
                });
                const refreshed = await mjApi.getUsage();
                setUsage(refreshed);
              }
            } catch {
              // ignore usage sync failure
            }
          })();
        },
      },
      {
        voiceId: 'ara',
        languageMode: 'auto',
        speakingRate: 1.0,
        volume: 0.9,
        voiceOutputEnabled: true,
      },
    );

    voiceServiceRef.current = service;

    return () => {
      freeVoiceRef.current?.stop();
      freeVoiceRef.current = null;
      void service.stopSession('manual');
      voiceServiceRef.current = null;
    };
  }, [ensureActiveConversationId]);

  const loadHealth = useCallback(async () => {
    const started = performance.now();
    try {
      const h = await mjApi.getHealth();
      setHealth(h);
      setBackendLatencyMs(Math.max(1, Math.round(performance.now() - started)));
    } catch {
      setHealth(null);
      setBackendLatencyMs(null);
    }
  }, []);

  const handleCheckConnectivity = useCallback(async () => {
    setCheckingConnectivity(true);
    try {
      const result = await mjApi.checkUsageConnectivity();
      setConnectivityCheck(result);
    } catch (err) {
      const payload: StructuredErrorPayload =
        err instanceof ApiClientError
          ? err.payload
          : {
            code: ErrorCodes.NETWORK_DISCONNECTED,
            category: 'network',
            statusCode: 503,
            message: err instanceof Error ? err.message : 'Connectivity check failed.',
            retryable: true,
          };
      setActiveError(payload);
    } finally {
      setCheckingConnectivity(false);
    }
  }, []);

  const refreshAuditLogs = useCallback(async () => {
    try {
      const res = await mjApi.listAuditLogs();
      setAuditLogs(res.entries);
    } catch {
      // ignore background audit refresh failure
    }
  }, []);

  const refreshShortcuts = useCallback(async () => {
    try {
      const res = await mjApi.listDesktopShortcuts();
      setShortcuts(res.shortcuts);
    } catch {
      // ignore background shortcuts refresh failure
    }
  }, []);

  const loadAuthenticatedWorkspace = useCallback(async () => {
    const [settingsRes, usageRes, convRes, voicesRes, permRes, allowRes, auditRes, shortcutRes] =
      await Promise.all([
        mjApi.getSettings(),
        mjApi.getUsage(),
        mjApi.listConversations(),
        mjApi.getAvailableVoices().catch(() => ({ voices: [] })),
        mjApi.getPrivacyPermissions(),
        mjApi.listAllowlist(),
        mjApi.listAuditLogs(),
        mjApi.listDesktopShortcuts(),
      ]);
    setSettings(settingsRes);
    setSelectedProviderOverride(settingsRes.activeProvider ?? 'auto');
    setSelectedModelOverride(settingsRes.activeModel);
    setUsage(usageRes);
    setConversations(convRes.conversations);
    setPermissions(permRes.permissions);
    setAllowlist(allowRes.entries);
    setAuditLogs(auditRes.entries);
    setShortcuts(shortcutRes.shortcuts);
    if (voicesRes.voices.length > 0) {
      setAvailableVoices(voicesRes.voices);
    }
    if (convRes.conversations[0]) {
      const detail = await mjApi.getConversation(convRes.conversations[0].id);
      setActiveConversation(detail.conversation);
      setMessages(detail.messages);
      const lastAssistant = [...detail.messages].reverse().find((m) => m.role === 'assistant');
      if (lastAssistant?.content) {
        voiceServiceRef.current?.setLastAssistantText(lastAssistant.content);
        setHasLastResponseToSpeak(true);
      }
    }
  }, []);

  // Bootstrap session & workspace on mount
  useEffect(() => {
    let cancelled = false;

    const init = async () => {
      await loadHealth();
      try {
        let sess = await mjApi.getSession();
        if (!sess.authenticated && !sess.passcodeRequired && sess.mode === 'local-dev') {
          sess = await mjApi.login();
        }
        if (cancelled) return;
        setSession(sess);
        if (sess.authenticated) {
          await loadAuthenticatedWorkspace();
        }
      } catch (err) {
        if (!cancelled) {
          setAuthError(
            err instanceof Error ? err.message : 'Unable to reach MJ backend server.',
          );
        }
      } finally {
        if (!cancelled) setAuthLoading(false);
      }
    };

    void init();

    const healthTimer = setInterval(() => {
      void loadHealth();
    }, 30_000);

    return () => {
      cancelled = true;
      clearInterval(healthTimer);
    };
  }, [loadAuthenticatedWorkspace, loadHealth]);

  // Debounced conversation search
  useEffect(() => {
    if (!session?.authenticated) return;
    const timer = setTimeout(async () => {
      try {
        const res = await mjApi.listConversations(searchQuery);
        setConversations(res.conversations);
      } catch {
        // ignore search errors while typing
      }
    }, 180);
    return () => clearTimeout(timer);
  }, [searchQuery, session?.authenticated]);

  const handleLogin = async (passcode: string) => {
    setAuthError(null);
    try {
      const sess = await mjApi.login(passcode);
      setSession(sess);
      await loadAuthenticatedWorkspace();
    } catch (err) {
      setAuthError(err instanceof Error ? err.message : 'Authentication failed.');
    }
  };

  const handleLogout = async () => {
    streamAbortRef.current?.abort();
    wakeListenerRef.current?.stop();
    freeVoiceRef.current?.stop();
    freeVoiceRef.current = null;
    await voiceServiceRef.current?.stopSession('manual');
    const sess = await mjApi.logout();
    setSession(sess);
    setConversations([]);
    setActiveConversation(null);
    setMessages([]);
    setPermissions(DEFAULT_PERMISSIONS_STATE);
    setAllowlist([]);
    setShortcuts([]);
    setAuditLogs([]);
  };

  const handleSelectConversation = async (id: string) => {
    setActiveError(null);
    const detail = await mjApi.getConversation(id);
    setActiveConversation(detail.conversation);
    setMessages(detail.messages);
    const lastAssistant = [...detail.messages].reverse().find((m) => m.role === 'assistant');
    if (lastAssistant?.content) {
      voiceServiceRef.current?.setLastAssistantText(lastAssistant.content);
      setHasLastResponseToSpeak(true);
    }
  };

  const handleCreateConversation = async () => {
    setActiveError(null);
    const { conversation } = await mjApi.createConversation({
      model: selectedModelOverride || settings?.activeModel,
    });
    setActiveConversation(conversation);
    setMessages([]);
    setConversations((prev) => [conversation, ...prev]);
  };

  const handleRenameConversation = async (id: string, title: string) => {
    const { conversation } = await mjApi.renameConversation(id, title);
    setConversations((prev) => prev.map((c) => (c.id === id ? conversation : c)));
    if (activeConversation?.id === id) {
      setActiveConversation(conversation);
    }
  };

  const handleDeleteConversation = async (id: string) => {
    await mjApi.deleteConversation(id);
    const remaining = conversations.filter((c) => c.id !== id);
    setConversations(remaining);
    if (activeConversation?.id === id) {
      if (remaining[0]) {
        await handleSelectConversation(remaining[0].id);
      } else {
        setActiveConversation(null);
        setMessages([]);
      }
    }
  };

  const runStream = async (options: {
    mode: 'send' | 'regenerate';
    conversationId: string;
    promptText?: string;
    fromHome?: boolean;
    skipAutoTts?: boolean;
  }): Promise<string> => {
    streamAbortRef.current?.abort();
    const abortController = new AbortController();
    streamAbortRef.current = abortController;

    setActiveError(null);
    setStreamingState('connecting');
    setStreamStatusDetail('Connecting to AI provider…');

    const modelToUse = selectedModelOverride || settings?.activeModel;
    const providerToUse = (selectedProviderOverride || settings?.activeProvider) as
      | import('@mj/shared').AiProviderId
      | undefined;

    const tempUserId = `temp-user-${Date.now()}`;
    const tempAssistantId = `temp-assistant-${Date.now()}`;
    let realAssistantId = tempAssistantId;
    let finalAssistantText = '';

    if (options.mode === 'send' && options.promptText) {
      const nowIso = new Date().toISOString();
      const optimisticUser: MessageDTO = {
        id: tempUserId,
        conversationId: options.conversationId,
        role: 'user',
        content: options.promptText,
        channel: 'text',
        status: 'completed',
        createdAt: nowIso,
      };
      const optimisticAssistant: MessageDTO = {
        id: tempAssistantId,
        conversationId: options.conversationId,
        role: 'assistant',
        content: '',
        channel: 'text',
        status: 'streaming',
        model: modelToUse,
        createdAt: nowIso,
      };

      setMessages((prev) => [...prev, optimisticUser, optimisticAssistant]);
      if (options.fromHome) {
        setLatestHomeExchange({
          conversationId: options.conversationId,
          userPrompt: options.promptText,
          assistantMessage: optimisticAssistant,
        });
      }
    } else if (options.mode === 'regenerate') {
      const nowIso = new Date().toISOString();
      const optimisticAssistant: MessageDTO = {
        id: tempAssistantId,
        conversationId: options.conversationId,
        role: 'assistant',
        content: '',
        channel: 'text',
        status: 'streaming',
        model: modelToUse,
        createdAt: nowIso,
      };
      setMessages((prev) => {
        const copy = [...prev];
        if (copy[copy.length - 1]?.role === 'assistant') {
          copy.pop();
        }
        return [...copy, optimisticAssistant];
      });
    }

    const handleEvent = (event: ChatStreamEvent) => {
      if (event.type === 'meta') {
        realAssistantId = event.assistantMessageId;
        setMessages((prev) =>
          prev.map((m) => {
            if (m.id === tempUserId) return { ...m, id: event.userMessageId };
            if (m.id === tempAssistantId) {
              return { ...m, id: event.assistantMessageId, model: event.model };
            }
            return m;
          }),
        );

        if (event.conversationTitle) {
          setActiveConversation((prev) =>
            prev && prev.id === event.conversationId
              ? { ...prev, title: event.conversationTitle! }
              : prev,
          );
          setConversations((prev) =>
            prev.map((c) =>
              c.id === event.conversationId ? { ...c, title: event.conversationTitle! } : c,
            ),
          );
        }
      } else if (event.type === 'status') {
        setStreamingState(event.phase === 'streaming' ? 'streaming' : 'connecting');
        setStreamStatusDetail(event.detail);
      } else if (event.type === 'delta') {
        finalAssistantText += event.text;
        setStreamingState('streaming');
        setStreamStatusDetail('Streaming response…');
        setMessages((prev) =>
          prev.map((m) =>
            m.id === realAssistantId || m.id === tempAssistantId
              ? { ...m, content: m.content + event.text, status: 'streaming' }
              : m,
          ),
        );
        if (options.fromHome) {
          setLatestHomeExchange((prev) =>
            prev
              ? {
                ...prev,
                assistantMessage: prev.assistantMessage
                  ? {
                    ...prev.assistantMessage,
                    content: prev.assistantMessage.content + event.text,
                  }
                  : {
                    id: realAssistantId,
                    conversationId: options.conversationId,
                    role: 'assistant',
                    content: event.text,
                    channel: 'text',
                    status: 'streaming',
                    createdAt: new Date().toISOString(),
                  },
              }
              : prev,
          );
        }
      } else if (event.type === 'done') {
        setStreamingState('idle');
        setStreamStatusDetail('Standing by');
        setMessages((prev) =>
          prev.map((m) =>
            m.id === event.message.id || m.id === tempAssistantId ? event.message : m,
          ),
        );
        setActiveConversation(event.conversation);
        setConversations((prev) => {
          const exists = prev.some((c) => c.id === event.conversation.id);
          const updated = exists
            ? prev.map((c) => (c.id === event.conversation.id ? event.conversation : c))
            : [event.conversation, ...prev];
          return [...updated].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
        });
        if (options.fromHome) {
          setLatestHomeExchange((prev) =>
            prev ? { ...prev, assistantMessage: event.message } : prev,
          );
        }
        if (event.message.content) {
          finalAssistantText = event.message.content;
          voiceServiceRef.current?.setLastAssistantText(event.message.content);
          setHasLastResponseToSpeak(true);
          if (
            !options.skipAutoTts &&
            settingsRef.current?.voice.autoPlayback &&
            settingsRef.current?.voice.voiceOutputEnabled
          ) {
            void voiceServiceRef.current?.speakTextViaTts(event.message.content);
          }
        }
      } else if (event.type === 'error') {
        setStreamingState('error');
        setStreamStatusDetail('Connection interrupted');
        setActiveError(event.error);
        if (event.partialMessage) {
          setMessages((prev) =>
            prev.map((m) =>
              m.id === event.partialMessage!.id || m.id === tempAssistantId
                ? event.partialMessage!
                : m,
            ),
          );
        }
      }
    };

    try {
      if (options.mode === 'send' && options.promptText) {
        await mjApi.streamChat(
          options.conversationId,
          { content: options.promptText, model: modelToUse, provider: providerToUse },
          { onEvent: handleEvent },
          abortController.signal,
        );
      } else {
        await mjApi.regenerateLastTurn(
          options.conversationId,
          { model: modelToUse, provider: providerToUse },
          { onEvent: handleEvent },
          abortController.signal,
        );
      }

      if (abortController.signal.aborted) {
        setStreamingState('idle');
        setStreamStatusDetail('Generation stopped');
        setMessages((prev) =>
          prev.map((m) =>
            m.id === realAssistantId || m.id === tempAssistantId
              ? { ...m, status: 'aborted' }
              : m,
          ),
        );
      }
      return finalAssistantText;
    } catch (err) {
      if (abortController.signal.aborted) {
        setStreamingState('idle');
        setStreamStatusDetail('Generation stopped');
        return finalAssistantText;
      }

      const payload: StructuredErrorPayload =
        err instanceof ApiClientError
          ? err.payload
          : {
            code: ErrorCodes.INTERNAL_ERROR,
            category: 'internal',
            statusCode: 500,
            message: err instanceof Error ? err.message : 'Unexpected failure.',
            retryable: true,
          };

      setStreamingState('error');
      setStreamStatusDetail('Error encountered');
      setActiveError(payload);

      setMessages((prev) =>
        prev.filter((m) => m.id !== tempUserId && m.id !== tempAssistantId),
      );
      return '';
    } finally {
      try {
        const refreshedUsage = await mjApi.getUsage();
        setUsage(refreshedUsage);
      } catch {
        // ignore background usage refresh failure
      }
    }
  };

  const sendMessageFromChat = async (content: string) => {
    const convId = await ensureActiveConversationId();
    setLastRetryAction(() => () => {
      void runStream({ mode: 'regenerate', conversationId: convId });
    });

    await runStream({
      mode: 'send',
      conversationId: convId,
      promptText: content,
    });
  };

  const sendMessageFromHome = async (prompt: string) => {
    try {
      const { conversation } = await mjApi.createConversation({
        model: selectedModelOverride || settings?.activeModel,
      });
      setActiveConversation(conversation);
      setMessages([]);
      setConversations((prev) => [conversation, ...prev]);

      setLastRetryAction(() => () => {
        void runStream({
          mode: 'regenerate',
          conversationId: conversation.id,
          fromHome: true,
        });
      });

      await runStream({
        mode: 'send',
        conversationId: conversation.id,
        promptText: prompt,
        fromHome: true,
      });
    } catch (err) {
      const payload =
        err instanceof ApiClientError
          ? err.payload
          : {
            code: ErrorCodes.NETWORK_DISCONNECTED,
            category: 'network' as const,
            statusCode: 503,
            message: 'Could not start conversation. Check server connection.',
            retryable: true,
          };
      setActiveError(payload);
      setStreamingState('error');
    }
  };

  const handleRegenerate = async () => {
    if (!activeConversation) return;
    setLastRetryAction(() => () => {
      void runStream({ mode: 'regenerate', conversationId: activeConversation.id });
    });
    await runStream({
      mode: 'regenerate',
      conversationId: activeConversation.id,
    });
  };

  const handleStopStream = () => {
    streamAbortRef.current?.abort();
  };

  const handleRetryLast = () => {
    if (lastRetryAction) {
      lastRetryAction();
    } else if (activeConversation) {
      void handleRegenerate();
    }
  };

  const handleSaveSettings = async (patch: Record<string, unknown>) => {
    const updated = await mjApi.updateSettings(patch);
    setSettings(updated);
    setSelectedProviderOverride(updated.activeProvider ?? 'auto');
    setSelectedModelOverride(updated.activeModel);
    const refreshedUsage = await mjApi.getUsage();
    setUsage(refreshedUsage);
  };

  const handleSelectProviderOverride = (providerId: string) => {
    setSelectedProviderOverride(providerId);
    if (providerId === 'auto') {
      if (settings?.activeModel) {
        setSelectedModelOverride(settings.activeModel);
      }
      return;
    }
    const found = settings?.providers?.find((p) => p.id === providerId);
    if (found?.defaultModel) {
      setSelectedModelOverride(found.defaultModel);
    }
  };

  const handleStartVoice = useCallback(async () => {
    setActiveError(null);
    const currentPerms = permissionsRef.current;
    if (!currentPerms.microphoneAccess || !currentPerms.voiceSessionAccess) {
      const blockedByMic = !currentPerms.microphoneAccess;
      setActiveError({
        code: ErrorCodes.PERMISSION_DENIED,
        category: 'privacy',
        statusCode: 403,
        message: blockedByMic
          ? 'Microphone access is disabled in Privacy & Permissions.'
          : 'Realtime voice sessions are disabled in Privacy & Permissions.',
        retryable: false,
      });
      void mjApi
        .recordAuditLog({
          capability: blockedByMic ? 'microphoneAccess' : 'voiceSessionAccess',
          action: 'Blocked realtime voice session start',
          target: 'realtime_voice',
          outcome: 'denied',
          source: 'web',
          detail: 'Permission toggled OFF in Privacy Center.',
        })
        .then(() => refreshAuditLogs())
        .catch(() => { });
      return;
    }

    wakeListenerRef.current?.stop();
    setInteractionMode('voice');
    await ensureActiveConversationId();
    setLastRetryAction(() => () => {
      void startVoiceRef.current();
    });
    if (settingsRef.current?.voice.voiceModel === 'free-browser-voice') {
      await freeVoiceFallbackRef.current();
      return;
    }
    await voiceServiceRef.current?.startSession();
  }, [ensureActiveConversationId, refreshAuditLogs]);

  const startFreeVoiceFallback = useCallback(async () => {
    freeVoiceRef.current?.stop();
    const convId = await ensureActiveConversationId();
    setInteractionMode('voice');
    setActiveError(null);
    setLiveUserTranscript('');
    setLiveAssistantTranscript('');

    freeVoiceRef.current = startFreeBrowserVoiceSession({
      languageMode: settingsRef.current?.voice.languageMode ?? 'auto',
      volume: settingsRef.current?.voice.volume ?? 0.9,
      speakingRate: settingsRef.current?.voice.speakingRate ?? 1.0,
      voiceOutputEnabled: settingsRef.current?.voice.voiceOutputEnabled ?? true,
      onStateChange: (state, detail) => {
        setVoiceState(state);
        setVoiceDetail(detail);
      },
      onTranscriptPreview: (text) => {
        setLiveUserTranscript(text);
      },
      onSubmitTranscript: async (transcript) => {
        setLiveUserTranscript(transcript);
        const reply = await runStream({
          mode: 'send',
          conversationId: convId,
          promptText: transcript,
          skipAutoTts: true,
        });
        setLiveAssistantTranscript(reply);
        return reply;
      },
      onFinish: () => {
        freeVoiceRef.current = null;
      },
      onErrorMessage: (msg) => {
        setVoiceState(VoiceStates.ERROR);
        setVoiceDetail(msg);
        setActiveError({
          code: ErrorCodes.VOICE_SERVICE_UNAVAILABLE,
          category: 'voice',
          statusCode: 503,
          message: msg,
          retryable: true,
        });
      },
    });
  }, [ensureActiveConversationId, runStream]);

  useEffect(() => {
    freeVoiceFallbackRef.current = startFreeVoiceFallback;
  }, [startFreeVoiceFallback]);

  useEffect(() => {
    startVoiceRef.current = handleStartVoice;
  }, [handleStartVoice]);

  const handleStopVoice = () => {
    freeVoiceRef.current?.stop();
    freeVoiceRef.current = null;
    void voiceServiceRef.current?.stopSession('manual');
  };

  const handleToggleMute = () => {
    voiceServiceRef.current?.toggleMute();
  };

  const handleInterruptVoice = () => {
    freeVoiceRef.current?.interrupt();
    voiceServiceRef.current?.interrupt();
  };

  const playBrowserSpeech = useCallback((text: string): boolean => {
    const s = settingsRef.current;
    return speakWithBrowserSpeechSynthesis(text, {
      volume: s?.voice.volume ?? 0.9,
      speakingRate: s?.voice.speakingRate ?? 1.0,
      languageMode: s?.voice.languageMode ?? 'auto',
      voiceOutputEnabled: s?.voice.voiceOutputEnabled ?? true,
      onStart: () => {
        setVoiceState(VoiceStates.SPEAKING);
        setVoiceDetail('Speaking via Free Browser TTS ($0.00)…');
      },
      onEnd: () => {
        setVoiceState(VoiceStates.IDLE);
        setVoiceDetail('Ready');
      },
      onError: (msg) => {
        setActiveError({
          code: ErrorCodes.AUDIO_PLAYBACK_FAILED,
          category: 'voice',
          statusCode: 500,
          message: msg,
          retryable: false,
        });
      },
    });
  }, []);

  useEffect(() => {
    browserTtsFallbackRef.current = playBrowserSpeech;
  }, [playBrowserSpeech]);

  const speakTextResilient = useCallback(
    (text: string) => {
      const trimmed = text.trim();
      if (!trimmed) return;
      voiceServiceRef.current?.setLastAssistantText(trimmed);
      setHasLastResponseToSpeak(true);
      if (settingsRef.current?.voice.voiceModel === 'free-browser-voice') {
        playBrowserSpeech(trimmed);
        return;
      }
      void voiceServiceRef.current?.speakTextViaTts(trimmed);
    },
    [playBrowserSpeech],
  );

  const handleRepeatLastResponse = () => {
    const last = voiceServiceRef.current?.getLastAssistantText() ?? '';
    if (!last) return;
    speakTextResilient(last);
  };

  const handleSpeakText = (text: string) => {
    speakTextResilient(text);
  };

  const handleChangeLanguageMode = async (mode: LanguageMode) => {
    await handleSaveSettings({ voice: { languageMode: mode } });
  };

  const handleTogglePermission = useCallback(
    async (key: ControllablePermissionKey, enabled: boolean) => {
      const res = await mjApi.setSinglePermission(key, enabled);
      setPermissions(res.permissions);
      await tauriSetSinglePermission(key, enabled);
      if (key === 'microphoneAccess' && !enabled) {
        wakeListenerRef.current?.stop();
        freeVoiceRef.current?.stop();
        freeVoiceRef.current = null;
        await voiceServiceRef.current?.stopSession('manual');
      }
      if (key === 'voiceSessionAccess' && !enabled) {
        freeVoiceRef.current?.stop();
        freeVoiceRef.current = null;
        await voiceServiceRef.current?.stopSession('manual');
      }
      await refreshAuditLogs();
    },
    [refreshAuditLogs],
  );

  const handleRevokeAllDesktop = useCallback(async () => {
    wakeListenerRef.current?.stop();
    const res = await mjApi.revokeDesktopPermissions();
    setPermissions(res.permissions);
    await tauriRevokeAllPermissions();
    await refreshAuditLogs();
  }, [refreshAuditLogs]);

  const handleAddAllowlist = useCallback(
    async (entry: { kind: AllowlistKind; label: string; target: string }) => {
      const res = await mjApi.addAllowlistEntry(entry);
      setAllowlist((prev) => [res.entry, ...prev]);
      await refreshAuditLogs();
    },
    [refreshAuditLogs],
  );

  const handleRemoveAllowlist = useCallback(
    async (id: string) => {
      await mjApi.deleteAllowlistEntry(id);
      setAllowlist((prev) => prev.filter((item) => item.id !== id));
      await refreshAuditLogs();
    },
    [refreshAuditLogs],
  );

  const handleExportData = useCallback(async () => {
    const bundle = await mjApi.exportPersonalData();
    const blob = new Blob([JSON.stringify(bundle, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `mj-assistant-export-${new Date().toISOString().slice(0, 10)}.json`;
    document.body.appendChild(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(url);
    await refreshAuditLogs();
  }, [refreshAuditLogs]);

  const handleClearConversations = useCallback(async () => {
    await mjApi.clearAllConversations();
    setConversations([]);
    setActiveConversation(null);
    setMessages([]);
    setLatestHomeExchange(null);
    await refreshAuditLogs();
  }, [refreshAuditLogs]);

  const handleStopAllMic = useCallback(async () => {
    wakeListenerRef.current?.stop();
    freeVoiceRef.current?.stop();
    freeVoiceRef.current = null;
    await voiceServiceRef.current?.stopSession('manual');
    if (permissionsRef.current.wakeWordStandby) {
      await handleTogglePermission('wakeWordStandby', false);
    }
  }, [handleTogglePermission]);

  const handleTriggerShortcutAction = useCallback(
    async (shortcut: ConfigurableShortcutDTO) => {
      const inTauri = isTauriDesktop();
      if (inTauri) {
        await tauriValidateShortcutTrigger(shortcut.accelerator, shortcut.action);
      }
      await mjApi.triggerDesktopShortcut(shortcut.id, inTauri ? 'desktop-tauri' : 'web');

      switch (shortcut.action) {
        case 'toggle_voice': {
          const isVoiceOpen =
            voiceState === 'requesting_permission' ||
            voiceState === 'connecting' ||
            voiceState === 'listening' ||
            voiceState === 'processing' ||
            voiceState === 'speaking' ||
            voiceState === 'interrupted' ||
            voiceState === 'reconnecting';
          if (isVoiceOpen) {
            handleStopVoice();
          } else {
            await startVoiceRef.current();
          }
          break;
        }
        case 'stop_all_mic':
          await handleStopAllMic();
          break;
        case 'focus_chat':
          setActiveTab('chat');
          break;
        case 'focus_desktop':
          setActiveTab('desktop');
          break;
        case 'open_approved_app':
          if (inTauri && shortcut.target) {
            await tauriOpenApprovedApp(shortcut.target);
          }
          break;
        case 'open_approved_url':
          if (shortcut.target) {
            if (inTauri) {
              await tauriOpenApprovedUrl(shortcut.target);
            } else {
              window.open(shortcut.target, '_blank', 'noopener,noreferrer');
            }
          }
          break;
      }

      await refreshAuditLogs();
    },
    [allowlist, handleStopAllMic, refreshAuditLogs, voiceState],
  );

  useEffect(() => {
    if (!session?.authenticated || !permissions.configurableShortcuts || shortcuts.length === 0) {
      return;
    }

    const onKeyDown = (e: globalThis.KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      const tag = target?.tagName?.toUpperCase();
      if (
        tag === 'INPUT' ||
        tag === 'TEXTAREA' ||
        tag === 'SELECT' ||
        target?.isContentEditable
      ) {
        return;
      }

      const acc = acceleratorFromKeyboardEvent(e);
      if (!acc) return;
      const matched = shortcuts.find((item) => item.accelerator === acc);
      if (!matched) return;

      e.preventDefault();
      void handleTriggerShortcutAction(matched).catch((err) => {
        const payload: StructuredErrorPayload =
          err instanceof ApiClientError
            ? err.payload
            : {
              code: ErrorCodes.PERMISSION_DENIED,
              category: 'desktop',
              statusCode: 403,
              message: err instanceof Error ? err.message : 'Shortcut trigger blocked.',
              retryable: false,
            };
        setActiveError(payload);
        void refreshAuditLogs();
      });
    };

    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [
    handleTriggerShortcutAction,
    permissions.configurableShortcuts,
    refreshAuditLogs,
    session?.authenticated,
    shortcuts,
  ]);

  // Initialize optional Wake-Word Standby listener (defaults OFF, Section 14)
  useEffect(() => {
    const listener = new WakeWordListener(
      (transcript) => {
        const current = permissionsRef.current;
        if (!current.microphoneAccess || !current.voiceSessionAccess) {
          void mjApi
            .recordAuditLog({
              capability: 'wakeWordStandby',
              action: 'Wake-word activation blocked',
              target: transcript || 'hey mj',
              outcome: 'denied',
              source: 'web',
              detail: 'microphoneAccess or voiceSessionAccess is OFF.',
            })
            .then(() => refreshAuditLogs())
            .catch(() => { });
          return;
        }
        void mjApi
          .recordAuditLog({
            capability: 'wakeWordStandby',
            action: 'Wake-word triggered voice session',
            target: transcript || 'hey mj',
            outcome: 'allowed',
            source: 'web',
          })
          .then(() => refreshAuditLogs())
          .catch(() => { });
        void startVoiceRef.current();
      },
      (status) => {
        setWakeWordActive(status.active);
        setWakeWordStatusMessage(status.message);
      },
    );
    wakeListenerRef.current = listener;
    return () => {
      listener.stop();
      wakeListenerRef.current = null;
    };
  }, [refreshAuditLogs]);

  const micActive =
    voiceState === 'requesting_permission' ||
    voiceState === 'connecting' ||
    voiceState === 'listening' ||
    voiceState === 'processing' ||
    voiceState === 'speaking' ||
    voiceState === 'interrupted' ||
    voiceState === 'reconnecting';

  useEffect(() => {
    const shouldStandby =
      Boolean(session?.authenticated) &&
      permissions.wakeWordStandby &&
      permissions.microphoneAccess &&
      !micActive;
    if (shouldStandby) {
      wakeListenerRef.current?.start();
    } else {
      wakeListenerRef.current?.stop();
    }
  }, [
    session?.authenticated,
    permissions.wakeWordStandby,
    permissions.microphoneAccess,
    micActive,
  ]);

  useEffect(() => {
    void syncTauriMicTray(micActive || wakeWordActive, wakeWordActive && !micActive);
  }, [micActive, wakeWordActive]);

  useEffect(() => {
    if (
      session?.authenticated &&
      (activeTab === 'privacy' || activeError?.code === ErrorCodes.PERMISSION_DENIED)
    ) {
      void refreshAuditLogs();
    }
  }, [activeTab, activeError?.code, session?.authenticated, refreshAuditLogs]);

  if (authLoading) {
    return (
      <div
        className="grid min-h-screen place-items-center text-sm"
        style={{ color: 'var(--mj-text-muted)' }}
      >
        Initializing MJ Assistant…
      </div>
    );
  }

  if (session && !session.authenticated && session.passcodeRequired) {
    return (
      <Suspense
        fallback={
          <div
            className="grid min-h-screen place-items-center text-sm"
            style={{ color: 'var(--mj-text-muted)' }}
          >
            Loading MJ Assistant…
          </div>
        }
      >
        <UnlockGate onLogin={handleLogin} errorMessage={authError} />
      </Suspense>
    );
  }

  return (
    <div className="mx-auto grid min-h-screen max-w-[1680px] grid-cols-1 md:grid-cols-[232px_minmax(0,1fr)]">
      <Sidebar
        activeTab={activeTab}
        onSelectTab={setActiveTab}
        health={health}
        session={session}
        voiceState={voiceState}
        micActive={micActive || wakeWordActive}
        onLogout={() => void handleLogout()}
      />

      <main className="min-w-0">
        <MicActiveBanner
          liveVoiceActive={micActive}
          voiceMuted={voiceMuted}
          wakeWordStandbyActive={wakeWordActive}
          onStopAllMic={() => void handleStopAllMic()}
        />

        <Suspense
          fallback={
            <div
              className="grid min-h-[50vh] place-items-center text-xs"
              style={{ color: 'var(--mj-text-muted)' }}
            >
              Loading workspace…
            </div>
          }
        >
          {activeTab === 'home' && (
            <HomeDashboard
              health={health}
              settings={settings}
              usage={usage}
              conversations={conversations}
              online={online}
              interactionMode={interactionMode}
              onChangeInteractionMode={setInteractionMode}
              streamingState={streamingState}
              streamStatusDetail={streamStatusDetail}
              voiceState={voiceState}
              voiceDetail={voiceDetail}
              voiceMuted={voiceMuted}
              voiceAudioLevel={voiceAudioLevel}
              liveUserTranscript={liveUserTranscript}
              liveAssistantTranscript={liveAssistantTranscript}
              hasLastResponseToSpeak={hasLastResponseToSpeak}
              latestHomeExchange={latestHomeExchange}
              activeError={activeError}
              onStartVoice={() => void handleStartVoice()}
              onStopVoice={handleStopVoice}
              onToggleMute={handleToggleMute}
              onInterruptVoice={handleInterruptVoice}
              onRepeatLastResponse={handleRepeatLastResponse}
              onChangeLanguageMode={(mode) => void handleChangeLanguageMode(mode)}
              onQuickSend={(prompt) => void sendMessageFromHome(prompt)}
              onStopStream={handleStopStream}
              onRetryLast={handleRetryLast}
              onOpenConversation={(id) => {
                void handleSelectConversation(id);
                setActiveTab('chat');
              }}
              onNavigateChat={() => setActiveTab('chat')}
              onNavigateUsage={() => setActiveTab('usage')}
              onNavigateSettings={() => setActiveTab('settings')}
            />
          )}
          {activeTab === 'chat' && (
            <ChatWorkspace
              conversations={conversations}
              activeConversation={activeConversation}
              messages={messages}
              searchQuery={searchQuery}
              onSearchChange={setSearchQuery}
              settings={settings}
              usage={usage}
              streamingState={streamingState}
              streamStatusDetail={streamStatusDetail}
              voiceState={voiceState}
              voiceDetail={voiceDetail}
              voiceMuted={voiceMuted}
              liveUserTranscript={liveUserTranscript}
              liveAssistantTranscript={liveAssistantTranscript}
              activeError={activeError}
              selectedProviderOverride={selectedProviderOverride}
              onSelectProviderOverride={handleSelectProviderOverride}
              selectedModelOverride={selectedModelOverride}
              onSelectModelOverride={setSelectedModelOverride}
              onSelectConversation={(id) => void handleSelectConversation(id)}
              onCreateConversation={() => void handleCreateConversation()}
              onRenameConversation={handleRenameConversation}
              onDeleteConversation={handleDeleteConversation}
              onSendMessage={(content) => void sendMessageFromChat(content)}
              onRegenerate={() => void handleRegenerate()}
              onStopStream={handleStopStream}
              onRetryLast={handleRetryLast}
              onStartVoice={() => void handleStartVoice()}
              onStopVoice={handleStopVoice}
              onToggleMute={handleToggleMute}
              onInterruptVoice={handleInterruptVoice}
              onSpeakText={handleSpeakText}
            />
          )}

          {activeTab === 'usage' && (
            <UsageDashboardView
              health={health}
              backendLatencyMs={backendLatencyMs}
              online={online}
              voiceState={voiceState}
              settings={settings}
              usage={usage}
              connectivityCheck={connectivityCheck}
              checkingConnectivity={checkingConnectivity}
              onRefreshUsage={async () => {
                const u = await mjApi.getUsage();
                setUsage(u);
              }}
              onCheckConnectivity={handleCheckConnectivity}
              onSaveSettings={handleSaveSettings}
            />
          )}

          {activeTab === 'desktop' && (
            <DesktopView
              permissions={permissions}
              allowlist={allowlist}
              shortcuts={shortcuts}
              onAuditUpdated={refreshAuditLogs}
              onShortcutsUpdated={refreshShortcuts}
              onTriggerShortcutAction={handleTriggerShortcutAction}
              onNavigatePrivacy={() => setActiveTab('privacy')}
            />
          )}

          {activeTab === 'privacy' && (
            <PrivacyCenterView
              permissions={permissions}
              allowlist={allowlist}
              auditLogs={auditLogs}
              conversationCount={conversations.length}
              session={session}
              wakeWordStatusMessage={wakeWordStatusMessage}
              onTogglePermission={handleTogglePermission}
              onRevokeAllDesktop={handleRevokeAllDesktop}
              onAddAllowlist={handleAddAllowlist}
              onRemoveAllowlist={handleRemoveAllowlist}
              onRefreshAuditLogs={refreshAuditLogs}
              onExportData={handleExportData}
              onClearConversations={handleClearConversations}
              onLogout={handleLogout}
            />
          )}

          {activeTab === 'settings' && (
            <SettingsView
              settings={settings}
              usage={usage}
              session={session}
              availableVoices={availableVoices}
              onSaveSettings={handleSaveSettings}
              onRefreshUsage={async () => {
                const u = await mjApi.getUsage();
                setUsage(u);
              }}
            />
          )}
        </Suspense>
      </main>
    </div>
  );
}
