import { useState, type FormEvent } from 'react';
import {
  AlertTriangle,
  Download,
  Lock,
  LogOut,
  Plus,
  RefreshCw,
  ShieldAlert,
  ShieldCheck,
  Trash2,
} from 'lucide-react';
import { Panel, StatusPill } from '@mj/ui';
import {
  ADMIN_PRIVILEGE_POLICY,
  type AllowlistEntryDTO,
  type AllowlistKind,
  type AuditLogEntryDTO,
  type AuthSessionDTO,
  type ControllablePermissionKey,
  type OsCapabilityKey,
  type PermissionsStateDTO,
} from '@mj/shared';

interface PrivacyCenterViewProps {
  permissions: PermissionsStateDTO;
  allowlist: AllowlistEntryDTO[];
  auditLogs: AuditLogEntryDTO[];
  conversationCount: number;
  session: AuthSessionDTO | null;
  wakeWordStatusMessage: string;
  onTogglePermission: (key: ControllablePermissionKey, enabled: boolean) => Promise<void>;
  onRevokeAllDesktop: () => Promise<void>;
  onAddAllowlist: (entry: { kind: AllowlistKind; label: string; target: string }) => Promise<void>;
  onRemoveAllowlist: (id: string) => Promise<void>;
  onRefreshAuditLogs: () => Promise<void>;
  onExportData: () => Promise<void>;
  onClearConversations: () => Promise<void>;
  onLogout: () => Promise<void>;
}

