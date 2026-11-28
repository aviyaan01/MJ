import { useEffect, useState, type FormEvent } from 'react';
import {
  Activity,
  AudioLines,
  Check,
  Cpu,
  Palette,
  Save,
  ShieldCheck,
  Sliders,
} from 'lucide-react';
import { Panel, StatusPill } from '@mj/ui';
import {
  DEFAULT_AUTO_LISTEN,
  DEFAULT_BARGE_IN_PCM16_THRESHOLD,
  DEFAULT_FOLLOWUP_LISTEN_SECONDS,
  MAX_FOLLOWUP_LISTEN_SECONDS,
  MIN_FOLLOWUP_LISTEN_SECONDS,
  resolveProviderDisplay,
  type AiProviderId,
  type AuthSessionDTO,
  type LanguageMode,
  type PublicSettingsDTO,
  type ReasoningEffort,
  type ResponseStyle,
  type UsageSummaryDTO,
} from '@mj/shared';

type SettingsTab = 'general' | 'model' | 'voice' | 'appearance' | 'usage' | 'security';

interface SettingsViewProps {
  settings: PublicSettingsDTO | null;
  usage: UsageSummaryDTO | null;
  session: AuthSessionDTO | null;
  availableVoices: Array<{ id: string; label: string; description: string }>;
  initialTab?: SettingsTab;
  onSaveSettings: (patch: Record<string, unknown>) => Promise<void>;
  onRefreshUsage: () => Promise<void>;
}

const TABS: Array<{ id: SettingsTab; label: string; icon: typeof Sliders }> = [
  { id: 'general', label: 'General', icon: Sliders },
  { id: 'model', label: 'AI Model & API', icon: Cpu },
  { id: 'voice', label: 'Voice & Language', icon: AudioLines },
  { id: 'appearance', label: 'Appearance', icon: Palette },
  { id: 'usage', label: 'Usage & Budget', icon: Activity },
  { id: 'security', label: 'Security & Roadmap', icon: ShieldCheck },
];

