import { useEffect, useState, type FormEvent } from 'react';
import {
  Activity,
  AlertTriangle,
  AudioLines,
  BellRing,
  Check,
  Cpu,
  Database,
  DollarSign,
  Gauge,
  Globe,
  Laptop,
  Radio,
  RefreshCw,
  Save,
  Server,
  ShieldCheck,
  Wifi,
} from 'lucide-react';
import { Panel, StatusPill } from '@mj/ui';
import { VOICE_STATE_META } from '@mj/voice';
import {
  MJ_ACTIVE_STAGE,
  resolveProviderDisplay,
  type ConnectivityCheckDTO,
  type PublicSettingsDTO,
  type SystemHealthDTO,
  type UsageKind,
  type UsageSummaryDTO,
  VoiceState,
} from '@mj/shared';
import { isTauriDesktop } from '../desktop/desktopBridge.js';

interface UsageDashboardViewProps {
  health: SystemHealthDTO | null;
  backendLatencyMs: number | null;
  online: boolean;
  voiceState: VoiceState;
  settings: PublicSettingsDTO | null;
  usage: UsageSummaryDTO | null;
  connectivityCheck: ConnectivityCheckDTO | null;
  checkingConnectivity: boolean;
  onRefreshUsage: () => Promise<void>;
  onCheckConnectivity: () => Promise<void>;
  onSaveSettings: (patch: Record<string, unknown>) => Promise<void>;
}

const CHANNEL_LABELS: Record<UsageKind, { title: string; unit: 'tokens' | 'seconds' }> = {
  text: { title: 'Grok Responses Text', unit: 'tokens' },
  voice_realtime: { title: 'Realtime Speech-to-Speech', unit: 'seconds' },
  tts: { title: 'Text-to-Speech (/v1/tts)', unit: 'tokens' },
  stt: { title: 'Speech-to-Text (/v1/stt)', unit: 'seconds' },
};

function describeWebsocketStatus(voiceState: VoiceState): {
  label: string;
  tone: 'good' | 'warn' | 'error' | 'neutral';
} {
  switch (voiceState) {
    case 'listening':
    case 'processing':
    case 'speaking':
    case 'interrupted':
      return { label: `Open (${VOICE_STATE_META[voiceState].label})`, tone: 'good' };
    case 'requesting_permission':
    case 'connecting':
    case 'reconnecting':
      return { label: VOICE_STATE_META[voiceState].label, tone: 'warn' };
    case 'error':
      return { label: 'Disconnected (Error)', tone: 'error' };
    default:
      return { label: 'Standby (Idle)', tone: 'neutral' };
  }
}

