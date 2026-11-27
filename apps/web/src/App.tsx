import { useCallback, useEffect, useRef, useState } from 'react';
import {
  ErrorCodes,
  VoiceStates,
  type AuthSessionDTO,
  type ChatStreamEvent,
  type ConversationDTO,
  type LanguageMode,
  type MessageDTO,
  type PublicSettingsDTO,
  type StructuredErrorPayload,
  type SystemHealthDTO,
  type UsageSummaryDTO,
  type VoiceState,
} from '@mj/shared';
import { MjVoiceService, VOICE_STATE_META } from '@mj/voice';
import { ApiClientError, mjApi } from './api/client.js';
import { ChatWorkspace } from './components/ChatWorkspace.js';
import { HomeDashboard } from './components/HomeDashboard.js';
import { SettingsView } from './components/SettingsView.js';
import { Sidebar, type ActiveNavTab } from './components/Sidebar.js';
import { UnlockGate } from './components/UnlockGate.js';

export function App() {
  const [activeTab, setActiveTab] = useState<ActiveNavTab>('home');
  const [interactionMode, setInteractionMode] = useState<'voice' | 'text'>('voice');
  const [online, setOnline] = useState(() => navigator.onLine);
  const [session, setSession] = useState<AuthSessionDTO | null>(null);
  const [authLoading, setAuthLoading] = useState(true);
  const [authError, setAuthError] = useState<string | null>(null);

  const [health, setHealth] = useState<SystemHealthDTO | null>(null);
  const [settings, setSettings] = useState<PublicSettingsDTO | null>(null);
  const [usage, setUsage] = useState<UsageSummaryDTO | null>(null);
  const [availableVoices, setAvailableVoices] = useState<
    Array<{ id: string; label: string; description: string }>
  >([]);

  const [conversations, setConversations] = useState<ConversationDTO[]>([]);
  const [searchQuery, setSearchQuery] = useState('');
  const [activeConversation, setActiveConversation] = useState<ConversationDTO | null>(null);
  const [messages, setMessages] = useState<MessageDTO[]>([]);
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

  const [activeError, setActiveError] = useState<StructuredErrorPayload | null>(null);
  const [lastRetryAction, setLastRetryAction] = useState<(() => void) | null>(null);
  const [latestHomeExchange, setLatestHomeExchange] = useState<{
    conversationId: string;
    userPrompt: string;
    assistantMessage: MessageDTO | null;
  } | null>(null);

  const streamAbortRef = useRef<AbortController | null>(null);
  const voiceServiceRef = useRef<MjVoiceService | null>(null);
  const activeConversationRef = useRef<ConversationDTO | null>(null);
  const settingsRef = useRef<PublicSettingsDTO | null>(null);

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
        onError: (errPayload) => {
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
                  model: settingsRef.current?.voice.voiceModel ?? 'grok-voice-latest',
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
      void service.stopSession('manual');
      voiceServiceRef.current = null;
    };
  }, [ensureActiveConversationId]);

  const loadHealth = useCallback(async () => {
    try {
      const h = await mjApi.getHealth();
      setHealth(h);
    } catch {
      setHealth(null);
    }
  }, []);

  const loadAuthenticatedWorkspace = useCallback(async () => {
    const [settingsRes, usageRes, convRes, voicesRes] = await Promise.all([
      mjApi.getSettings(),
      mjApi.getUsage(),
      mjApi.listConversations(),
      mjApi.getAvailableVoices().catch(() => ({ voices: [] })),
    ]);
    setSettings(settingsRes);
    setSelectedModelOverride(settingsRes.activeModel);
    setUsage(usageRes);
    setConversations(convRes.conversations);
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
    await voiceServiceRef.current?.stopSession('manual');
    const sess = await mjApi.logout();
    setSession(sess);
    setConversations([]);
    setActiveConversation(null);
    setMessages([]);
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
  }) => {
    streamAbortRef.current?.abort();
    const abortController = new AbortController();
    streamAbortRef.current = abortController;

    setActiveError(null);
    setStreamingState('connecting');
    setStreamStatusDetail('Connecting to Grok…');

    const modelToUse = selectedModelOverride || settings?.activeModel;

    const tempUserId = `temp-user-${Date.now()}`;
    const tempAssistantId = `temp-assistant-${Date.now()}`;
    let realAssistantId = tempAssistantId;

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
          voiceServiceRef.current?.setLastAssistantText(event.message.content);
          setHasLastResponseToSpeak(true);
          if (settingsRef.current?.voice.autoPlayback && settingsRef.current?.voice.voiceOutputEnabled) {
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
          { content: options.promptText, model: modelToUse },
          { onEvent: handleEvent },
          abortController.signal,
        );
      } else {
        await mjApi.regenerateLastTurn(
          options.conversationId,
          { model: modelToUse },
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
    } catch (err) {
      if (abortController.signal.aborted) {
        setStreamingState('idle');
        setStreamStatusDetail('Generation stopped');
        return;
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
    setSelectedModelOverride(updated.activeModel);
    const refreshedUsage = await mjApi.getUsage();
    setUsage(refreshedUsage);
  };

  const handleStartVoice = async () => {
    setActiveError(null);
    setInteractionMode('voice');
    await ensureActiveConversationId();
    setLastRetryAction(() => () => {
      void voiceServiceRef.current?.startSession();
    });
    await voiceServiceRef.current?.startSession();
  };

  const handleStopVoice = () => {
    void voiceServiceRef.current?.stopSession('manual');
  };

  const handleToggleMute = () => {
    voiceServiceRef.current?.toggleMute();
  };

  const handleInterruptVoice = () => {
    voiceServiceRef.current?.interrupt();
  };

  const handleRepeatLastResponse = () => {
    void voiceServiceRef.current?.repeatLastResponse();
  };

  const handleSpeakText = (text: string) => {
    void voiceServiceRef.current?.speakTextViaTts(text);
  };

  const handleChangeLanguageMode = async (mode: LanguageMode) => {
    await handleSaveSettings({ voice: { languageMode: mode } });
  };

  const micActive =
    voiceState === 'requesting_permission' ||
    voiceState === 'connecting' ||
    voiceState === 'listening' ||
    voiceState === 'processing' ||
    voiceState === 'speaking' ||
    voiceState === 'interrupted' ||
    voiceState === 'reconnecting';

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
    return <UnlockGate onLogin={handleLogin} errorMessage={authError} />;
  }

  return (
    <div className="mx-auto grid min-h-screen max-w-[1680px] grid-cols-1 md:grid-cols-[232px_minmax(0,1fr)]">
      <Sidebar
        activeTab={activeTab}
        onSelectTab={setActiveTab}
        health={health}
        session={session}
        voiceState={voiceState}
        micActive={micActive}
        onLogout={() => void handleLogout()}
      />

      <main className="min-w-0">
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
      </main>
    </div>
  );
}
