import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_BUDGET_SETTINGS,
  DEFAULT_PERMISSIONS_STATE,
  VoiceStates,
  type PublicSettingsDTO,
  type SystemHealthDTO,
  type UsageSummaryDTO,
} from '@mj/shared';
import { DesktopView } from '../apps/web/src/components/DesktopView.js';
import { HomeDashboard } from '../apps/web/src/components/HomeDashboard.js';
import { MicActiveBanner } from '../apps/web/src/components/MicActiveBanner.js';
import { PrivacyCenterView } from '../apps/web/src/components/PrivacyCenterView.js';
import { Sidebar } from '../apps/web/src/components/Sidebar.js';
import { UnlockGate } from '../apps/web/src/components/UnlockGate.js';
import { UsageDashboardView } from '../apps/web/src/components/UsageDashboardView.js';

const mockHealth: SystemHealthDTO = {
  status: 'online',
  stage: 'Stage 5 · Monitoring, Usage & Final Delivery',
  backend: 'online',
  database: 'healthy',
  aiEngine: 'ready',
  voiceEngine: 'ready',
  activeModel: 'grok-4.7',
  activeVoiceModel: 'grok-voice-latest',
  apiBaseHost: 'api.x.ai',
  uptimeSeconds: 120,
  appEnv: 'test',
  timestamp: new Date().toISOString(),
  features: {
    textChat: true,
    streaming: true,
    conversationHistory: true,
    voice: true,
    memory: false,
    tools: false,
    automation: false,
    desktop: true,
  },
};

const mockSettings: PublicSettingsDTO = {
  assistantName: 'MJ Assistant',
  activeModel: 'grok-4.7',
  availableModels: ['grok-4.7', 'grok-3'],
  reasoningEffort: 'medium',
  responseStyle: 'balanced',
  maxOutputTokens: 4096,
  timeoutMs: 60000,
  streamResponses: true,
  reducedMotionOverride: 'system',
  compactDensity: false,
  apiBaseHost: 'api.x.ai',
  apiKeyConfigured: true,
  appEnv: 'test',
  budget: DEFAULT_BUDGET_SETTINGS,
  voice: {
    voiceModel: 'grok-voice-latest',
    availableVoiceModels: ['grok-voice-latest'],
    voiceId: 'ara',
    availableVoices: [{ id: 'ara', label: 'Ara', description: 'Warm' }],
    speakingRate: 1.0,
    volume: 0.9,
    autoPlayback: false,
    voiceOutputEnabled: true,
    languageMode: 'auto',
  },
};

const mockUsage: UsageSummaryDTO = {
  today: {
    requestCount: 4,
    errorCount: 0,
    inputTokens: 1200,
    outputTokens: 600,
    reasoningTokens: 200,
    cachedTokens: 0,
    totalTokens: 1800,
    voiceSeconds: 90,
    estimatedCostUsd: 0.125,
    avgLatencyMs: 310,
    byKind: {
      text: { requests: 2, errors: 0, estimatedCostUsd: 0.05, avgLatencyMs: 280, totalTokens: 1800, voiceSeconds: 0 },
      voice_realtime: { requests: 1, errors: 0, estimatedCostUsd: 0.075, avgLatencyMs: 0, totalTokens: 0, voiceSeconds: 90 },
      tts: { requests: 1, errors: 0, estimatedCostUsd: 0.0, avgLatencyMs: 340, totalTokens: 0, voiceSeconds: 0 },
      stt: { requests: 0, errors: 0, estimatedCostUsd: 0, avgLatencyMs: 0, totalTokens: 0, voiceSeconds: 0 },
    },
  },
  month: {
    requestCount: 12,
    errorCount: 1,
    inputTokens: 5000,
    outputTokens: 2500,
    reasoningTokens: 400,
    cachedTokens: 500,
    totalTokens: 7500,
    voiceSeconds: 600,
    estimatedCostUsd: 12.5,
    avgLatencyMs: 365,
    byKind: {
      text: { requests: 8, errors: 0, estimatedCostUsd: 8.5, avgLatencyMs: 340, totalTokens: 7500, voiceSeconds: 0 },
      voice_realtime: { requests: 2, errors: 1, estimatedCostUsd: 3.5, avgLatencyMs: 120, totalTokens: 0, voiceSeconds: 600 },
      tts: { requests: 1, errors: 0, estimatedCostUsd: 0.3, avgLatencyMs: 410, totalTokens: 0, voiceSeconds: 0 },
      stt: { requests: 1, errors: 0, estimatedCostUsd: 0.2, avgLatencyMs: 390, totalTokens: 0, voiceSeconds: 120 },
    },
  },
  budgetStatus: {
    level: 'soft_cap_warning',
    monthlySpendUsd: 12.5,
    dailySpendUsd: 0.125,
    softCapUsd: 10,
    hardCapUsd: 25,
    percentOfSoftCap: 125,
    percentOfHardCap: 50,
    remainingSoftCapUsd: 0,
    remainingHardCapUsd: 12.5,
  },
  recentEvents: [
    {
      id: 'ev-1',
      kind: 'text',
      model: 'grok-4.7',
      status: 'success',
      totalTokens: 1500,
      voiceSeconds: 0,
      estimatedCostUsd: 0.0042,
      latencyMs: 312,
      createdAt: '2026-11-27T10:00:00.000Z',
    },
  ],
};