export function UsageDashboardView({
  health,
  backendLatencyMs,
  online,
  voiceState,
  settings,
  usage,
  connectivityCheck,
  checkingConnectivity,
  onRefreshUsage,
  onCheckConnectivity,
  onSaveSettings,
}: UsageDashboardViewProps) {
  const [dailyCapUsd, setDailyCapUsd] = useState(2);
  const [softCapUsd, setSoftCapUsd] = useState(10);
  const [hardCapUsd, setHardCapUsd] = useState(25);
  const [inputRate, setInputRate] = useState(2);
  const [outputRate, setOutputRate] = useState(6);
  const [cachedRate, setCachedRate] = useState(0.5);
  const [voiceRatePerMin, setVoiceRatePerMin] = useState(0.05);
  const [ttsRatePerMilChars, setTtsRatePerMilChars] = useState(15);
  const [sttRatePerHour, setSttRatePerHour] = useState(0.1);
  const [savingBudget, setSavingBudget] = useState(false);
  const [saveNotice, setSaveNotice] = useState(false);
  const [errorText, setErrorText] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);

  useEffect(() => {
    if (!settings) return;
    setDailyCapUsd(settings.budget.dailyCapUsd ?? 2);
    setSoftCapUsd(settings.budget.softCapUsd);
    setHardCapUsd(settings.budget.hardCapUsd);
    setInputRate(settings.budget.inputRatePerMillionUsd);
    setOutputRate(settings.budget.outputRatePerMillionUsd);
    setCachedRate(settings.budget.cachedInputRatePerMillionUsd);
    setVoiceRatePerMin(settings.budget.voiceRatePerMinuteUsd);
    setTtsRatePerMilChars(settings.budget.ttsRatePerMillionCharsUsd);
    setSttRatePerHour(settings.budget.sttRatePerHourUsd);
  }, [settings]);

  const inTauri = isTauriDesktop();
  const apiKeyReady = settings?.apiKeyConfigured ?? health?.aiEngine === 'ready';
  const backendOnline = health?.backend === 'online';
  const dbHealthy = health?.database === 'healthy';
  const wsStatus = describeWebsocketStatus(voiceState);

  const monthSpend = usage?.month.estimatedCostUsd ?? 0;
  const daySpend = usage?.today.estimatedCostUsd ?? 0;
  const dailyCap = usage?.budgetStatus.dailyCapUsd ?? dailyCapUsd;
  const dailyLevel =
    usage?.budgetStatus.dailyLevel ??
    (dailyCap > 0 && daySpend >= dailyCap ? 'daily_cap_exceeded' : 'ok');
  const dailyExceeded = dailyLevel === 'daily_cap_exceeded';
  const dailyProgressPct =
    dailyCap > 0 ? Math.min(100, Number(((daySpend / dailyCap) * 100).toFixed(1))) : 0;
  const dailyRemaining =
    usage?.budgetStatus.remainingDailyCapUsd ??
    (dailyCap > 0 ? Math.max(0, dailyCap - daySpend) : null);
  const dailyOverAmount = dailyCap > 0 ? Math.max(0, daySpend - dailyCap) : 0;

  const hardCap = usage?.budgetStatus.hardCapUsd ?? hardCapUsd;
  const softCap = usage?.budgetStatus.softCapUsd ?? softCapUsd;
  const budgetLevel = usage?.budgetStatus.level ?? 'ok';

  const progressPct =
    hardCap > 0
      ? Math.min(100, Number(((monthSpend / hardCap) * 100).toFixed(1)))
      : softCap > 0
        ? Math.min(100, Number(((monthSpend / softCap) * 100).toFixed(1)))
        : 0;
  const softMarkerPct =
    hardCap > 0 && softCap > 0 && softCap <= hardCap
      ? Math.round((softCap / hardCap) * 100)
      : null;

  const remainingHard =
    usage?.budgetStatus.remainingHardCapUsd ??
    (hardCap > 0 ? Math.max(0, hardCap - monthSpend) : null);
  const remainingSoft =
    usage?.budgetStatus.remainingSoftCapUsd ??
    (softCap > 0 ? Math.max(0, softCap - monthSpend) : null);

  const monthErrors = usage?.month.errorCount ?? 0;
  const monthRequests = usage?.month.requestCount ?? 0;
  const errorRatePct =
    monthRequests > 0 ? ((monthErrors / monthRequests) * 100).toFixed(1) : '0.0';
  const alerting = usage?.alerting;

  const handleRefresh = async () => {
    setRefreshing(true);
    try {
      await onRefreshUsage();
    } finally {
      setRefreshing(false);
    }
  };

  const handleSaveBudget = async (e: FormEvent) => {
    e.preventDefault();
    setSavingBudget(true);
    setErrorText(null);
    setSaveNotice(false);
    try {
      await onSaveSettings({
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
      await onRefreshUsage();
      setSaveNotice(true);
    } catch (err) {
      setErrorText(err instanceof Error ? err.message : 'Failed to update budget settings.');
    } finally {
      setSavingBudget(false);
    }
  };

  const providerDisplay = resolveProviderDisplay({
    activeProvider: settings?.activeProvider ?? health?.activeProvider,
    activeModel: settings?.activeModel ?? health?.activeModel,
    activeVoiceModel: settings?.voice.voiceModel ?? health?.activeVoiceModel,
    apiBaseHost: settings?.apiBaseHost ?? health?.apiBaseHost,
    providers: settings?.providers,
  });

  return (
    <div className="mx-auto w-full max-w-[1380px] space-y-5 px-4 py-6 sm:px-8 lg:py-8">
      {/* Header */}
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <div
            className="text-[11px] font-medium tracking-[0.2em] uppercase"
            style={{ color: 'var(--mj-text-subtle)' }}
          >
            SECTION 16 · PERFORMANCE, USAGE &amp; BUDGET MONITORING
          </div>
          <h1 className="mt-1 text-2xl font-normal text-[#EDF3F8]">
            Usage &amp; System Monitor
          </h1>
          <p className="mt-1 text-xs" style={{ color: 'var(--mj-text-muted)' }}>
            Live runtime status, token and voice consumption, request latency, error counts, and spend vs budget caps.
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2.5">
          <button
            type="button"
            onClick={() => void handleRefresh()}
            disabled={refreshing}
            className="inline-flex items-center gap-1.5 rounded-xl px-3.5 py-2 text-xs font-medium transition hover:bg-white/5 disabled:opacity-50"
            style={{
              backgroundColor: 'rgba(255, 255, 255, 0.03)',
              border: '1px solid var(--mj-border-strong)',
              color: 'var(--mj-text-secondary)',
            }}
          >
            <RefreshCw className={`h-3.5 w-3.5 ${refreshing ? 'animate-spin' : ''}`} />
            Refresh Metrics
          </button>
          <button
            type="button"
            onClick={() => void onCheckConnectivity()}
            disabled={checkingConnectivity}
            className="inline-flex items-center gap-1.5 rounded-xl px-3.5 py-2 text-xs font-medium transition disabled:opacity-50"
            style={{
              background:
                'linear-gradient(145deg, rgba(160, 205, 234, 0.24), rgba(116, 166, 201, 0.12))',
              border: '1px solid rgba(199, 227, 245, 0.35)',
              color: 'var(--mj-accent-ice)',
            }}
          >
            <Radio className={`h-3.5 w-3.5 ${checkingConnectivity ? 'animate-pulse' : ''}`} />
            {checkingConnectivity
              ? providerDisplay.checkingButtonLabel
              : providerDisplay.verifyButtonLabel}
          </button>
        </div>
      </div>

      {/* Live Model Probe Banner */}
      {connectivityCheck && (
        <Panel
          className="flex flex-wrap items-center justify-between gap-3 px-4 py-3 text-xs"
          style={{
            borderColor: connectivityCheck.xaiReachable
              ? 'rgba(127, 209, 174, 0.35)'
              : 'rgba(240, 138, 138, 0.35)',
          }}
        >
          <div className="space-y-0.5">
            <div className="flex flex-wrap items-center gap-2 font-medium text-[#EDF3F8]">
              <StatusPill tone={connectivityCheck.xaiReachable ? 'good' : 'error'}>
                {connectivityCheck.xaiReachable
                  ? providerDisplay.verifiedPillLabel
                  : 'Live Check Failed'}
              </StatusPill>
              <span>{connectivityCheck.note}</span>
            </div>
            <div className="font-mono text-[11px]" style={{ color: 'var(--mj-text-muted)' }}>
              Text Model: {connectivityCheck.modelChecked}
              {connectivityCheck.modelAvailable === true
                ? ' (listed)'
                : connectivityCheck.modelAvailable === false
                  ? ' (not listed)'
                  : ''}
              {' · '}Voice Model: {connectivityCheck.voiceModelChecked}
              {connectivityCheck.availableVoiceCount !== null
                ? ` (${connectivityCheck.availableVoiceCount} voices available)`
                : ''}
              {connectivityCheck.latencyMs !== null ? ` · ${connectivityCheck.latencyMs}ms` : ''}
            </div>
          </div>
          <span className="font-mono text-[10px]" style={{ color: 'var(--mj-text-subtle)' }}>
            Checked {new Date(connectivityCheck.checkedAt).toLocaleTimeString()}
          </span>
        </Panel>
      )}

      {/* System & Infrastructure Health Strip (Section 16 Dashboard Information) */}
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-6">
        <StatusCard
          icon={<Cpu className="h-4 w-4" />}
          label="AI Engine"
          value={
            connectivityCheck
              ? connectivityCheck.xaiReachable
                ? 'Connected (Verified)'
                : 'Disconnected'
              : apiKeyReady
                ? 'Connected (Configured)'
                : 'Disconnected (Key Missing)'
          }
          detail={`Model: ${settings?.activeModel ?? health?.activeModel ?? 'unconfigured'}`}
          tone={
            connectivityCheck
              ? connectivityCheck.xaiReachable
                ? 'good'
                : 'error'
              : apiKeyReady
                ? 'good'
                : 'warn'
          }
        />
        <StatusCard
          icon={<AudioLines className="h-4 w-4" />}
          label="Voice Engine"
          value={apiKeyReady ? 'Connected' : 'Disconnected'}
          detail={`${settings?.voice.voiceModel ?? health?.activeVoiceModel ?? providerDisplay.voiceLiveLabel}`}
          tone={apiKeyReady ? 'good' : 'warn'}
        />
        <StatusCard
          icon={<Wifi className="h-4 w-4" />}
          label="WebSocket Health"
          value={wsStatus.label}
          detail={providerDisplay.voiceEndpoint}
          tone={wsStatus.tone}
        />
        <StatusCard
          icon={<Server className="h-4 w-4" />}
          label="Backend"
          value={backendOnline ? 'Online' : 'Offline'}
          detail={
            backendOnline
              ? `${backendLatencyMs !== null ? `${backendLatencyMs}ms ping · ` : ''}up ${health?.uptimeSeconds ?? 0}s`
              : 'Fastify server unreachable'
          }
          tone={backendOnline ? 'good' : 'error'}
        />
        <StatusCard
          icon={<Database className="h-4 w-4" />}
          label="Database"
          value={dbHealthy ? 'Healthy' : 'Unavailable'}
          detail="Local-first SQLite WAL"
          tone={dbHealthy ? 'good' : 'error'}
        />
        <StatusCard
          icon={<Laptop className="h-4 w-4" />}
          label="Network & Desktop"
          value={online ? 'Network Connected' : 'Network Offline'}
          detail={inTauri ? 'Desktop: Tauri Native' : 'Desktop: Browser Host Bridge'}
          tone={online ? 'good' : 'warn'}
        />
      </div>

      {/* Spend-vs-Budget Hero Panel (Section 02 & Section 16) */}
      <Panel elevated className="space-y-5 p-6">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <div className="flex items-center gap-2">
              <DollarSign className="h-4 w-4" style={{ color: 'var(--mj-accent-ice)' }} />
              <h2 className="text-base font-medium text-[#EDF3F8]">
                Billing Period Spend vs Budget Cap
              </h2>
            </div>
            <p className="mt-1 text-xs" style={{ color: 'var(--mj-text-muted)' }}>
              Estimated billing-period consumption across Responses tokens, Realtime Voice audio, TTS, and STT. Verify live unit pricing at{' '}
              <code className="font-mono">console.x.ai</code>.
            </p>
          </div>

          <StatusPill
            tone={
              budgetLevel === 'hard_cap_reached'
                ? 'error'
                : dailyExceeded || budgetLevel === 'soft_cap_warning'
                  ? 'warn'
                  : 'good'
            }
          >
            {budgetLevel === 'hard_cap_reached'
              ? 'Hard Cap Reached (Requests Paused)'
              : dailyExceeded
                ? 'Daily Spend Budget Crossed'
                : budgetLevel === 'soft_cap_warning'
                  ? 'Soft Warning Threshold Exceeded'
                  : 'Within Monthly & Daily Budget'}
          </StatusPill>
        </div>

        {/* Daily Spend vs Budget Warning Alert */}
        {(dailyExceeded || budgetLevel !== 'ok') && (
          <div
            role="alert"
            className="flex flex-wrap items-start gap-2.5 rounded-2xl px-4 py-3 text-xs"
            style={{
              backgroundColor:
                budgetLevel === 'hard_cap_reached' || dailyExceeded
                  ? 'rgba(240, 138, 138, 0.1)'
                  : 'rgba(227, 190, 126, 0.1)',
              border:
                budgetLevel === 'hard_cap_reached' || dailyExceeded
                  ? '1px solid rgba(240, 138, 138, 0.38)'
                  : '1px solid rgba(227, 190, 126, 0.38)',
              color:
                budgetLevel === 'hard_cap_reached' || dailyExceeded
                  ? '#F8C7C7'
                  : '#F4DFB4',
            }}
          >
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
            <div className="space-y-1">
              {dailyExceeded && (
                <div>
                  <strong className="font-medium">Daily Budget Warning:</strong> Today&apos;s estimated spend (
                  <span className="font-mono">${daySpend.toFixed(4)}</span>) crossed your daily budget (
                  <span className="font-mono">${dailyCap.toFixed(2)}</span>
                  {dailyOverAmount > 0 ? ` — $${dailyOverAmount.toFixed(4)} over` : ''}).
                </div>
              )}
              {budgetLevel === 'hard_cap_reached' && (
                <div>
                  <strong className="font-medium">Monthly Hard Cap Reached:</strong> New paid AI/voice requests are paused until the hard cap is raised.
                </div>
              )}
              {budgetLevel === 'soft_cap_warning' && (
                <div>
                  <strong className="font-medium">Monthly Soft Warning:</strong> Monthly spend reached ${monthSpend.toFixed(4)} (soft cap ${softCap.toFixed(2)}).
                </div>
              )}
            </div>
          </div>
        )}

        {/* Daily Spend vs Daily Budget Bar */}
        <div
          className="rounded-2xl p-4"
          style={{
            backgroundColor: '#07090E',
            border: dailyExceeded
              ? '1px solid rgba(240, 138, 138, 0.35)'
              : '1px solid var(--mj-border-subtle)',
          }}
        >
          <div className="mb-2 flex flex-wrap items-baseline justify-between gap-2">
            <div className="flex items-baseline gap-2">
              <span className="font-mono text-xl font-medium text-[#EDF3F8] tabular-nums">
                ${daySpend.toFixed(4)}
              </span>
              <span className="text-xs" style={{ color: 'var(--mj-text-muted)' }}>
                spent today vs daily budget
              </span>
            </div>
            <div
              className="font-mono text-xs"
              style={{
                color: dailyExceeded
                  ? 'var(--mj-status-error)'
                  : dailyProgressPct >= 80
                    ? 'var(--mj-status-warn)'
                    : 'var(--mj-accent-ice)',
              }}
            >
              {dailyCap > 0
                ? `${dailyProgressPct}% of $${dailyCap.toFixed(2)} daily budget`
                : 'Daily budget alert Off ($0)'}
            </div>
          </div>

          <div
            role="progressbar"
            aria-label="Daily spend against daily budget"
            aria-valuenow={Math.round(dailyProgressPct)}
            aria-valuemin={0}
            aria-valuemax={100}
            className="h-2.5 w-full overflow-hidden rounded-full"
            style={{ backgroundColor: 'rgba(255, 255, 255, 0.08)' }}
          >
            <div
              className="h-full rounded-full transition-all"
              style={{
                width: `${daySpend > 0 && dailyCap > 0 ? Math.max(dailyProgressPct, 2) : 0}%`,
                background: dailyExceeded
                  ? 'var(--mj-status-error)'
                  : dailyProgressPct >= 80
                    ? 'var(--mj-status-warn)'
                    : 'linear-gradient(90deg, #5F8EAE, #7FD1AE)',
              }}
            />
          </div>

          <div
            className="mt-2 flex flex-wrap items-center justify-between gap-2 font-mono text-[11px]"
            style={{ color: 'var(--mj-text-subtle)' }}
          >
            <span>
              Daily Status:{' '}
              <strong style={{ color: dailyExceeded ? 'var(--mj-status-error)' : 'var(--mj-status-good)' }}>
                {dailyExceeded ? 'EXCEEDED' : 'WITHIN LIMIT'}
              </strong>
            </span>
            <span>
              {dailyRemaining !== null
                ? dailyExceeded
                  ? `$${dailyOverAmount.toFixed(4)} over daily budget`
                  : `$${dailyRemaining.toFixed(4)} remaining today`
                : 'Set a Daily Budget ($) below to enable daily alerts'}
            </span>
          </div>
        </div>

        {/* Visual Progress Bar */}
        <div
          className="rounded-2xl p-4"
          style={{
            backgroundColor: '#07090E',
            border: '1px solid var(--mj-border-subtle)',
          }}
        >
          <div className="mb-2 flex flex-wrap items-baseline justify-between gap-2">
            <div className="flex items-baseline gap-2">
              <span className="font-mono text-2xl font-medium text-[#EDF3F8] tabular-nums">
                ${monthSpend.toFixed(4)}
              </span>
              <span className="text-xs" style={{ color: 'var(--mj-text-muted)' }}>
                spent this month
              </span>
            </div>
            <div className="font-mono text-xs" style={{ color: 'var(--mj-accent-ice)' }}>
              {hardCap > 0
                ? `${progressPct}% of $${hardCap.toFixed(2)} hard cap`
                : softCap > 0
                  ? `${progressPct}% of $${softCap.toFixed(2)} soft cap`
                  : 'No hard cap configured'}
            </div>
          </div>

          <div
            role="progressbar"
            aria-label="Monthly spend against budget cap"
            aria-valuenow={Math.round(progressPct)}
            aria-valuemin={0}
            aria-valuemax={100}
            className="relative h-3 w-full overflow-hidden rounded-full"
            style={{ backgroundColor: 'rgba(255, 255, 255, 0.08)' }}
          >
            <div
              className="h-full rounded-full transition-all"
              style={{
                width: `${monthSpend > 0 ? Math.max(progressPct, 2) : 0}%`,
                background:
                  budgetLevel === 'hard_cap_reached'
                    ? 'var(--mj-status-error)'
                    : budgetLevel === 'soft_cap_warning'
                      ? 'var(--mj-status-warn)'
                      : 'linear-gradient(90deg, #5F8EAE, #B3D6EC)',
              }}
            />
            {softMarkerPct !== null && softMarkerPct > 0 && softMarkerPct < 100 && (
              <div
                title={`Soft warning cap ($${softCap.toFixed(2)})`}
                className="absolute top-0 bottom-0 w-0.5 bg-[#E3BE7E]"
                style={{ left: `${softMarkerPct}%` }}
              />
            )}
          </div>

          <div
            className="mt-2.5 flex flex-wrap items-center justify-between gap-2 font-mono text-[11px]"
            style={{ color: 'var(--mj-text-subtle)' }}
          >
            <span>Today Est.: ${daySpend.toFixed(4)}</span>
            <span>
              Soft Warning Cap: {softCap > 0 ? `$${softCap.toFixed(2)}` : 'Off'}
              {remainingSoft !== null ? ` ($${remainingSoft.toFixed(4)} left)` : ''}
            </span>
            <span>
              Hard Pause Cap: {hardCap > 0 ? `$${hardCap.toFixed(2)}` : 'Off'}
              {remainingHard !== null ? ` ($${remainingHard.toFixed(4)} left)` : ''}
            </span>
          </div>
        </div>

        {/* Summary KPI Grid */}
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
          <MetricBox label="Month Requests" value={String(monthRequests)} />
          <MetricBox
            label="Month Errors"
            value={`${monthErrors} (${errorRatePct}%)`}
            warn={monthErrors > 0}
          />
          <MetricBox label="Avg Latency" value={`${usage?.month.avgLatencyMs ?? 0}ms`} />
          <MetricBox
            label="Total Tokens"
            value={(usage?.month.totalTokens ?? 0).toLocaleString()}
          />
          <MetricBox
            label="Voice Time (Mo)"
            value={`${((usage?.month.voiceSeconds ?? 0) / 60).toFixed(1)}m`}
          />
          <MetricBox
            label="Today Requests"
            value={String(usage?.today.requestCount ?? 0)}
          />
        </div>

        {/* Channel Breakdown Cards */}
        {usage && (
          <div>
            <div className="mb-2.5 flex items-center gap-2 text-xs font-medium text-[#DCE6EE]">
              <Gauge className="h-3.5 w-3.5 text-[#9AC6E6]" />
              Consumption Breakdown by Channel (This Month)
            </div>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
              {(['text', 'voice_realtime', 'tts', 'stt'] as UsageKind[]).map((kind) => {
                const stats = usage.month.byKind[kind];
                const meta = CHANNEL_LABELS[kind];
                const channelTitle = kind === 'text' ? providerDisplay.textChannelTitle : meta.title;

                return (
                  <div
                    key={kind}
                    className="rounded-xl p-3.5 text-xs"
                    style={{
                      backgroundColor: '#07090E',
                      border: '1px solid var(--mj-border-subtle)',
                    }}
                  >
                    <div className="font-medium text-[#EDF3F8]">{channelTitle}</div>
                    <div className="mt-2 grid grid-cols-2 gap-y-1 font-mono text-[11px]">
                      <span style={{ color: 'var(--mj-text-subtle)' }}>Requests</span>
                      <span className="text-right text-[#C7E3F5]">{stats.requests}</span>
                      <span style={{ color: 'var(--mj-text-subtle)' }}>Errors</span>
                      <span
                        className="text-right"
                        style={{
                          color:
                            stats.errors > 0 ? 'var(--mj-status-error)' : 'var(--mj-text-muted)',
                        }}
                      >
                        {stats.errors}
                      </span>
                      <span style={{ color: 'var(--mj-text-subtle)' }}>Volume</span>
                      <span className="text-right text-[#9EB0C3]">
                        {meta.unit === 'seconds'
                          ? `${stats.voiceSeconds}s`
                          : `${stats.totalTokens.toLocaleString()}t`}
                      </span>
                      <span style={{ color: 'var(--mj-text-subtle)' }}>Avg Latency</span>
                      <span className="text-right text-[#9EB0C3]">{stats.avgLatencyMs}ms</span>
                      <span style={{ color: 'var(--mj-text-subtle)' }}>Est. Cost</span>
                      <span className="text-right text-[#7FD1AE]">
                        ${stats.estimatedCostUsd.toFixed(4)}
                      </span>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        )}
      </Panel>

      {/* Budget Caps & Rate Configuration + Recent Activity Table */}
      <div className="grid grid-cols-1 gap-5 lg:grid-cols-[380px_minmax(0,1fr)]">
        <Panel className="space-y-4 p-5">
          <div>
            <h2 className="text-sm font-medium text-[#EDF3F8]">Budget Thresholds &amp; Unit Rates</h2>
            <p className="mt-1 text-[11px]" style={{ color: 'var(--mj-text-muted)' }}>
              Soft warning triggers alert state; hard cap blocks new requests cleanly before overrun.
            </p>
          </div>

          <form onSubmit={handleSaveBudget} className="space-y-3">
            <div className="grid grid-cols-2 gap-2.5">
              <NumberField id="dash-daily-cap" label="Daily Budget ($)" value={dailyCapUsd} step={0.25} onChange={setDailyCapUsd} />
              <NumberField id="dash-soft-cap" label="Monthly Soft ($)" value={softCapUsd} step={0.5} onChange={setSoftCapUsd} />
              <NumberField id="dash-hard-cap" label="Monthly Hard ($)" value={hardCapUsd} step={0.5} onChange={setHardCapUsd} />
              <NumberField id="dash-in-rate" label="Input $/1M" value={inputRate} step={0.05} onChange={setInputRate} />
              <NumberField id="dash-out-rate" label="Output $/1M" value={outputRate} step={0.05} onChange={setOutputRate} />
              <NumberField id="dash-cache-rate" label="Cached $/1M" value={cachedRate} step={0.05} onChange={setCachedRate} />
              <NumberField id="dash-voice-rate" label="Voice $/min" value={voiceRatePerMin} step={0.01} onChange={setVoiceRatePerMin} />
              <NumberField id="dash-tts-rate" label="TTS $/1M ch" value={ttsRatePerMilChars} step={0.5} onChange={setTtsRatePerMilChars} />
              <NumberField id="dash-stt-rate" label="STT $/hour" value={sttRatePerHour} step={0.05} onChange={setSttRatePerHour} />
            </div>

            {errorText && (
              <div className="flex items-center gap-1.5 text-xs" style={{ color: 'var(--mj-status-error)' }}>
                <AlertTriangle className="h-3.5 w-3.5 shrink-0" />
                <span>{errorText}</span>
              </div>
            )}
            {saveNotice && (
              <div className="flex items-center gap-1.5 text-xs" style={{ color: 'var(--mj-status-good)' }}>
                <Check className="h-3.5 w-3.5 shrink-0" />
                <span>Budget configuration saved.</span>
              </div>
            )}

            <button
              type="submit"
              disabled={savingBudget}
              className="inline-flex w-full items-center justify-center gap-2 rounded-xl px-4 py-2.5 text-xs font-medium transition disabled:opacity-50"
              style={{
                background:
                  'linear-gradient(145deg, rgba(160, 205, 234, 0.28), rgba(116, 166, 201, 0.16))',
                border: '1px solid rgba(199, 227, 245, 0.38)',
                color: '#EFF7FC',
              }}
            >
              <Save className="h-3.5 w-3.5" />
              {savingBudget ? 'Saving Budget…' : 'Save Budget & Rates'}
            </button>
          </form>
        </Panel>

        <Panel className="space-y-4 p-5">
          <div className="flex items-center justify-between gap-2">
            <div className="flex items-center gap-2">
              <Activity className="h-4 w-4" style={{ color: 'var(--mj-accent-ice)' }} />
              <h2 className="text-sm font-medium text-[#EDF3F8]">Recent API &amp; Voice Activity</h2>
            </div>
            <span className="font-mono text-[11px]" style={{ color: 'var(--mj-text-subtle)' }}>
              {usage?.recentEvents.length ?? 0} latest events
            </span>
          </div>

          {!usage || usage.recentEvents.length === 0 ? (
            <div
              className="rounded-xl p-5 text-xs"
              style={{
                backgroundColor: '#07090E',
                border: '1px solid var(--mj-border-subtle)',
                color: 'var(--mj-text-muted)',
              }}
            >
              No API requests or voice sessions recorded yet. Send a chat message or start a voice session to populate live latency, token, and cost telemetry.
            </div>
          ) : (
            <div
              className="max-h-80 overflow-auto rounded-xl"
              style={{ border: '1px solid var(--mj-border-subtle)' }}
            >
              <table className="w-full text-left font-mono text-[11px]">
                <thead style={{ backgroundColor: 'rgba(255, 255, 255, 0.03)', color: 'var(--mj-text-subtle)' }}>
                  <tr>
                    <th className="px-3 py-2">Time</th>
                    <th className="px-3 py-2">Channel</th>
                    <th className="px-3 py-2">Model</th>
                    <th className="px-3 py-2">Status</th>
                    <th className="px-3 py-2">Volume</th>
                    <th className="px-3 py-2">Latency</th>
                    <th className="px-3 py-2">Est. Cost</th>
                  </tr>
                </thead>
                <tbody className="divide-y" style={{ borderColor: 'var(--mj-border-subtle)' }}>
                  {usage.recentEvents.map((ev) => (
                    <tr key={ev.id}>
                      <td className="px-3 py-2 text-[#8B9CB0]">
                        {new Date(ev.createdAt).toLocaleTimeString()}
                      </td>
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
                        {ev.kind === 'voice_realtime' || ev.kind === 'stt'
                          ? `${ev.voiceSeconds}s`
                          : `${ev.totalTokens}t`}
                      </td>
                      <td className="px-3 py-2 text-[#9EB0C3]">{ev.latencyMs}ms</td>
                      <td className="px-3 py-2 text-[#9EB0C3]">${ev.estimatedCostUsd.toFixed(5)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Panel>
      </div>

      {/* Uptime, Error-Rate Alerting & Log Redaction Panel */}
      <Panel className="space-y-3 p-5">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-2">
            <BellRing className="h-4 w-4" style={{ color: 'var(--mj-accent-ice)' }} />
            <h2 className="text-sm font-medium text-[#EDF3F8]">
              Uptime, Crash &amp; Error-Rate Alerting
            </h2>
          </div>
          <div className="flex flex-wrap items-center gap-2 text-[11px]">
            <StatusPill tone={alerting?.emailConfigured ? 'good' : 'neutral'}>
              Email: {alerting?.emailConfigured ? 'Configured' : 'Off'}
            </StatusPill>
            <StatusPill tone={alerting?.telegramConfigured ? 'good' : 'neutral'}>
              Telegram: {alerting?.telegramConfigured ? 'Configured' : 'Off'}
            </StatusPill>
          </div>
        </div>

        <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
          <MetricBox
            label={`Rolling API Error Rate (${alerting?.windowMinutes ?? 15}m)`}
            value={`${alerting?.currentErrorRatePct ?? 0}% (${alerting?.currentWindowErrors ?? 0}/${alerting?.currentWindowRequests ?? 0})`}
            warn={
              (alerting?.currentWindowRequests ?? 0) >= (alerting?.minSampleRequests ?? 5) &&
              (alerting?.currentErrorRatePct ?? 0) >= (alerting?.errorRateThresholdPct ?? 25)
            }
          />
          <MetricBox
            label="Alert Trigger Threshold"
            value={`>= ${alerting?.errorRateThresholdPct ?? 25}% (min ${alerting?.minSampleRequests ?? 5} req)`}
          />
          <MetricBox
            label="Last Dispatched Alert"
            value={
              alerting?.lastAlertAt
                ? `${alerting.lastAlertReason ?? 'alert'} (${alerting.lastDeliveryStatus})`
                : 'None triggered'
            }
          />
        </div>

        <div
          className="flex flex-wrap items-center gap-2 text-[11px]"
          style={{ color: 'var(--mj-text-subtle)' }}
        >
          <ShieldCheck className="h-3.5 w-3.5 shrink-0 text-[#7FD1AE]" />
          <span>
            Strict Log Redaction Active: API keys, bearer/ephemeral tokens, bot tokens, email addresses, query strings, and prompt texts are scrubbed from server logs and outbound alerts.
          </span>
        </div>
      </Panel>

      {/* Section 16 Architecture & Model Stability Footer */}
      <Panel className="flex flex-wrap items-center justify-between gap-3 px-5 py-3.5 text-xs">
        <div className="flex items-center gap-2" style={{ color: 'var(--mj-text-muted)' }}>
          <Globe className="h-4 w-4 text-[#9AC6E6]" />
          <span>
            <strong className="text-[#DCE6EE]">Provider &amp; Voice Notice:</strong>{' '}
            Active text engine <code className="font-mono">{providerDisplay.shortLabel}</code> · voice{' '}
            <code className="font-mono">
              {settings?.voice.voiceModel ?? health?.activeVoiceModel ?? providerDisplay.voiceLiveLabel}
            </code>
            ; verify limits &amp; pricing at <code className="font-mono">{providerDisplay.docsHint}</code>.
          </span>
        </div>
        <span className="font-mono text-[11px]" style={{ color: 'var(--mj-accent-blue)' }}>
          {health?.stage ?? MJ_ACTIVE_STAGE}
        </span>
      </Panel>
    </div>
  );
}

function StatusCard({
  icon,
  label,
  value,
  detail,
  tone,
}: {
  icon: React.ReactNode;
  label: string;
  value: string;
  detail: string;
  tone: 'good' | 'warn' | 'error' | 'neutral';
}) {
  const color =
    tone === 'good'
      ? 'var(--mj-status-good)'
      : tone === 'warn'
        ? 'var(--mj-status-warn)'
        : tone === 'error'
          ? 'var(--mj-status-error)'
          : 'var(--mj-accent-ice)';

  return (
    <Panel className="flex flex-col justify-between p-4">
      <div className="flex items-center gap-2 text-[11px]" style={{ color: 'var(--mj-text-subtle)' }}>
        <span style={{ color: 'var(--mj-accent-blue)' }}>{icon}</span>
        <span className="uppercase tracking-[0.12em]">{label}</span>
      </div>
      <div className="mt-2 truncate text-sm font-medium" style={{ color }}>
        {value}
      </div>
      <div className="mt-1 truncate font-mono text-[10px]" style={{ color: 'var(--mj-text-muted)' }}>
        {detail}
      </div>
    </Panel>
  );
}

function MetricBox({
  label,
  value,
  warn = false,
}: {
  label: string;
  value: string;
  warn?: boolean;
}) {
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
      <div
        className="mt-1 font-mono text-base font-medium tabular-nums"
        style={{ color: warn ? 'var(--mj-status-error)' : '#EDF3F8' }}
      >
        {value}
      </div>
    </div>
  );
}

function NumberField({
  id,
  label,
  value,
  step,
  onChange,
}: {
  id: string;
  label: string;
  value: number;
  step: number;
  onChange: (val: number) => void;
}) {
  return (
    <div>
      <label htmlFor={id} className="mb-1 block text-[11px] text-[#9EB0C3]">
        {label}
      </label>
      <input
        id={id}
        type="number"
        min={0}
        step={step}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
        className="w-full rounded-xl px-2.5 py-1.5 font-mono text-xs text-[#EDF3F8] outline-none"
        style={{
          backgroundColor: '#07090E',
          border: '1px solid var(--mj-border-subtle)',
        }}
      />
    </div>
  );
}