const OS_CAPABILITY_ROWS: Array<{
  key: OsCapabilityKey;
  title: string;
  description: string;
  riskTag: string;
}> = [
  {
    key: 'appOpening',
    title: 'Open Approved Applications',
    description:
      'Launch strictly allowlisted executables directly without shell execution. Ships OFF.',
    riskTag: 'OS Launch',
  },
  {
    key: 'appClosing',
    title: 'Close Approved Applications',
    description:
      'Close running processes matching your allowlisted applications cleanly via native PID matching. Ships OFF.',
    riskTag: 'OS Process',
  },
  {
    key: 'fileRead',
    title: 'Desktop Search & File Read',
    description:
      'Read or search inside user-approved folders only (separate from file write). Ships OFF.',
    riskTag: 'File Read',
  },
  {
    key: 'fileWrite',
    title: 'Local File Organization (File Write)',
    description:
      'Organize or move files inside approved folders; still requires explicit per-action confirmation.',
    riskTag: 'File Write',
  },
  {
    key: 'systemMonitoring',
    title: 'Permitted System Monitoring',
    description:
      'Read CPU, memory, storage, battery, and network metrics from the local host. Ships OFF.',
    riskTag: 'Telemetry',
  },
  {
    key: 'volumeControl',
    title: 'System Volume & Mute Control',
    description:
      'Adjust master Windows audio volume (0-100%) or mute via native Win32 input. Ships OFF.',
    riskTag: 'Audio HW',
  },
  {
    key: 'brightnessControl',
    title: 'Display Brightness Control',
    description:
      'Adjust supported monitor brightness levels (0-100%) via native Win32 DDC/CI APIs. Ships OFF.',
    riskTag: 'Display HW',
  },
  {
    key: 'lockScreen',
    title: 'Lock Screen Session',
    description:
      'Lock the Windows workstation immediately via Win32 LockWorkStation. Ships OFF.',
    riskTag: 'Session Lock',
  },
  {
    key: 'sleepDisplay',
    title: 'Sleep Display Monitor',
    description:
      'Put the monitor into low-power standby without sleeping the PC. Ships OFF.',
    riskTag: 'Display Power',
  },
  {
    key: 'windowControl',
    title: 'Desktop Window Actions',
    description:
      'Minimize all windows, maximize foreground window, switch windows, or close the active tab. Ships OFF.',
    riskTag: 'Windows UI',
  },
  {
    key: 'textTyping',
    title: 'Controlled Desktop Text Typing',
    description:
      'Type printable text into the active window; always requires explicit confirmation. Ships OFF.',
    riskTag: 'Confirm Input',
  },
  {
    key: 'shortcutPress',
    title: 'Allowlisted Keyboard Shortcuts',
    description:
      'Send only safe allowlisted shortcuts (e.g. Ctrl+C, Ctrl+W, Alt+Tab, Media keys). Ships OFF.',
    riskTag: 'Safe Keys',
  },
  {
    key: 'notifications',
    title: 'Desktop Notifications',
    description: 'Display native desktop or browser notifications when permitted. Ships OFF.',
    riskTag: 'Alerts',
  },
  {
    key: 'clipboardWrite',
    title: 'Copy Approved Text',
    description: 'Write user-approved text snippets to the clipboard. Ships OFF.',
    riskTag: 'Clipboard',
  },
  {
    key: 'webLaunch',
    title: 'Launch Approved Web Pages',
    description: 'Open verified HTTPS URLs matching your domain allowlist. Ships OFF.',
    riskTag: 'Browser',
  },
  {
    key: 'wakeWordStandby',
    title: 'Optional Wake-Word Standby ("Hey MJ")',
    description:
      'Always-listening standby defaults OFF (supports English, বাংলা, Banglish & हिन्दी). Web browsers require one user click to grant microphone access; Tauri desktop allows wake-word startup only when this toggle is ON.',
    riskTag: 'Always-Listening',
  },
  {
    key: 'configurableShortcuts',
    title: 'Configurable Shortcuts',
    description:
      'Bind validated keyboard hotkeys to approved MJ actions or allowlisted desktop targets. Ships OFF.',
    riskTag: 'Hotkeys',
  },
  {
    key: 'pcSleep',
    title: 'Power Action: Sleep PC',
    description:
      'Put this Windows PC to sleep via Win32 SetSuspendState; always requires spoken or clicked confirmation. Ships OFF.',
    riskTag: 'Power Confirm',
  },
  {
    key: 'pcLogoff',
    title: 'Power Action: Log Off User',
    description:
      'Sign out of the current Windows session; always requires spoken or clicked confirmation. Ships OFF.',
    riskTag: 'Power Confirm',
  },
  {
    key: 'pcRestart',
    title: 'Power Action: Restart PC',
    description:
      'Restart the Windows PC cleanly; always requires spoken or clicked confirmation. Ships OFF.',
    riskTag: 'High Risk',
  },
  {
    key: 'pcShutdown',
    title: 'Power Action: Shut Down PC',
    description:
      'Shut down the Windows PC cleanly; always requires spoken or clicked confirmation. Ships OFF.',
    riskTag: 'High Risk',
  },
];

const CORE_PRIVACY_ROWS: Array<{
  key: ControllablePermissionKey;
  title: string;
  description: string;
}> = [
  {
    key: 'microphoneAccess',
    title: 'Microphone Access',
    description: 'Allow voice capture when you explicitly press Talk or enable Wake-Word.',
  },
  {
    key: 'voiceSessionAccess',
    title: 'Voice Recording & Realtime Session Access',
    description: 'Allow realtime voice sessions (Google Gemini Live, browser speech, and TTS/STT).',
  },
  {
    key: 'externalWebServices',
    title: 'External AI Web Services',
    description: 'Allow outbound requests to cloud AI providers (local Ollama on localhost stays enabled).',
  },
  {
    key: 'toolCalling',
    title: 'AI Tool & Function Calling',
    description: 'Default OFF. Allow Gemini chat and Gemini Live to call permitted read/action tools with audit logging and 20s confirmation.',
  },
];