export function SettingsView({
  settings,
  usage,
  session,
  availableVoices,
  initialTab = 'general',
  onSaveSettings,
  onRefreshUsage,
}: SettingsViewProps) {
  const [activeTab, setActiveTab] = useState<SettingsTab>(initialTab);
  const [saving, setSaving] = useState(false);
  const [savedNotice, setSavedNotice] = useState(false);
  const [errorText, setErrorText] = useState<string | null>(null);

  const [responseStyle, setResponseStyle] = useState<ResponseStyle>('balanced');
  const [activeProvider, setActiveProvider] = useState<AiProviderId>('auto');
  const [activeModel, setActiveModel] = useState('gemini-2.5-flash');
  const [customModel, setCustomModel] = useState('');
  const [reasoningEffort, setReasoningEffort] = useState<ReasoningEffort>('medium');
  const [maxOutputTokens, setMaxOutputTokens] = useState(4096);
  const [timeoutMs, setTimeoutMs] = useState(60000);
  const [streamResponses, setStreamResponses] = useState(true);

  const [voiceModel, setVoiceModel] = useState('gemini-2.5-flash-native-audio-preview-12-2025');
  const [customVoiceModel, setCustomVoiceModel] = useState('');
  const [voiceId, setVoiceId] = useState('ara');
  const [languageMode, setLanguageMode] = useState<LanguageMode>('auto');
  const [speakingRate, setSpeakingRate] = useState(1.0);
  const [volume, setVolume] = useState(0.9);
  const [autoPlayback, setAutoPlayback] = useState(false);
  const [voiceOutputEnabled, setVoiceOutputEnabled] = useState(true);
  const [autoListen, setAutoListen] = useState(DEFAULT_AUTO_LISTEN);
  const [followupListenSeconds, setFollowupListenSeconds] = useState(
    DEFAULT_FOLLOWUP_LISTEN_SECONDS,
  );
  const [bargeInThreshold, setBargeInThreshold] = useState(DEFAULT_BARGE_IN_PCM16_THRESHOLD);

  const [reducedMotionOverride, setReducedMotionOverride] = useState<'system' | 'reduce' | 'normal'>('system');
  const [compactDensity, setCompactDensity] = useState(false);

  const [dailyCapUsd, setDailyCapUsd] = useState(5);
  const [softCapUsd, setSoftCapUsd] = useState(10);
  const [hardCapUsd, setHardCapUsd] = useState(25);
  const [inputRate, setInputRate] = useState(2);
  const [outputRate, setOutputRate] = useState(6);
  const [cachedRate, setCachedRate] = useState(0.5);
  const [voiceRatePerMin, setVoiceRatePerMin] = useState(0.05);
  const [ttsRatePerMilChars, setTtsRatePerMilChars] = useState(15);
  const [sttRatePerHour, setSttRatePerHour] = useState(0.05);

  useEffect(() => {
    if (!settings) return;
    setResponseStyle(settings.responseStyle);
    setActiveProvider(settings.activeProvider ?? 'auto');
    setActiveModel(settings.activeModel);
    setReasoningEffort(settings.reasoningEffort);
    setMaxOutputTokens(settings.maxOutputTokens);
    setTimeoutMs(settings.timeoutMs);
    setStreamResponses(settings.streamResponses);

    setVoiceModel(settings.voice.voiceModel);
    setVoiceId(settings.voice.voiceId);
    setLanguageMode(settings.voice.languageMode);
    setSpeakingRate(settings.voice.speakingRate);
    setVolume(settings.voice.volume);
    setAutoPlayback(settings.voice.autoPlayback);
    setVoiceOutputEnabled(settings.voice.voiceOutputEnabled);
    setAutoListen(settings.voice.autoListen ?? DEFAULT_AUTO_LISTEN);
    setFollowupListenSeconds(
      settings.voice.followupListenSeconds ?? DEFAULT_FOLLOWUP_LISTEN_SECONDS,
    );
    setBargeInThreshold(settings.voice.bargeInThreshold ?? DEFAULT_BARGE_IN_PCM16_THRESHOLD);

    setReducedMotionOverride(settings.reducedMotionOverride);
    setCompactDensity(settings.compactDensity);

    setDailyCapUsd(settings.budget.dailyCapUsd ?? 5);
    setSoftCapUsd(settings.budget.softCapUsd);
    setHardCapUsd(settings.budget.hardCapUsd);
    setInputRate(settings.budget.inputRatePerMillionUsd);
    setOutputRate(settings.budget.outputRatePerMillionUsd);
    setCachedRate(settings.budget.cachedInputRatePerMillionUsd);
    setVoiceRatePerMin(settings.budget.voiceRatePerMinuteUsd);
    setTtsRatePerMilChars(settings.budget.ttsRatePerMillionCharsUsd);
    setSttRatePerHour(settings.budget.sttRatePerHourUsd ?? 0.05);
  }, [settings]);

  const handleSave = async (e: FormEvent) => {
    e.preventDefault();
    setSaving(true);
    setErrorText(null);
    setSavedNotice(false);
    try {
      const modelToSave = customModel.trim() || activeModel;
      const voiceModelToSave = customVoiceModel.trim() || voiceModel;
      await onSaveSettings({
        responseStyle,
        activeProvider,
        activeModel: modelToSave,
        reasoningEffort,
        maxOutputTokens: Number(maxOutputTokens),
        timeoutMs: Number(timeoutMs),
        streamResponses,
        reducedMotionOverride,
        compactDensity,
        voice: {
          voiceModel: voiceModelToSave,
          voiceId,
          languageMode,
          speakingRate: Number(speakingRate),
          volume: Number(volume),
          autoPlayback,
          voiceOutputEnabled,
          autoListen,
          followupListenSeconds: Number(followupListenSeconds),
          bargeInThreshold: Number(bargeInThreshold),
        },
        budget: {
          dailyCapUsd: Number(dailyCapUsd),
          softCapUsd: Number(softCapUsd),
          hardCapUsd: Number(hardCapUsd),
          inputRatePerMillionUsd: Number(inputRate),
          outputRatePerMillionUsd: Number(outputRate),
          cachedInputRatePerMillionUsd: Number(cachedRate),
          voiceRatePerMinuteUsd: Number(voiceRatePerMin),
          ttsRatePerMillionCharsUsd: Number(ttsRatePerMilChars),
          sttRatePerHourUsd: Number(sttRatePerHour),
        },
      });
      setCustomModel('');
      setCustomVoiceModel('');
      setSavedNotice(true);
      setTimeout(() => setSavedNotice(false), 2400);
    } catch (err) {
      setErrorText(err instanceof Error ? err.message : 'Failed to save settings.');
    } finally {
      setSaving(false);
    }
  };

  const voiceChoices =
    availableVoices.length > 0
      ? availableVoices
      : settings?.voice.availableVoices ?? [
        { id: 'ara', label: 'Ara', description: 'Warm and conversational' },
      ];

  return (
    <div className="mx-auto w-full max-w-5xl px-4 py-6 sm:px-8 lg:py-8">
      <header className="mb-6 flex flex-wrap items-center justify-between gap-4">
        <div>
          <div
            className="text-[11px] font-medium tracking-[0.2em] uppercase"
            style={{ color: 'var(--mj-text-subtle)' }}
          >
            CONFIGURATION
          </div>
          <h1 className="mt-1 text-2xl font-normal tracking-tight text-[#F0F5F9]">
            MJ <span style={{ color: 'var(--mj-accent-ice)' }}>Settings</span>
          </h1>
        </div>

        <StatusPill tone={settings?.apiKeyConfigured ? 'good' : 'warn'}>
          {settings?.apiKeyConfigured ? 'API Key Active' : 'API Key Unconfigured'}
        </StatusPill>
      </header>

      <div className="grid grid-cols-1 gap-5 md:grid-cols-[220px_minmax(0,1fr)]">
        {/* Category Tabs */}
        <nav aria-label="Settings categories" className="flex gap-1.5 overflow-x-auto md:flex-col">
          {TABS.map((tab) => {
            const Icon = tab.icon;
            const active = activeTab === tab.id;
            return (
              <button
                key={tab.id}
                type="button"
                onClick={() => {
                  setActiveTab(tab.id);
                  if (tab.id === 'usage') void onRefreshUsage();
                }}
                className="flex shrink-0 items-center gap-2.5 rounded-xl px-3.5 py-2.5 text-left text-xs font-medium transition md:w-full"
                style={{
                  backgroundColor: active ? 'rgba(154, 198, 230, 0.12)' : 'transparent',
                  border: active
                    ? '1px solid rgba(177, 215, 241, 0.2)'
                    : '1px solid transparent',
                  color: active ? 'var(--mj-accent-ice)' : 'var(--mj-text-muted)',
                }}
              >
                <Icon className="h-4 w-4 shrink-0" />
                <span>{tab.label}</span>
              </button>
            );
          })}
        </nav>

        {/* Settings Content */}
        <form onSubmit={handleSave} className="space-y-4">
          {activeTab === 'general' && (
            <Panel className="space-y-5 p-6">
              <div>
                <h2 className="text-base font-medium text-[#EDF3F8]">General &amp; Personality</h2>
                <p className="mt-1 text-xs" style={{ color: 'var(--mj-text-muted)' }}>
                  Configure how MJ Assistant communicates across both text and realtime voice.
                </p>
              </div>

              <div>
                <label className="mb-2 block text-xs font-medium text-[#DCE6EE]">
                  Assistant Identity
                </label>
                <div
                  className="rounded-xl px-4 py-2.5 text-sm"
                  style={{
                    backgroundColor: '#07090E',
                    border: '1px solid var(--mj-border-subtle)',
                    color: 'var(--mj-accent-ice)',
                  }}
                >
                  MJ Assistant (Original JARVIS-inspired identity · English, বাংলা &amp; Banglish)
                </div>
              </div>

              <div>
                <label
                  htmlFor="response-style"
                  className="mb-2 block text-xs font-medium text-[#DCE6EE]"
                >
                  Response Style
                </label>
                <select
                  id="response-style"
                  value={responseStyle}
                  onChange={(e) => setResponseStyle(e.target.value as ResponseStyle)}
                  className="w-full rounded-xl px-3.5 py-2.5 text-sm text-[#EDF3F8] outline-none"
                  style={{
                    backgroundColor: '#07090E',
                    border: '1px solid var(--mj-border-strong)',
                  }}
                >
                  <option value="balanced">Balanced (Concise by default, detailed when asked)</option>
                  <option value="concise">Concise (Short and direct)</option>
                  <option value="detailed">Detailed (Structured analytical breakdowns)</option>
                </select>
              </div>
            </Panel>
          )}

          {activeTab === 'model' && (
            <Panel className="space-y-5 p-6">
              <div>
                <h2 className="text-base font-medium text-[#EDF3F8]">AI Providers, Models &amp; Free APIs</h2>
                <p className="mt-1 text-xs" style={{ color: 'var(--mj-text-muted)' }}>
                  Supports zero-cost providers (Local Ollama, Groq, Google Gemini, OpenRouter :free, Cerebras, Mistral, GitHub Models) plus xAI Grok with automatic failover in <code className="font-mono">auto</code> mode.
                </p>
              </div>

              <div>
                <label htmlFor="active-provider" className="mb-2 block text-xs font-medium text-[#DCE6EE]">
                  Active AI Provider
                </label>
                <select
                  id="active-provider"
                  value={activeProvider}
                  onChange={(e) => {
                    const nextId = e.target.value as AiProviderId;
                    setActiveProvider(nextId);
                    if (nextId !== 'auto') {
                      const matched = settings?.providers?.find((p) => p.id === nextId);
                      if (matched?.defaultModel) {
                        setActiveModel(matched.defaultModel);
                      }
                    }
                  }}
                  className="w-full rounded-xl px-3.5 py-2.5 text-sm text-[#EDF3F8] outline-none"
                  style={{
                    backgroundColor: '#07090E',
                    border: '1px solid var(--mj-border-strong)',
                  }}
                >
                  <option value="auto">Auto (Free Providers First + Automatic Failover)</option>
                  {(settings?.providers ?? []).map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name} — {p.configured ? (p.freeTier ? 'Ready ($0 Free)' : 'Configured') : 'Needs Key in .env'}
                    </option>
                  ))}
                </select>
              </div>

              {settings?.providers && settings.providers.length > 0 && (
                <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                  {settings.providers.map((p) => (
                    <div
                      key={p.id}
                      className="rounded-xl px-3.5 py-2.5 text-xs"
                      style={{
                        backgroundColor: '#07090E',
                        border: '1px solid var(--mj-border-subtle)',
                      }}
                    >
                      <div className="flex items-center justify-between gap-2">
                        <span className="font-medium text-[#EDF3F8]">{p.name}</span>
                        <StatusPill tone={p.configured ? 'good' : 'neutral'}>
                          {p.configured ? (p.freeTier ? 'Ready · Free' : 'Key Active') : 'Unconfigured'}
                        </StatusPill>
                      </div>
                      <div className="mt-1 text-[11px]" style={{ color: 'var(--mj-text-subtle)' }}>
                        {p.costNote}
                      </div>
                    </div>
                  ))}
                </div>
              )}

              <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                <div>
                  <label htmlFor="active-model" className="mb-2 block text-xs font-medium text-[#DCE6EE]">
                    Configured Text Model
                  </label>
                  <select
                    id="active-model"
                    value={activeModel}
                    onChange={(e) => setActiveModel(e.target.value)}
                    className="w-full rounded-xl px-3.5 py-2.5 font-mono text-sm text-[#EDF3F8] outline-none"
                    style={{
                      backgroundColor: '#07090E',
                      border: '1px solid var(--mj-border-strong)',
                    }}
                  >
                    {(settings?.availableModels ?? ['gemini-2.5-flash']).map((m) => (
                      <option key={m} value={m}>
                        {m}
                      </option>
                    ))}
                  </select>
                </div>

                <div>
                  <label htmlFor="custom-model" className="mb-2 block text-xs font-medium text-[#DCE6EE]">
                    Custom Model ID (Optional)
                  </label>
                  <input
                    id="custom-model"
                    type="text"
                    value={customModel}
                    onChange={(e) => setCustomModel(e.target.value)}
                    placeholder="e.g. gemini-2.5-flash"
                    className="w-full rounded-xl px-3.5 py-2.5 font-mono text-sm text-[#EDF3F8] outline-none placeholder:text-[#8B9CB0]"
                    style={{
                      backgroundColor: '#07090E',
                      border: '1px solid var(--mj-border-strong)',
                    }}
                  />
                </div>

                <div>
                  <label htmlFor="reasoning-effort" className="mb-2 block text-xs font-medium text-[#DCE6EE]">
                    Reasoning Effort
                  </label>
                  <select
                    id="reasoning-effort"
                    value={reasoningEffort}
                    onChange={(e) => setReasoningEffort(e.target.value as ReasoningEffort)}
                    className="w-full rounded-xl px-3.5 py-2.5 text-sm text-[#EDF3F8] outline-none"
                    style={{
                      backgroundColor: '#07090E',
                      border: '1px solid var(--mj-border-strong)',
                    }}
                  >
                    <option value="low">Low (Fastest)</option>
                    <option value="medium">Medium (Balanced)</option>
                    <option value="high">High (Deep reasoning)</option>
                    <option value="xhigh">Extra High (Max depth)</option>
                  </select>
                </div>

                <div>
                  <label htmlFor="max-tokens" className="mb-2 block text-xs font-medium text-[#DCE6EE]">
                    Max Output Tokens
                  </label>
                  <input
                    id="max-tokens"
                    type="number"
                    min={128}
                    max={32768}
                    value={maxOutputTokens}
                    onChange={(e) => setMaxOutputTokens(Number(e.target.value))}
                    className="w-full rounded-xl px-3.5 py-2.5 font-mono text-sm text-[#EDF3F8] outline-none"
                    style={{
                      backgroundColor: '#07090E',
                      border: '1px solid var(--mj-border-strong)',
                    }}
                  />
                </div>

                <div>
                  <label htmlFor="timeout-ms" className="mb-2 block text-xs font-medium text-[#DCE6EE]">
                    Request Timeout (ms)
                  </label>
                  <input
                    id="timeout-ms"
                    type="number"
                    min={5000}
                    max={180000}
                    step={1000}
                    value={timeoutMs}
                    onChange={(e) => setTimeoutMs(Number(e.target.value))}
                    className="w-full rounded-xl px-3.5 py-2.5 font-mono text-sm text-[#EDF3F8] outline-none"
                    style={{
                      backgroundColor: '#07090E',
                      border: '1px solid var(--mj-border-strong)',
                    }}
                  />
                </div>

                <div
                  className="flex items-center justify-between rounded-xl px-4 py-3"
                  style={{
                    backgroundColor: '#07090E',
                    border: '1px solid var(--mj-border-subtle)',
                  }}
                >
                  <div>
                    <div className="text-xs font-medium text-[#DCE6EE]">Stream Responses</div>
                    <div className="text-[11px]" style={{ color: 'var(--mj-text-subtle)' }}>
                      Server-Sent Events token streaming
                    </div>
                  </div>
                  <input
                    type="checkbox"
                    aria-label="Stream responses"
                    checked={streamResponses}
                    onChange={(e) => setStreamResponses(e.target.checked)}
                    className="h-4 w-4 accent-[#9AC6E6]"
                  />
                </div>
              </div>

              <div
                className="grid grid-cols-1 gap-3 rounded-xl p-4 text-xs sm:grid-cols-2"
                style={{
                  backgroundColor: 'rgba(255, 255, 255, 0.02)',
                  border: '1px solid var(--mj-border-subtle)',
                }}
              >
                <div>
                  <span style={{ color: 'var(--mj-text-subtle)' }}>Upstream API Host: </span>
                  <span className="font-mono text-[#EDF3F8]">
                    {resolveProviderDisplay({
                      activeProvider,
                      activeModel,
                      apiBaseHost: settings?.apiBaseHost,
                      providers: settings?.providers,
                    }).hostLabel}
                  </span>
                </div>
                <div>
                  <span style={{ color: 'var(--mj-text-subtle)' }}>Server Key Status: </span>
                  <span
                    className="font-mono"
                    style={{
                      color: settings?.apiKeyConfigured
                        ? 'var(--mj-status-good)'
                        : 'var(--mj-status-warn)',
                    }}
                  >
                    {settings?.apiKeyConfigured ? 'Configured (.env)' : 'Not configured'}
                  </span>
                </div>
              </div>
            </Panel>
          )}

          {activeTab === 'voice' && (
            <Panel className="space-y-5 p-6">
              <div>
                <h2 className="text-base font-medium text-[#EDF3F8]">
                  Realtime Voice &amp; Language Settings
                </h2>
                <p className="mt-1 text-xs" style={{ color: 'var(--mj-text-muted)' }}>
                  Connects via server-managed Google Gemini Live sessions with automatic fallback to Free Browser Voice (Web Speech API) and Groq Whisper STT.
                </p>
              </div>

              <div
                className="rounded-xl px-4 py-3 text-xs leading-relaxed"
                style={{
                  backgroundColor: 'rgba(154, 198, 230, 0.07)',
                  border: '1px solid rgba(154, 198, 230, 0.2)',
                  color: 'var(--mj-text-secondary)',
                }}
              >
                <strong>Voice routing note:</strong> Choose <code className="font-mono">gemini-2.5-flash-native-audio-preview-12-2025</code> for Gemini Live or <code className="font-mono">free-browser-voice</code> for $0.00 Web Speech API + Groq Whisper STT fallback.
              </div>

              <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                <div>
                  <label htmlFor="voice-model" className="mb-2 block text-xs font-medium text-[#DCE6EE]">
                    Realtime Voice Model
                  </label>
                  <select
                    id="voice-model"
                    value={voiceModel}
                    onChange={(e) => setVoiceModel(e.target.value)}
                    className="w-full rounded-xl px-3.5 py-2.5 font-mono text-sm text-[#EDF3F8] outline-none"
                    style={{
                      backgroundColor: '#07090E',
                      border: '1px solid var(--mj-border-strong)',
                    }}
                  >
                    {(
                      settings?.voice.availableVoiceModels ?? [
                        'gemini-2.5-flash-native-audio-preview-12-2025',
                        'free-browser-voice',
                        'grok-voice-latest',
                      ]
                    ).map((vm) => (
                      <option key={vm} value={vm}>
                        {vm === 'free-browser-voice'
                          ? 'free-browser-voice (Browser Speech · $0.00 Free)'
                          : vm}
                      </option>
                    ))}
                  </select>
                </div>

                <div>
                  <label htmlFor="custom-voice-model" className="mb-2 block text-xs font-medium text-[#DCE6EE]">
                    Custom / Pinned Voice Model (Optional)
                  </label>
                  <input
                    id="custom-voice-model"
                    type="text"
                    value={customVoiceModel}
                    onChange={(e) => setCustomVoiceModel(e.target.value)}
                    placeholder="e.g. gemini-2.5-flash-native-audio-preview-12-2025"
                    className="w-full rounded-xl px-3.5 py-2.5 font-mono text-sm text-[#EDF3F8] outline-none placeholder:text-[#8B9CB0]"
                    style={{
                      backgroundColor: '#07090E',
                      border: '1px solid var(--mj-border-strong)',
                    }}
                  />
                </div>

                <div>
                  <label htmlFor="voice-preset" className="mb-2 block text-xs font-medium text-[#DCE6EE]">
                    Assistant Voice Persona
                  </label>
                  <select
                    id="voice-preset"
                    value={voiceId}
                    onChange={(e) => setVoiceId(e.target.value)}
                    className="w-full rounded-xl px-3.5 py-2.5 text-sm text-[#EDF3F8] outline-none"
                    style={{
                      backgroundColor: '#07090E',
                      border: '1px solid var(--mj-border-strong)',
                    }}
                  >
                    {voiceChoices.map((v) => (
                      <option key={v.id} value={v.id}>
                        {v.label} — {v.description}
                      </option>
                    ))}
                  </select>
                </div>

                <div>
                  <label htmlFor="language-mode" className="mb-2 block text-xs font-medium text-[#DCE6EE]">
                    Language Detection &amp; Output
                  </label>
                  <select
                    id="language-mode"
                    value={languageMode}
                    onChange={(e) => setLanguageMode(e.target.value as LanguageMode)}
                    className="w-full rounded-xl px-3.5 py-2.5 text-sm text-[#EDF3F8] outline-none"
                    style={{
                      backgroundColor: '#07090E',
                      border: '1px solid var(--mj-border-strong)',
                    }}
                  >
                    <option value="auto">Automatic (AUTO · English + বাংলা + Banglish)</option>
                    <option value="en">English</option>
                    <option value="bn">বাংলা (Bengali)</option>
                    <option value="banglish">Banglish preference</option>
                  </select>
                </div>

                <div>
                  <label htmlFor="speaking-rate" className="mb-2 flex justify-between text-xs font-medium text-[#DCE6EE]">
                    <span>Speaking Speed</span>
                    <span className="font-mono text-[#9AC6E6]">{speakingRate.toFixed(2)}x</span>
                  </label>
                  <input
                    id="speaking-rate"
                    type="range"
                    min={0.75}
                    max={1.5}
                    step={0.05}
                    value={speakingRate}
                    onChange={(e) => setSpeakingRate(Number(e.target.value))}
                    className="w-full accent-[#9AC6E6]"
                  />
                </div>

                <div>
                  <label htmlFor="voice-volume" className="mb-2 flex justify-between text-xs font-medium text-[#DCE6EE]">
                    <span>Playback Volume</span>
                    <span className="font-mono text-[#9AC6E6]">{Math.round(volume * 100)}%</span>
                  </label>
                  <input
                    id="voice-volume"
                    type="range"
                    min={0}
                    max={1}
                    step={0.05}
                    value={volume}
                    onChange={(e) => setVolume(Number(e.target.value))}
                    className="w-full accent-[#9AC6E6]"
                  />
                </div>

                <div>
                  <label
                    htmlFor="followup-listen-seconds"
                    className="mb-2 flex justify-between text-xs font-medium text-[#DCE6EE]"
                  >
                    <span>Follow-Up Listen Window</span>
                    <span className="font-mono text-[#9AC6E6]">{followupListenSeconds}s</span>
                  </label>
                  <input
                    id="followup-listen-seconds"
                    type="range"
                    min={MIN_FOLLOWUP_LISTEN_SECONDS}
                    max={MAX_FOLLOWUP_LISTEN_SECONDS}
                    step={1}
                    value={followupListenSeconds}
                    onChange={(e) => setFollowupListenSeconds(Number(e.target.value))}
                    className="w-full accent-[#9AC6E6]"
                  />
                </div>

                <div>
                  <label
                    htmlFor="barge-in-threshold"
                    className="mb-2 flex justify-between text-xs font-medium text-[#DCE6EE]"
                  >
                    <span>Barge-In RMS Threshold (16-bit PCM)</span>
                    <span className="font-mono text-[#9AC6E6]">{bargeInThreshold}</span>
                  </label>
                  <input
                    id="barge-in-threshold"
                    type="range"
                    min={200}
                    max={6000}
                    step={100}
                    value={bargeInThreshold}
                    onChange={(e) => setBargeInThreshold(Number(e.target.value))}
                    className="w-full accent-[#9AC6E6]"
                  />
                </div>
              </div>

              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                <label
                  className="flex cursor-pointer items-center justify-between rounded-xl px-4 py-3"
                  style={{
                    backgroundColor: '#07090E',
                    border: '1px solid var(--mj-border-subtle)',
                  }}
                >
                  <div>
                    <div className="text-xs font-medium text-[#DCE6EE]">Auto-Listen Follow-Up</div>
                    <div className="text-[11px]" style={{ color: 'var(--mj-text-subtle)' }}>
                      Keep listening for follow-ups after MJ finishes speaking
                    </div>
                  </div>
                  <input
                    type="checkbox"
                    checked={autoListen}
                    onChange={(e) => setAutoListen(e.target.checked)}
                    className="h-4 w-4 accent-[#9AC6E6]"
                  />
                </label>

                <label
                  className="flex cursor-pointer items-center justify-between rounded-xl px-4 py-3"
                  style={{
                    backgroundColor: '#07090E',
                    border: '1px solid var(--mj-border-subtle)',
                  }}
                >
                  <div>
                    <div className="text-xs font-medium text-[#DCE6EE]">Voice Output Enabled</div>
                    <div className="text-[11px]" style={{ color: 'var(--mj-text-subtle)' }}>
                      Play spoken audio from Realtime Voice &amp; TTS
                    </div>
                  </div>
                  <input
                    type="checkbox"
                    checked={voiceOutputEnabled}
                    onChange={(e) => setVoiceOutputEnabled(e.target.checked)}
                    className="h-4 w-4 accent-[#9AC6E6]"
                  />
                </label>

                <label
                  className="flex cursor-pointer items-center justify-between rounded-xl px-4 py-3"
                  style={{
                    backgroundColor: '#07090E',
                    border: '1px solid var(--mj-border-subtle)',
                  }}
                >
                  <div>
                    <div className="text-xs font-medium text-[#DCE6EE]">Auto-Play Chat Replies</div>
                    <div className="text-[11px]" style={{ color: 'var(--mj-text-subtle)' }}>
                      Read completed text replies aloud via /v1/tts
                    </div>
                  </div>
                  <input
                    type="checkbox"
                    checked={autoPlayback}
                    onChange={(e) => setAutoPlayback(e.target.checked)}
                    className="h-4 w-4 accent-[#9AC6E6]"
                  />
                </label>
              </div>
            </Panel>
          )}

          {activeTab === 'appearance' && (
            <Panel className="space-y-5 p-6">
              <div>
                <h2 className="text-base font-medium text-[#EDF3F8]">Appearance &amp; Accessibility</h2>
                <p className="mt-1 text-xs" style={{ color: 'var(--mj-text-muted)' }}>
                  Obsidian Dark visual identity (#07080B / #0D1017 / #121722) with WCAG AA contrast and motion controls.
                </p>
              </div>

              <div>
                <label htmlFor="motion-pref" className="mb-2 block text-xs font-medium text-[#DCE6EE]">
                  Orb &amp; Transition Motion
                </label>
                <select
                  id="motion-pref"
                  value={reducedMotionOverride}
                  onChange={(e) =>
                    setReducedMotionOverride(e.target.value as 'system' | 'reduce' | 'normal')
                  }
                  className="w-full rounded-xl px-3.5 py-2.5 text-sm text-[#EDF3F8] outline-none"
                  style={{
                    backgroundColor: '#07090E',
                    border: '1px solid var(--mj-border-strong)',
                  }}
                >
                  <option value="system">Follow Operating System Setting (Recommended)</option>
                  <option value="reduce">Always Reduce Motion</option>
                  <option value="normal">Standard Smooth Motion</option>
                </select>
              </div>

              <label
                className="flex cursor-pointer items-center justify-between rounded-xl px-4 py-3"
                style={{
                  backgroundColor: '#07090E',
                  border: '1px solid var(--mj-border-subtle)',
                }}
              >
                <div>
                  <div className="text-xs font-medium text-[#DCE6EE]">Compact Chat Density</div>
                  <div className="text-[11px]" style={{ color: 'var(--mj-text-subtle)' }}>
                    Tighter spacing inside conversation message cards
                  </div>
                </div>
                <input
                  type="checkbox"
                  checked={compactDensity}
                  onChange={(e) => setCompactDensity(e.target.checked)}
                  className="h-4 w-4 accent-[#9AC6E6]"
                />
              </label>
            </Panel>
          )}

          {activeTab === 'usage' && (
            <Panel className="space-y-5 p-6">
              <div>
                <h2 className="text-base font-medium text-[#EDF3F8]">Usage Tracking &amp; Budget Caps</h2>
                <p className="mt-1 text-xs" style={{ color: 'var(--mj-text-muted)' }}>
                  Estimated spend combines Responses token usage and realtime voice/TTS activity. Confirm exact per-unit pricing at{' '}
                  <code className="font-mono">console.x.ai</code>.
                </p>
              </div>

              <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
                <MetricTile label="Today Requests" value={String(usage?.today.requestCount ?? 0)} />
                <MetricTile
                  label="Today Voice"
                  value={`${((usage?.today.voiceSeconds ?? 0) / 60).toFixed(1)}m`}
                />
                <MetricTile
                  label="Month Est. Spend"
                  value={`$${(usage?.month.estimatedCostUsd ?? 0).toFixed(4)}`}
                />
                <MetricTile label="Month Errors" value={String(usage?.month.errorCount ?? 0)} />
              </div>

              <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
                <div>
                  <label htmlFor="daily-cap" className="mb-1.5 block text-xs font-medium text-[#DCE6EE]">
                    Daily Budget Cap (USD / day, 0 = off)
                  </label>
                  <input
                    id="daily-cap"
                    type="number"
                    min={0}
                    step={0.5}
                    value={dailyCapUsd}
                    onChange={(e) => setDailyCapUsd(Number(e.target.value))}
                    className="w-full rounded-xl px-3.5 py-2 font-mono text-sm text-[#EDF3F8] outline-none"
                    style={{
                      backgroundColor: '#07090E',
                      border: '1px solid var(--mj-border-strong)',
                    }}
                  />
                </div>
                <div>
                  <label htmlFor="soft-cap" className="mb-1.5 block text-xs font-medium text-[#DCE6EE]">
                    Soft Budget Warning Cap (USD / month)
                  </label>
                  <input
                    id="soft-cap"
                    type="number"
                    min={0}
                    step={0.5}
                    value={softCapUsd}
                    onChange={(e) => setSoftCapUsd(Number(e.target.value))}
                    className="w-full rounded-xl px-3.5 py-2 font-mono text-sm text-[#EDF3F8] outline-none"
                    style={{
                      backgroundColor: '#07090E',
                      border: '1px solid var(--mj-border-strong)',
                    }}
                  />
                </div>
                <div>
                  <label htmlFor="hard-cap" className="mb-1.5 block text-xs font-medium text-[#DCE6EE]">
                    Hard Budget Cap (USD / month, 0 = off)
                  </label>
                  <input
                    id="hard-cap"
                    type="number"
                    min={0}
                    step={0.5}
                    value={hardCapUsd}
                    onChange={(e) => setHardCapUsd(Number(e.target.value))}
                    className="w-full rounded-xl px-3.5 py-2 font-mono text-sm text-[#EDF3F8] outline-none"
                    style={{
                      backgroundColor: '#07090E',
                      border: '1px solid var(--mj-border-strong)',
                    }}
                  />
                </div>
              </div>

              <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
                <div>
                  <label htmlFor="input-rate" className="mb-1 block text-[11px] text-[#9EB0C3]">
                    Input $/1M tokens
                  </label>
                  <input
                    id="input-rate"
                    type="number"
                    min={0}
                    step={0.05}
                    value={inputRate}
                    onChange={(e) => setInputRate(Number(e.target.value))}
                    className="w-full rounded-xl px-3 py-2 font-mono text-xs text-[#EDF3F8] outline-none"
                    style={{
                      backgroundColor: '#07090E',
                      border: '1px solid var(--mj-border-subtle)',
                    }}
                  />
                </div>
                <div>
                  <label htmlFor="output-rate" className="mb-1 block text-[11px] text-[#9EB0C3]">
                    Output $/1M tokens
                  </label>
                  <input
                    id="output-rate"
                    type="number"
                    min={0}
                    step={0.05}
                    value={outputRate}
                    onChange={(e) => setOutputRate(Number(e.target.value))}
                    className="w-full rounded-xl px-3 py-2 font-mono text-xs text-[#EDF3F8] outline-none"
                    style={{
                      backgroundColor: '#07090E',
                      border: '1px solid var(--mj-border-subtle)',
                    }}
                  />
                </div>
                <div>
                  <label htmlFor="cached-rate" className="mb-1 block text-[11px] text-[#9EB0C3]">
                    Cached Input $/1M tokens
                  </label>
                  <input
                    id="cached-rate"
                    type="number"
                    min={0}
                    step={0.05}
                    value={cachedRate}
                    onChange={(e) => setCachedRate(Number(e.target.value))}
                    className="w-full rounded-xl px-3 py-2 font-mono text-xs text-[#EDF3F8] outline-none"
                    style={{
                      backgroundColor: '#07090E',
                      border: '1px solid var(--mj-border-subtle)',
                    }}
                  />
                </div>
                <div>
                  <label htmlFor="voice-rate" className="mb-1 block text-[11px] text-[#9EB0C3]">
                    Realtime Voice $/minute
                  </label>
                  <input
                    id="voice-rate"
                    type="number"
                    min={0}
                    step={0.01}
                    value={voiceRatePerMin}
                    onChange={(e) => setVoiceRatePerMin(Number(e.target.value))}
                    className="w-full rounded-xl px-3 py-2 font-mono text-xs text-[#EDF3F8] outline-none"
                    style={{
                      backgroundColor: '#07090E',
                      border: '1px solid var(--mj-border-subtle)',
                    }}
                  />
                </div>
                <div>
                  <label htmlFor="tts-rate" className="mb-1 block text-[11px] text-[#9EB0C3]">
                    TTS $/1M characters
                  </label>
                  <input
                    id="tts-rate"
                    type="number"
                    min={0}
                    step={0.5}
                    value={ttsRatePerMilChars}
                    onChange={(e) => setTtsRatePerMilChars(Number(e.target.value))}
                    className="w-full rounded-xl px-3 py-2 font-mono text-xs text-[#EDF3F8] outline-none"
                    style={{
                      backgroundColor: '#07090E',
                      border: '1px solid var(--mj-border-subtle)',
                    }}
                  />
                </div>
                <div>
                  <label htmlFor="stt-rate" className="mb-1 block text-[11px] text-[#9EB0C3]">
                    STT $/hour (paid fallback)
                  </label>
                  <input
                    id="stt-rate"
                    type="number"
                    min={0}
                    step={0.01}
                    value={sttRatePerHour}
                    onChange={(e) => setSttRatePerHour(Number(e.target.value))}
                    className="w-full rounded-xl px-3 py-2 font-mono text-xs text-[#EDF3F8] outline-none"
                    style={{
                      backgroundColor: '#07090E',
                      border: '1px solid var(--mj-border-subtle)',
                    }}
                  />
                </div>
              </div>

              {usage && usage.recentEvents.length > 0 && (
                <div>
                  <div className="mb-2 text-xs font-medium text-[#DCE6EE]">Recent API &amp; Voice Events</div>
                  <div
                    className="max-h-48 overflow-auto rounded-xl"
                    style={{ border: '1px solid var(--mj-border-subtle)' }}
                  >
                    <table className="w-full text-left font-mono text-[11px]">
                      <thead style={{ backgroundColor: 'rgba(255, 255, 255, 0.03)', color: 'var(--mj-text-subtle)' }}>
                        <tr>
                          <th className="px-3 py-2">Kind</th>
                          <th className="px-3 py-2">Model</th>
                          <th className="px-3 py-2">Status</th>
                          <th className="px-3 py-2">Vol</th>
                          <th className="px-3 py-2">Est. Cost</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y" style={{ borderColor: 'var(--mj-border-subtle)' }}>
                        {usage.recentEvents.map((ev) => (
                          <tr key={ev.id}>
                            <td className="px-3 py-2 text-[#9AC6E6]">{ev.kind}</td>
                            <td className="px-3 py-2 text-[#DCE6EE]">{ev.model}</td>
                            <td
                              className="px-3 py-2"
                              style={{
                                color:
                                  ev.status === 'success'
                                    ? 'var(--mj-status-good)'
                                    : ev.status === 'aborted'
                                      ? 'var(--mj-status-warn)'
                                      : 'var(--mj-status-error)',
                              }}
                            >
                              {ev.status}
                              {ev.errorCode ? ` (${ev.errorCode})` : ''}
                            </td>
                            <td className="px-3 py-2 text-[#9EB0C3]">
                              {ev.kind === 'voice_realtime' ? `${ev.voiceSeconds}s` : `${ev.totalTokens}t`}
                            </td>
                            <td className="px-3 py-2 text-[#9EB0C3]">${ev.estimatedCostUsd.toFixed(5)}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>
              )}
            </Panel>
          )}

          {activeTab === 'security' && (
            <Panel className="space-y-5 p-6">
              <div>
                <h2 className="text-base font-medium text-[#EDF3F8]">Security &amp; Stage Roadmap</h2>
                <p className="mt-1 text-xs" style={{ color: 'var(--mj-text-muted)' }}>
                  Stage 2 enforces strict backend credential isolation for both text and realtime voice via ephemeral client secrets.
                </p>
              </div>

              <ul className="space-y-2.5 text-xs">
                <li
                  className="flex items-center justify-between rounded-xl px-4 py-3"
                  style={{ backgroundColor: '#07090E', border: '1px solid var(--mj-border-subtle)' }}
                >
                  <span className="text-[#DCE6EE]">Provider Permanent Key Exposure</span>
                  <span style={{ color: 'var(--mj-status-good)' }}>Blocked (Server-Only)</span>
                </li>
                <li
                  className="flex items-center justify-between rounded-xl px-4 py-3"
                  style={{ backgroundColor: '#07090E', border: '1px solid var(--mj-border-subtle)' }}
                >
                  <span className="text-[#DCE6EE]">Realtime Voice Browser Auth</span>
                  <span className="font-mono text-[#C7E3F5]">Ephemeral Client Secret (300s TTL)</span>
                </li>
                <li
                  className="flex items-center justify-between rounded-xl px-4 py-3"
                  style={{ backgroundColor: '#07090E', border: '1px solid var(--mj-border-subtle)' }}
                >
                  <span className="text-[#DCE6EE]">Microphone Privacy Rule</span>
                  <span style={{ color: 'var(--mj-status-good)' }}>Explicit Click Only · Visible Live State</span>
                </li>
                <li
                  className="flex items-center justify-between rounded-xl px-4 py-3"
                  style={{ backgroundColor: '#07090E', border: '1px solid var(--mj-border-subtle)' }}
                >
                  <span className="text-[#DCE6EE]">Session Cookie Mode</span>
                  <span className="font-mono text-[#C7E3F5]">
                    {session?.mode === 'passcode' ? 'HMAC HttpOnly + Passcode' : 'HMAC HttpOnly (Local Dev)'}
                  </span>
                </li>
              </ul>

              <div>
                <div className="mb-2 text-xs font-medium text-[#DCE6EE]">
                  Master Plan Progress
                </div>
                <div className="grid grid-cols-1 gap-2 text-xs sm:grid-cols-2">
                  {(
                    [
                      ['Stage 1 (Active)', 'Web Dashboard, Multi-Provider AI Text Chat & Security'],
                      ['Stage 2 (Active)', 'Gemini Live Voice, Free Browser Fallback & Bangla/Banglish'],
                      ['Stage 3 (Planned)', 'Long-Term Memory, Tool Calling, Web Search, Files & Automation'],
                      ['Stage 4 (Active)', 'Windows Tauri Companion, Granular Permissions & Audit Log'],
                      ['Stage 5 (Active)', 'Usage & Spend-vs-Budget Dashboard, Latency & Delivery Package'],
                    ] as const
                  ).map(([stage, desc]) => (
                    <div
                      key={stage}
                      className="rounded-xl p-3"
                      style={{
                        backgroundColor: 'rgba(255, 255, 255, 0.02)',
                        border: '1px solid var(--mj-border-subtle)',
                      }}
                    >
                      <div
                        className="font-mono text-[11px]"
                        style={{
                          color: stage.includes('Active')
                            ? 'var(--mj-status-good)'
                            : 'var(--mj-accent-blue)',
                        }}
                      >
                        {stage}
                      </div>
                      <div className="mt-1" style={{ color: 'var(--mj-text-muted)' }}>
                        {desc}
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            </Panel>
          )}

          {activeTab !== 'security' && (
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div className="text-xs">
                {errorText && <span style={{ color: 'var(--mj-status-error)' }}>{errorText}</span>}
                {savedNotice && (
                  <span className="inline-flex items-center gap-1.5" style={{ color: 'var(--mj-status-good)' }}>
                    <Check className="h-4 w-4" />
                    Settings saved to local SQLite store.
                  </span>
                )}
              </div>

              <button
                type="submit"
                disabled={saving}
                className="inline-flex items-center gap-2 rounded-xl px-4 py-2.5 text-xs font-medium transition disabled:opacity-50"
                style={{
                  background: 'linear-gradient(145deg, #DCEEF9, #9AC6E6)',
                  color: '#070B11',
                }}
              >
                <Save className="h-4 w-4" />
                <span>{saving ? 'Saving…' : 'Save Changes'}</span>
              </button>
            </div>
          )}
        </form>
      </div>
    </div>
  );
}

function MetricTile({ label, value }: { label: string; value: string }) {
  return (
    <div
      className="rounded-xl p-3"
      style={{
        backgroundColor: '#07090E',
        border: '1px solid var(--mj-border-subtle)',
      }}
    >
      <div className="text-[11px]" style={{ color: 'var(--mj-text-subtle)' }}>
        {label}
      </div>
      <div className="mt-1 font-mono text-base font-medium text-[#EDF3F8] tabular-nums">
        {value}
      </div>
    </div>
  );
}