describe('Frontend React Views & Responsive UI Coverage (Sections 16 & 17)', () => {
  const noopAsync = async () => {};

  it('renders UsageDashboardView with spend-vs-budget bar, channel metrics, and all system statuses', () => {
    const html = renderToStaticMarkup(
      <UsageDashboardView
        health={mockHealth}
        backendLatencyMs={18}
        online={true}
        voiceState={VoiceStates.LISTENING}
        settings={mockSettings}
        usage={mockUsage}
        connectivityCheck={{
          checkedAt: '2026-11-27T10:05:00.000Z',
          apiKeyConfigured: true,
          xaiReachable: true,
          modelChecked: 'grok-4.7',
          modelAvailable: true,
          availableModelCount: 5,
          voiceModelChecked: 'grok-voice-latest',
          availableVoiceCount: 5,
          latencyMs: 142,
          error: null,
          note: 'xAI API responded in 142ms.',
        }}
        checkingConnectivity={false}
        onRefreshUsage={noopAsync}
        onCheckConnectivity={noopAsync}
        onSaveSettings={noopAsync}
      />,
    );

    expect(html).toContain('Usage &amp; System Monitor');
    expect(html).toContain('$12.5000');
    expect(html).toContain('50% of $25.00 hard cap');
    expect(html).toContain('role="progressbar"');
    expect(html).toContain('aria-valuenow="50"');
    expect(html).toContain('Soft Warning Threshold Exceeded');
    expect(html).toContain('Grok Responses Text');
    expect(html).toContain('Realtime Speech-to-Speech');
    expect(html).toContain('Text-to-Speech (/v1/tts)');
    expect(html).toContain('Speech-to-Text (/v1/stt)');
    expect(html).toContain('WebSocket Health');
    expect(html).toContain('312ms');
    expect(html).toContain('18ms ping');
  });

  it('renders HomeDashboard, Sidebar, MicActiveBanner, PrivacyCenterView, DesktopView, and UnlockGate cleanly', () => {
    const homeHtml = renderToStaticMarkup(
      <HomeDashboard
        health={mockHealth}
        settings={mockSettings}
        usage={mockUsage}
        conversations={[]}
        online={true}
        interactionMode="voice"
        onChangeInteractionMode={() => {}}
        streamingState="idle"
        streamStatusDetail="Standing by"
        voiceState={VoiceStates.IDLE}
        voiceDetail="Ready"
        voiceMuted={false}
        voiceAudioLevel={0}
        liveUserTranscript=""
        liveAssistantTranscript=""
        hasLastResponseToSpeak={false}
        latestHomeExchange={null}
        activeError={null}
        onStartVoice={() => {}}
        onStopVoice={() => {}}
        onToggleMute={() => {}}
        onInterruptVoice={() => {}}
        onRepeatLastResponse={() => {}}
        onChangeLanguageMode={() => {}}
        onQuickSend={() => {}}
        onStopStream={() => {}}
        onRetryLast={() => {}}
        onOpenConversation={() => {}}
        onNavigateChat={() => {}}
        onNavigateUsage={() => {}}
        onNavigateSettings={() => {}}
      />,
    );
    expect(homeHtml).toContain('Spend vs Budget');
    expect(homeHtml).toContain('WebSocket');
    expect(homeHtml).toContain('Desktop');

    const sidebarHtml = renderToStaticMarkup(
      <Sidebar
        activeTab="usage"
        onSelectTab={() => {}}
        health={mockHealth}
        session={{ authenticated: true, passcodeRequired: false, mode: 'local-dev', appEnv: 'test' }}
        voiceState={VoiceStates.IDLE}
        micActive={false}
        onLogout={() => {}}
      />,
    );
    expect(sidebarHtml).toContain('Usage');
    expect(sidebarHtml).toContain('Privacy');
    expect(sidebarHtml).toContain('Memory &amp; Tools');

    const bannerActive = renderToStaticMarkup(
      <MicActiveBanner
        liveVoiceActive={false}
        voiceMuted={false}
        wakeWordStandbyActive={true}
        onStopAllMic={() => {}}
      />,
    );
    expect(bannerActive).toContain('WAKE-WORD STANDBY');

    const bannerIdle = renderToStaticMarkup(
      <MicActiveBanner
        liveVoiceActive={false}
        voiceMuted={false}
        wakeWordStandbyActive={false}
        onStopAllMic={() => {}}
      />,
    );
    expect(bannerIdle).toBe('');

    const privacyHtml = renderToStaticMarkup(
      <PrivacyCenterView
        permissions={DEFAULT_PERMISSIONS_STATE}
        allowlist={[]}
        auditLogs={[]}
        conversationCount={0}
        session={{ authenticated: true, passcodeRequired: false, mode: 'local-dev', appEnv: 'test' }}
        wakeWordStatusMessage="Wake-word standby is OFF."
        onTogglePermission={noopAsync}
        onRevokeAllDesktop={noopAsync}
        onAddAllowlist={noopAsync}
        onRemoveAllowlist={noopAsync}
        onRefreshAuditLogs={noopAsync}
        onExportData={noopAsync}
        onClearConversations={noopAsync}
        onLogout={noopAsync}
      />,
    );
    expect(privacyHtml).toContain('Privileged-Action Audit Log');
    expect(privacyHtml).toContain('Stage 3 Categories (Not Active Yet)');
    expect(privacyHtml).toContain('No Master Switch');
    expect(privacyHtml).toContain('Revoke All Desktop Permissions');

    const desktopHtml = renderToStaticMarkup(
      <DesktopView
        permissions={DEFAULT_PERMISSIONS_STATE}
        allowlist={[]}
        onAuditUpdated={noopAsync}
        onNavigatePrivacy={() => {}}
      />,
    );
    expect(desktopHtml).toContain('Web / Browser Telemetry');
    expect(desktopHtml).toContain('source: browser-sandbox');
    expect(desktopHtml).toContain('asInvoker');

    const gateHtml = renderToStaticMarkup(
      <UnlockGate onLogin={noopAsync} errorMessage={null} />,
    );
    expect(gateHtml).toContain('Unlock');
  });
});