export function PrivacyCenterView({
  permissions,
  allowlist,
  auditLogs,
  conversationCount,
  session,
  wakeWordStatusMessage,
  onTogglePermission,
  onRevokeAllDesktop,
  onAddAllowlist,
  onRemoveAllowlist,
  onRefreshAuditLogs,
  onExportData,
  onClearConversations,
  onLogout,
}: PrivacyCenterViewProps) {
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const [feedback, setFeedback] = useState<{ tone: 'good' | 'error'; text: string } | null>(null);

  const [allowKind, setAllowKind] = useState<AllowlistKind>('app');
  const [allowLabel, setAllowLabel] = useState('');
  const [allowTarget, setAllowTarget] = useState('');

  const [confirmClearHistory, setConfirmClearHistory] = useState(false);
  const [auditFilterCapability, setAuditFilterCapability] = useState('');
  const [auditFilterOutcome, setAuditFilterOutcome] = useState('');

  const runAction = async (key: string, fn: () => Promise<void>, successText?: string) => {
    setBusyKey(key);
    setFeedback(null);
    try {
      await fn();
      if (successText) {
        setFeedback({ tone: 'good', text: successText });
      }
    } catch (err) {
      setFeedback({
        tone: 'error',
        text: err instanceof Error ? err.message : 'Operation failed.',
      });
    } finally {
      setBusyKey(null);
    }
  };

  const handleAddAllowlist = async (e: FormEvent) => {
    e.preventDefault();
    if (!allowLabel.trim() || !allowTarget.trim()) return;
    await runAction(
      'add-allowlist',
      async () => {
        await onAddAllowlist({
          kind: allowKind,
          label: allowLabel.trim(),
          target: allowTarget.trim(),
        });
        setAllowLabel('');
        setAllowTarget('');
      },
      'Added entry to allowlist and logged to audit trail.',
    );
  };

  const filteredAuditLogs = auditLogs.filter((entry) => {
    if (auditFilterCapability && entry.capability !== auditFilterCapability) return false;
    if (auditFilterOutcome && entry.outcome !== auditFilterOutcome) return false;
    return true;
  });

  const uniqueCapabilities = Array.from(new Set(auditLogs.map((a) => a.capability)));

  return (
    <div className="mx-auto w-full max-w-6xl space-y-6 px-4 py-6 sm:px-8 lg:py-8">
      <header className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <div
            className="text-[11px] font-medium tracking-[0.2em] uppercase"
            style={{ color: 'var(--mj-text-subtle)' }}
          >
            SECTION 14 &amp; 15 · PRIVACY HARDENING
          </div>
          <h1 className="mt-1 text-2xl font-normal tracking-tight text-[#F0F5F9]">
            Privacy &amp; <span style={{ color: 'var(--mj-accent-ice)' }}>Permissions Center</span>
          </h1>
          <p className="mt-1 text-xs" style={{ color: 'var(--mj-text-muted)' }}>
            Every OS capability ships OFF and must be turned on individually — there is no master enable switch.
          </p>
        </div>

        <button
          type="button"
          disabled={busyKey !== null}
          onClick={() =>
            void runAction(
              'revoke-all',
              onRevokeAllDesktop,
              'All OS-level capabilities and wake-word standby have been turned OFF.',
            )
          }
          className="inline-flex items-center gap-2 rounded-xl px-4 py-2.5 text-xs font-medium transition hover:bg-white/5 disabled:opacity-50"
          style={{
            backgroundColor: 'rgba(240, 138, 138, 0.1)',
            border: '1px solid rgba(240, 138, 138, 0.35)',
            color: '#FFE0E0',
          }}
        >
          <ShieldAlert className="h-4 w-4" />
          <span>Revoke All Desktop Permissions</span>
        </button>
      </header>

      {feedback && (
        <div
          role="status"
          className="rounded-xl px-4 py-3 text-xs"
          style={{
            backgroundColor:
              feedback.tone === 'error'
                ? 'rgba(240, 138, 138, 0.1)'
                : 'rgba(127, 209, 174, 0.1)',
            border:
              feedback.tone === 'error'
                ? '1px solid rgba(240, 138, 138, 0.35)'
                : '1px solid rgba(127, 209, 174, 0.32)',
            color: feedback.tone === 'error' ? '#FBE4E4' : '#D9F7EA',
          }}
        >
          {feedback.text}
        </div>
      )}

      {/* Individual OS Capability Toggles */}
      <Panel className="p-6">
        <div className="mb-4 flex flex-wrap items-center justify-between gap-2">
          <div>
            <h2 className="text-base font-medium text-[#EDF3F8]">
              OS-Level Desktop Capability Classes (Individual Opt-In Only)
            </h2>
            <p className="mt-1 text-xs" style={{ color: 'var(--mj-text-muted)' }}>
              File read (desktop search) and file write (local organization) are gated separately. Wake-word standby defaults OFF.
            </p>
          </div>
          <StatusPill tone="neutral">No Master Switch</StatusPill>
        </div>

        <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
          {OS_CAPABILITY_ROWS.map((row) => {
            const enabled = permissions[row.key];
            return (
              <div
                key={row.key}
                className="flex items-start justify-between gap-4 rounded-xl p-4"
                style={{
                  backgroundColor: '#07090E',
                  border: enabled
                    ? '1px solid rgba(127, 209, 174, 0.3)'
                    : '1px solid var(--mj-border-subtle)',
                }}
              >
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-xs font-medium text-[#EDF3F8]">{row.title}</span>
                    <span
                      className="rounded px-1.5 py-0.5 font-mono text-[10px]"
                      style={{
                        backgroundColor: 'rgba(199, 227, 245, 0.08)',
                        color: 'var(--mj-accent-blue)',
                      }}
                    >
                      {row.riskTag}
                    </span>
                  </div>
                  <p className="mt-1 text-[11px] leading-relaxed" style={{ color: 'var(--mj-text-muted)' }}>
                    {row.description}
                  </p>
                  {row.key === 'wakeWordStandby' && wakeWordStatusMessage && (
                    <p className="mt-1 font-mono text-[10px]" style={{ color: 'var(--mj-accent-ice)' }}>
                      {wakeWordStatusMessage}
                    </p>
                  )}
                </div>

                <button
                  type="button"
                  role="switch"
                  aria-checked={enabled}
                  aria-label={`Toggle ${row.title}`}
                  disabled={busyKey !== null}
                  onClick={() => void runAction(row.key, () => onTogglePermission(row.key, !enabled))}
                  className="shrink-0 rounded-full px-3 py-1.5 font-mono text-[11px] font-medium transition disabled:opacity-50"
                  style={{
                    backgroundColor: enabled
                      ? 'rgba(127, 209, 174, 0.16)'
                      : 'rgba(255, 255, 255, 0.04)',
                    border: enabled
                      ? '1px solid rgba(127, 209, 174, 0.45)'
                      : '1px solid var(--mj-border-strong)',
                    color: enabled ? 'var(--mj-status-good)' : 'var(--mj-text-muted)',
                  }}
                >
                  {enabled ? 'ON' : 'OFF'}
                </button>
              </div>
            );
          })}
        </div>
      </Panel>

      {/* Core Voice/Service Permissions + Stage 3 Deferred Categories */}
      <div className="grid grid-cols-1 gap-5 lg:grid-cols-2">
        <Panel className="p-6">
          <h2 className="text-base font-medium text-[#EDF3F8]">Core Voice &amp; Service Permissions</h2>
          <p className="mt-1 mb-4 text-xs" style={{ color: 'var(--mj-text-muted)' }}>
            Controls microphone hardware access, realtime voice sessions, and external AI calls.
          </p>

          <div className="space-y-3">
            {CORE_PRIVACY_ROWS.map((row) => {
              const enabled = permissions[row.key];
              return (
                <div
                  key={row.key}
                  className="flex items-center justify-between gap-4 rounded-xl px-4 py-3"
                  style={{
                    backgroundColor: '#07090E',
                    border: '1px solid var(--mj-border-subtle)',
                  }}
                >
                  <div className="min-w-0">
                    <div className="text-xs font-medium text-[#EDF3F8]">{row.title}</div>
                    <div className="mt-0.5 text-[11px]" style={{ color: 'var(--mj-text-muted)' }}>
                      {row.description}
                    </div>
                  </div>
                  <button
                    type="button"
                    role="switch"
                    aria-checked={enabled}
                    aria-label={`Toggle ${row.title}`}
                    disabled={busyKey !== null}
                    onClick={() => void runAction(row.key, () => onTogglePermission(row.key, !enabled))}
                    className="shrink-0 rounded-full px-3 py-1 font-mono text-[11px] font-medium"
                    style={{
                      backgroundColor: enabled
                        ? 'rgba(127, 209, 174, 0.16)'
                        : 'rgba(240, 138, 138, 0.14)',
                      border: enabled
                        ? '1px solid rgba(127, 209, 174, 0.4)'
                        : '1px solid rgba(240, 138, 138, 0.35)',
                      color: enabled ? 'var(--mj-status-good)' : 'var(--mj-status-error)',
                    }}
                  >
                    {enabled ? 'ON' : 'OFF'}
                  </button>
                </div>
              );
            })}

            {/* Stage 3 locked items */}
            <div
              className="rounded-xl p-3.5 text-[11px]"
              style={{
                backgroundColor: 'rgba(255, 255, 255, 0.02)',
                border: '1px solid var(--mj-border-subtle)',
                color: 'var(--mj-text-subtle)',
              }}
            >
              <div className="flex items-center gap-1.5 font-medium text-[#C7D4E1]">
                <Lock className="h-3.5 w-3.5" />
                <span>Stage 3 Categories (Not Active Yet)</span>
              </div>
              <p className="mt-1">
                Persistent Memory Access, Optional Automation, and Cloud File Processing remain locked OFF until Stage 3 is built.
              </p>
            </div>
          </div>
        </Panel>

        {/* Data Controls & Admin Policy */}
        <Panel className="flex flex-col justify-between gap-4 p-6">
          <div>
            <h2 className="text-base font-medium text-[#EDF3F8]">Saved Data &amp; Account Controls</h2>
            <p className="mt-1 mb-4 text-xs" style={{ color: 'var(--mj-text-muted)' }}>
              Local-first SQLite residency. Export or clear your saved conversations at any time.
            </p>

            <div className="mb-4 grid grid-cols-3 gap-2.5 text-xs">
              <div className="rounded-xl p-3" style={{ backgroundColor: '#07090E', border: '1px solid var(--mj-border-subtle)' }}>
                <div style={{ color: 'var(--mj-text-subtle)' }}>Conversations</div>
                <div className="mt-1 font-mono text-base text-[#EDF3F8]">{conversationCount}</div>
              </div>
              <div className="rounded-xl p-3" style={{ backgroundColor: '#07090E', border: '1px solid var(--mj-border-subtle)' }}>
                <div style={{ color: 'var(--mj-text-subtle)' }}>Allowlisted</div>
                <div className="mt-1 font-mono text-base text-[#EDF3F8]">{allowlist.length}</div>
              </div>
              <div className="rounded-xl p-3" style={{ backgroundColor: '#07090E', border: '1px solid var(--mj-border-subtle)' }}>
                <div style={{ color: 'var(--mj-text-subtle)' }}>Audit Events</div>
                <div className="mt-1 font-mono text-base text-[#EDF3F8]">{auditLogs.length}</div>
              </div>
            </div>

            <div className="flex flex-wrap gap-2.5">
              <button
                type="button"
                disabled={busyKey !== null}
                onClick={() =>
                  void runAction(
                    'export-data',
                    onExportData,
                    'Exported personal data archive (secrets excluded).',
                  )
                }
                className="inline-flex items-center gap-2 rounded-xl px-3.5 py-2 text-xs font-medium transition hover:bg-white/5"
                style={{
                  backgroundColor: 'rgba(154, 198, 230, 0.12)',
                  border: '1px solid rgba(177, 215, 241, 0.24)',
                  color: 'var(--mj-accent-ice)',
                }}
              >
                <Download className="h-3.5 w-3.5" />
                <span>Export Personal Data</span>
              </button>

              {confirmClearHistory ? (
                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    onClick={() => {
                      setConfirmClearHistory(false);
                      void runAction(
                        'clear-history',
                        onClearConversations,
                        'Cleared all conversation history.',
                      );
                    }}
                    className="rounded-xl px-3 py-2 text-xs font-medium"
                    style={{
                      backgroundColor: 'rgba(240, 138, 138, 0.18)',
                      border: '1px solid rgba(240, 138, 138, 0.4)',
                      color: '#FFE2E2',
                    }}
                  >
                    Confirm Clear History
                  </button>
                  <button
                    type="button"
                    onClick={() => setConfirmClearHistory(false)}
                    className="rounded-xl px-2.5 py-2 text-xs"
                    style={{ color: 'var(--mj-text-muted)' }}
                  >
                    Cancel
                  </button>
                </div>
              ) : (
                <button
                  type="button"
                  onClick={() => setConfirmClearHistory(true)}
                  className="inline-flex items-center gap-2 rounded-xl px-3.5 py-2 text-xs font-medium transition hover:bg-white/5"
                  style={{
                    border: '1px solid var(--mj-border-strong)',
                    color: 'var(--mj-status-error)',
                  }}
                >
                  <Trash2 className="h-3.5 w-3.5" />
                  <span>Clear Conversation History</span>
                </button>
              )}

              {session?.passcodeRequired && (
                <button
                  type="button"
                  onClick={() => void onLogout()}
                  className="inline-flex items-center gap-2 rounded-xl px-3.5 py-2 text-xs font-medium transition hover:bg-white/5"
                  style={{
                    border: '1px solid var(--mj-border-strong)',
                    color: 'var(--mj-text-secondary)',
                  }}
                >
                  <LogOut className="h-3.5 w-3.5" />
                  <span>Sign Out</span>
                </button>
              )}
            </div>
          </div>

          <div
            className="rounded-xl p-4 text-xs leading-relaxed"
            style={{
              backgroundColor: 'rgba(127, 209, 174, 0.06)',
              border: '1px solid rgba(127, 209, 174, 0.22)',
            }}
          >
            <div className="flex items-center gap-2 font-medium text-[#D8F6EA]">
              <ShieldCheck className="h-4 w-4" />
              <span>Least Privilege: {ADMIN_PRIVILEGE_POLICY.executionLevel} (No Admin Rights)</span>
            </div>
            <p className="mt-1 text-[11px]" style={{ color: 'var(--mj-text-secondary)' }}>
              {ADMIN_PRIVILEGE_POLICY.summary} Only exception intentionally excluded:{' '}
              {ADMIN_PRIVILEGE_POLICY.adminOnlyExceptionName}
            </p>
          </div>
        </Panel>
      </div>

      {/* Strict Allowlist Manager */}
      <Panel className="p-6">
        <div className="mb-4">
          <h2 className="text-base font-medium text-[#EDF3F8]">
            Application, Folder &amp; Web Allowlists
          </h2>
          <p className="mt-1 text-xs" style={{ color: 'var(--mj-text-muted)' }}>
            Only targets listed here can be opened or accessed when their corresponding capability is enabled. Shell interpreters (<code className="font-mono">cmd.exe</code>, <code className="font-mono">powershell.exe</code>) and protected Windows folders are rejected.
          </p>
        </div>

        <form onSubmit={(e) => void handleAddAllowlist(e)} className="mb-4 grid grid-cols-1 gap-2.5 sm:grid-cols-4">
          <select
            aria-label="Allowlist category"
            value={allowKind}
            onChange={(e) => setAllowKind(e.target.value as AllowlistKind)}
            className="rounded-xl px-3 py-2 text-xs text-[#EDF3F8] outline-none"
            style={{ backgroundColor: '#07090E', border: '1px solid var(--mj-border-strong)' }}
          >
            <option value="app">Approved Application</option>
            <option value="folder">Approved Folder</option>
            <option value="web_domain">Approved HTTPS Domain</option>
          </select>
          <input
            type="text"
            value={allowLabel}
            onChange={(e) => setAllowLabel(e.target.value)}
            placeholder="Label (e.g. Notepad or Projects)"
            aria-label="Allowlist label"
            className="rounded-xl px-3 py-2 text-xs text-[#EDF3F8] outline-none placeholder:text-[#8B9CB0]"
            style={{ backgroundColor: '#07090E', border: '1px solid var(--mj-border-strong)' }}
          />
          <input
            type="text"
            value={allowTarget}
            onChange={(e) => setAllowTarget(e.target.value)}
            placeholder={
              allowKind === 'app'
                ? 'C:\\Program Files\\...\\app.exe'
                : allowKind === 'folder'
                  ? 'C:\\Users\\ASUS\\Desktop\\MJ'
                  : 'docs.x.ai'
            }
            aria-label="Allowlist target path or domain"
            className="rounded-xl px-3 py-2 font-mono text-xs text-[#EDF3F8] outline-none placeholder:text-[#8B9CB0]"
            style={{ backgroundColor: '#07090E', border: '1px solid var(--mj-border-strong)' }}
          />
          <button
            type="submit"
            disabled={busyKey !== null || !allowLabel.trim() || !allowTarget.trim()}
            className="inline-flex items-center justify-center gap-1.5 rounded-xl px-3.5 py-2 text-xs font-medium transition disabled:opacity-50"
            style={{
              background: 'linear-gradient(145deg, #DCEEF9, #9AC6E6)',
              color: '#070B11',
            }}
          >
            <Plus className="h-4 w-4" />
            <span>Add to Allowlist</span>
          </button>
        </form>

        {allowlist.length === 0 ? (
          <div className="rounded-xl p-4 text-xs" style={{ backgroundColor: '#07090E', border: '1px solid var(--mj-border-subtle)', color: 'var(--mj-text-subtle)' }}>
            No allowlist targets configured yet.
          </div>
        ) : (
          <div className="divide-y rounded-xl" style={{ backgroundColor: '#07090E', border: '1px solid var(--mj-border-subtle)' }}>
            {allowlist.map((entry) => (
              <div key={entry.id} className="flex flex-wrap items-center justify-between gap-3 px-4 py-2.5 text-xs">
                <div className="min-w-0 flex-1">
                  <span
                    className="mr-2 rounded px-1.5 py-0.5 font-mono text-[10px] uppercase"
                    style={{
                      backgroundColor: 'rgba(154, 198, 230, 0.12)',
                      color: 'var(--mj-accent-ice)',
                    }}
                  >
                    {entry.kind}
                  </span>
                  <span className="font-medium text-[#EDF3F8]">{entry.label}</span>
                  <span className="ml-2 font-mono text-[11px]" style={{ color: 'var(--mj-text-muted)' }}>
                    {entry.target}
                  </span>
                </div>
                <button
                  type="button"
                  onClick={() => void runAction(entry.id, () => onRemoveAllowlist(entry.id))}
                  aria-label={`Remove ${entry.label}`}
                  className="rounded-lg p-1.5 transition hover:bg-white/5"
                  style={{ color: 'var(--mj-status-error)' }}
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </button>
              </div>
            ))}
          </div>
        )}
      </Panel>

      {/* User-Readable Privileged-Action Audit Log (Section 14 & 15) */}
      <Panel className="p-6">
        <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
          <div>
            <h2 className="text-base font-medium text-[#EDF3F8]">
              Privileged-Action Audit Log
            </h2>
            <p className="mt-1 text-xs" style={{ color: 'var(--mj-text-muted)' }}>
              Every allowed, denied, or cancelled privileged action is recorded here for security review (separate from recent chat activity).
            </p>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <select
              aria-label="Filter audit log by capability"
              value={auditFilterCapability}
              onChange={(e) => setAuditFilterCapability(e.target.value)}
              className="rounded-xl px-2.5 py-1.5 text-xs text-[#EDF3F8] outline-none"
              style={{ backgroundColor: '#07090E', border: '1px solid var(--mj-border-subtle)' }}
            >
              <option value="">All capabilities</option>
              {uniqueCapabilities.map((cap) => (
                <option key={cap} value={cap}>
                  {cap}
                </option>
              ))}
            </select>

            <select
              aria-label="Filter audit log by outcome"
              value={auditFilterOutcome}
              onChange={(e) => setAuditFilterOutcome(e.target.value)}
              className="rounded-xl px-2.5 py-1.5 text-xs text-[#EDF3F8] outline-none"
              style={{ backgroundColor: '#07090E', border: '1px solid var(--mj-border-subtle)' }}
            >
              <option value="">All outcomes</option>
              <option value="allowed">Allowed</option>
              <option value="denied">Denied</option>
              <option value="cancelled">Cancelled</option>
              <option value="error">Error</option>
            </select>

            <button
              type="button"
              onClick={() => void runAction('refresh-audit', onRefreshAuditLogs)}
              className="inline-flex items-center gap-1.5 rounded-xl px-3 py-1.5 text-xs transition hover:bg-white/5"
              style={{ border: '1px solid var(--mj-border-subtle)', color: 'var(--mj-accent-ice)' }}
            >
              <RefreshCw className="h-3.5 w-3.5" />
              <span>Refresh</span>
            </button>
          </div>
        </div>

        {filteredAuditLogs.length === 0 ? (
          <div
            className="flex items-center gap-2 rounded-xl p-4 text-xs"
            style={{ backgroundColor: '#07090E', border: '1px solid var(--mj-border-subtle)', color: 'var(--mj-text-subtle)' }}
          >
            <AlertTriangle className="h-4 w-4" />
            <span>No privileged audit events recorded matching this filter yet.</span>
          </div>
        ) : (
          <div className="max-h-96 overflow-auto rounded-xl" style={{ border: '1px solid var(--mj-border-subtle)' }}>
            <table className="w-full text-left text-xs">
              <thead style={{ backgroundColor: 'rgba(255, 255, 255, 0.03)', color: 'var(--mj-text-subtle)' }}>
                <tr>
                  <th className="px-3.5 py-2.5">When</th>
                  <th className="px-3.5 py-2.5">Capability</th>
                  <th className="px-3.5 py-2.5">Action &amp; Target</th>
                  <th className="px-3.5 py-2.5">Outcome</th>
                  <th className="px-3.5 py-2.5">Source</th>
                </tr>
              </thead>
              <tbody className="divide-y" style={{ borderColor: 'var(--mj-border-subtle)' }}>
                {filteredAuditLogs.map((entry) => (
                  <tr key={entry.id}>
                    <td className="px-3.5 py-2.5 font-mono text-[11px] whitespace-nowrap" style={{ color: 'var(--mj-text-subtle)' }}>
                      {new Date(entry.timestamp).toLocaleString()}
                    </td>
                    <td className="px-3.5 py-2.5 font-mono text-[11px] text-[#9AC6E6]">
                      {entry.capability}
                    </td>
                    <td className="px-3.5 py-2.5">
                      <div className="font-medium text-[#EDF3F8]">{entry.action}</div>
                      <div className="font-mono text-[11px]" style={{ color: 'var(--mj-text-muted)' }}>
                        {entry.target}
                      </div>
                      {entry.detail && (
                        <div className="text-[11px]" style={{ color: 'var(--mj-text-subtle)' }}>
                          {entry.detail}
                        </div>
                      )}
                    </td>
                    <td className="px-3.5 py-2.5 font-mono text-[11px]">
                      <span
                        style={{
                          color:
                            entry.outcome === 'allowed'
                              ? 'var(--mj-status-good)'
                              : entry.outcome === 'cancelled'
                                ? 'var(--mj-status-warn)'
                                : 'var(--mj-status-error)',
                        }}
                      >
                        {entry.outcome}
                      </span>
                    </td>
                    <td className="px-3.5 py-2.5 font-mono text-[11px]" style={{ color: 'var(--mj-text-subtle)' }}>
                      {entry.source}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Panel>
    </div>
  );
}
