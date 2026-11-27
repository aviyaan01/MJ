import { useState, type FormEvent, type KeyboardEvent } from 'react';
import {
  AppWindow,
  Bell,
  ClipboardCopy,
  Cpu,
  FolderSearch,
  FolderSync,
  Globe,
  HardDrive,
  Keyboard,
  Laptop,
  Lock,
  Play,
  Plus,
  RefreshCw,
  ShieldCheck,
  Trash2,
} from 'lucide-react';
import { Panel, StatusPill } from '@mj/ui';
import {
  acceleratorFromKeyboardEvent,
  type AllowlistEntryDTO,
  type ConfigurableShortcutDTO,
  type HostTelemetryDTO,
  type PermissionsStateDTO,
  type ShortcutActionKind,
} from '@mj/shared';
import { mjApi } from '../api/client.js';
import {
  isTauriDesktop,
  readBrowserTelemetry,
  tauriGetNativeTelemetry,
  tauriNativeApproveDomain,
  tauriNativePickApprovedApp,
  tauriNativePickApprovedFolder,
  tauriOpenApprovedApp,
  tauriOpenApprovedUrl,
  tauriOrganizeApprovedFolder,
  tauriSearchApprovedFiles,
  tauriSendNotification,
  tauriValidateShortcutTrigger,
} from '../desktop/desktopBridge.js';

interface DesktopViewProps {
  permissions: PermissionsStateDTO;
  allowlist: AllowlistEntryDTO[];
  shortcuts?: ConfigurableShortcutDTO[];
  onAuditUpdated: () => Promise<void>;
  onShortcutsUpdated?: () => Promise<void>;
  onTriggerShortcutAction?: (shortcut: ConfigurableShortcutDTO) => Promise<void>;
  onNavigatePrivacy: () => void;
}

export function DesktopView({
  permissions,
  allowlist,
  shortcuts = [],
  onAuditUpdated,
  onShortcutsUpdated,
  onTriggerShortcutAction,
  onNavigatePrivacy,
}: DesktopViewProps) {
  const inTauri = isTauriDesktop();
  const browserTelemetry = readBrowserTelemetry();

  const [hostTelemetry, setHostTelemetry] = useState<HostTelemetryDTO | null>(null);
  const [telemetryError, setTelemetryError] = useState<string | null>(null);
  const [loadingTelemetry, setLoadingTelemetry] = useState(false);

  const [actionResult, setActionResult] = useState<{ tone: 'good' | 'error'; text: string } | null>(null);
  const [selectedApp, setSelectedApp] = useState('');
  const [urlInput, setUrlInput] = useState('https://docs.x.ai');
  const [selectedFolder, setSelectedFolder] = useState('');
  const [searchQuery, setSearchQuery] = useState('');
  const [searchResults, setSearchResults] = useState<
    Array<{ name: string; path: string; sizeBytes: number }>
  >([]);
  const [confirmFileWrite, setConfirmFileWrite] = useState(false);
  const [notifyTitle, setNotifyTitle] = useState('MJ Assistant');
  const [notifyBody, setNotifyBody] = useState('Desktop notification channel verified.');
  const [clipboardText, setClipboardText] = useState('MJ Assistant approved clipboard check');

  const [shortcutLabel, setShortcutLabel] = useState('');
  const [shortcutAccelerator, setShortcutAccelerator] = useState('Ctrl+Shift+M');
  const [shortcutAction, setShortcutAction] = useState<ShortcutActionKind>('toggle_voice');
  const [shortcutTarget, setShortcutTarget] = useState('');
  const [savingShortcut, setSavingShortcut] = useState(false);

  const approvedApps = allowlist.filter((a) => a.kind === 'app');
  const approvedFolders = allowlist.filter((a) => a.kind === 'folder');
  const approvedDomains = allowlist.filter((a) => a.kind === 'web_domain');

  const handleRefreshTelemetry = async () => {
    setLoadingTelemetry(true);
    setTelemetryError(null);
    try {
      if (inTauri) {
        const native = await tauriGetNativeTelemetry();
        if (native) {
          setHostTelemetry(native);
          await mjApi.recordAuditLog({
            capability: 'systemMonitoring',
            action: 'Read Windows Tauri telemetry',
            target: `${native.platform}/${native.arch}`,
            outcome: 'allowed',
            source: 'desktop-tauri',
          });
          await onAuditUpdated();
          return;
        }
      }
      const res = await mjApi.getDesktopSystemStatus();
      setHostTelemetry(res.telemetry);
      await onAuditUpdated();
    } catch (err) {
      setHostTelemetry(null);
      setTelemetryError(err instanceof Error ? err.message : 'Telemetry blocked or unavailable.');
      await onAuditUpdated();
    } finally {
      setLoadingTelemetry(false);
    }
  };

  const handleOpenApp = async () => {
    setActionResult(null);
    const target = selectedApp || approvedApps[0]?.target || '';
    try {
      await mjApi.validateDesktopAction({
        capability: 'appOpening',
        action: 'Launch approved application',
        target: target || '(none)',
        source: inTauri ? 'desktop-tauri' : 'web',
      });

      if (!inTauri) {
        setActionResult({
          tone: 'error',
          text: 'Allowlist check passed and logged, but spawning local executables requires running inside the Windows Tauri Desktop Companion.',
        });
        await onAuditUpdated();
        return;
      }

      await tauriOpenApprovedApp(target);
      setActionResult({ tone: 'good', text: `Launched approved app: ${target}` });
    } catch (err) {
      setActionResult({
        tone: 'error',
        text: err instanceof Error ? err.message : 'Failed opening application.',
      });
    } finally {
      await onAuditUpdated();
    }
  };

  const handleLaunchUrl = async () => {
    setActionResult(null);
    try {
      await mjApi.validateDesktopAction({
        capability: 'webLaunch',
        action: 'Launch approved HTTPS web page',
        target: urlInput.trim(),
        source: inTauri ? 'desktop-tauri' : 'web',
      });

      if (inTauri) {
        await tauriOpenApprovedUrl(urlInput.trim());
      } else {
        window.open(urlInput.trim(), '_blank', 'noopener,noreferrer');
      }
      setActionResult({ tone: 'good', text: `Opened approved URL: ${urlInput.trim()}` });
    } catch (err) {
      setActionResult({
        tone: 'error',
        text: err instanceof Error ? err.message : 'URL launch blocked.',
      });
    } finally {
      await onAuditUpdated();
    }
  };

  const handleSearchFiles = async () => {
    setActionResult(null);
    const folder = selectedFolder || approvedFolders[0]?.target || '';
    try {
      await mjApi.validateDesktopAction({
        capability: 'fileRead',
        action: 'Desktop search inside approved folder',
        target: folder || '(none)',
        source: inTauri ? 'desktop-tauri' : 'web',
      });

      if (!inTauri) {
        setActionResult({
          tone: 'error',
          text: 'Permission & folder allowlist validated, but reading local folders requires the Windows Tauri Desktop Companion.',
        });
        await onAuditUpdated();
        return;
      }

      const matches = await tauriSearchApprovedFiles(folder, searchQuery);
      setSearchResults(matches);
      setActionResult({ tone: 'good', text: `Found ${matches.length} matching files.` });
    } catch (err) {
      setActionResult({
        tone: 'error',
        text: err instanceof Error ? err.message : 'Folder search blocked.',
      });
    } finally {
      await onAuditUpdated();
    }
  };

  const handleOrganizeFiles = async () => {
    setActionResult(null);
    const folder = selectedFolder || approvedFolders[0]?.target || '';
    try {
      await mjApi.validateDesktopAction({
        capability: 'fileWrite',
        action: 'Organize approved folder into category subfolders',
        target: folder || '(none)',
        confirmed: confirmFileWrite,
        source: inTauri ? 'desktop-tauri' : 'web',
      });

      if (!inTauri) {
        setActionResult({
          tone: 'error',
          text: 'Confirmation and folder allowlist verified, but modifying local files requires the Windows Tauri Desktop Companion.',
        });
        await onAuditUpdated();
        return;
      }

      const summary = await tauriOrganizeApprovedFolder(folder, confirmFileWrite);
      setConfirmFileWrite(false);
      setActionResult({
        tone: 'good',
        text: `Organized folder: moved ${summary.movedCount} files (skipped ${summary.skippedCount}).`,
      });
    } catch (err) {
      setActionResult({
        tone: 'error',
        text: err instanceof Error ? err.message : 'File organization blocked.',
      });
    } finally {
      await onAuditUpdated();
    }
  };

  const handleNotify = async () => {
    setActionResult(null);
    try {
      await mjApi.validateDesktopAction({
        capability: 'notifications',
        action: 'Display notification',
        target: notifyTitle,
        source: inTauri ? 'desktop-tauri' : 'web',
      });

      if (inTauri) {
        await tauriSendNotification(notifyTitle, notifyBody);
      } else if ('Notification' in window) {
        const perm =
          Notification.permission === 'granted'
            ? 'granted'
            : await Notification.requestPermission();
        if (perm !== 'granted') {
          throw new Error('Browser notification permission was not granted.');
        }
        new Notification(notifyTitle, { body: notifyBody });
      } else {
        throw new Error('Notifications API is unavailable in this browser.');
      }

      setActionResult({ tone: 'good', text: `Notification sent: "${notifyTitle}"` });
    } catch (err) {
      setActionResult({
        tone: 'error',
        text: err instanceof Error ? err.message : 'Notification failed.',
      });
    } finally {
      await onAuditUpdated();
    }
  };

  const handleCopyText = async () => {
    setActionResult(null);
    try {
      await mjApi.validateDesktopAction({
        capability: 'clipboardWrite',
        action: 'Copy approved text to clipboard',
        target: `${clipboardText.length} characters`,
        source: inTauri ? 'desktop-tauri' : 'web',
      });

      await navigator.clipboard.writeText(clipboardText);
      setActionResult({ tone: 'good', text: 'Approved text copied to clipboard and logged.' });
    } catch (err) {
      setActionResult({
        tone: 'error',
        text: err instanceof Error ? err.message : 'Clipboard write blocked.',
      });
    } finally {
      await onAuditUpdated();
    }
  };

  const handleShortcutKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    const normalized = acceleratorFromKeyboardEvent(e);
    if (!normalized) return;
    e.preventDefault();
    setShortcutAccelerator(normalized);
  };

  const handleCreateShortcut = async (e: FormEvent) => {
    e.preventDefault();
    setActionResult(null);
    setSavingShortcut(true);
    try {
      await mjApi.createDesktopShortcut({
        label: shortcutLabel.trim(),
        accelerator: shortcutAccelerator.trim(),
        action: shortcutAction,
        ...(shortcutAction === 'open_approved_app' || shortcutAction === 'open_approved_url'
          ? { target: shortcutTarget.trim() }
          : {}),
      });
      setShortcutLabel('');
      setActionResult({
        tone: 'good',
        text: `Shortcut ${shortcutAccelerator.trim()} bound cleanly.`,
      });
      await onShortcutsUpdated?.();
    } catch (err) {
      setActionResult({
        tone: 'error',
        text: err instanceof Error ? err.message : 'Could not bind shortcut.',
      });
    } finally {
      setSavingShortcut(false);
      await onAuditUpdated();
    }
  };

  const handleDeleteShortcut = async (id: string) => {
    setActionResult(null);
    try {
      await mjApi.deleteDesktopShortcut(id);
      setActionResult({ tone: 'good', text: 'Shortcut removed.' });
      await onShortcutsUpdated?.();
    } catch (err) {
      setActionResult({
        tone: 'error',
        text: err instanceof Error ? err.message : 'Could not remove shortcut.',
      });
    } finally {
      await onAuditUpdated();
    }
  };

  const handleTriggerShortcut = async (shortcut: ConfigurableShortcutDTO) => {
    setActionResult(null);
    try {
      if (inTauri) {
        await tauriValidateShortcutTrigger(shortcut.accelerator, shortcut.action);
      }
      if (onTriggerShortcutAction) {
        await onTriggerShortcutAction(shortcut);
      } else {
        await mjApi.triggerDesktopShortcut(shortcut.id, inTauri ? 'desktop-tauri' : 'web');
      }
      setActionResult({
        tone: 'good',
        text: `Executed shortcut "${shortcut.label}" (${shortcut.accelerator}).`,
      });
    } catch (err) {
      setActionResult({
        tone: 'error',
        text: err instanceof Error ? err.message : 'Shortcut trigger blocked.',
      });
    } finally {
      await onAuditUpdated();
    }
  };

  return (
    <div className="mx-auto w-full max-w-6xl space-y-6 px-4 py-6 sm:px-8 lg:py-8">
      <header className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <div
            className="text-[11px] font-medium tracking-[0.2em] uppercase"
            style={{ color: 'var(--mj-text-subtle)' }}
          >
            SECTION 14 · WINDOWS DESKTOP COMPANION
          </div>
          <h1 className="mt-1 text-2xl font-normal tracking-tight text-[#F0F5F9]">
            Desktop &amp; <span style={{ color: 'var(--mj-accent-ice)' }}>OS Integration</span>
          </h1>
          <p className="mt-1 text-xs" style={{ color: 'var(--mj-text-muted)' }}>
            Standard user privileges (<code className="font-mono">asInvoker</code>), no arbitrary shell execution, and individual opt-in gating.
          </p>
        </div>

        <div className="flex items-center gap-2.5">
          <StatusPill tone={inTauri ? 'good' : 'neutral'}>
            {inTauri ? 'Tauri Desktop Host' : 'Browser Mode (Sandbox)'}
          </StatusPill>
          <button
            type="button"
            onClick={onNavigatePrivacy}
            className="rounded-xl px-3.5 py-2 text-xs font-medium transition hover:bg-white/5"
            style={{ border: '1px solid var(--mj-border-strong)', color: 'var(--mj-accent-ice)' }}
          >
            Manage Permissions
          </button>
        </div>
      </header>

      {actionResult && (
        <div
          role="status"
          className="rounded-xl px-4 py-3 text-xs"
          style={{
            backgroundColor:
              actionResult.tone === 'error'
                ? 'rgba(240, 138, 138, 0.1)'
                : 'rgba(127, 209, 174, 0.1)',
            border:
              actionResult.tone === 'error'
                ? '1px solid rgba(240, 138, 138, 0.35)'
                : '1px solid rgba(127, 209, 174, 0.32)',
            color: actionResult.tone === 'error' ? '#FBE4E4' : '#D9F7EA',
          }}
        >
          {actionResult.text}
        </div>
      )}

      {/* Telemetry Separation: Browser vs Real Host */}
      <div className="grid grid-cols-1 gap-5 lg:grid-cols-2">
        <Panel className="p-6">
          <div className="mb-3 flex items-center justify-between">
            <div className="flex items-center gap-2">
              <Globe className="h-4 w-4 text-[#9AC6E6]" />
              <h2 className="text-sm font-medium text-[#EDF3F8]">Web / Browser Telemetry</h2>
            </div>
            <span className="font-mono text-[10px] uppercase" style={{ color: 'var(--mj-text-subtle)' }}>
              source: browser-sandbox
            </span>
          </div>
          <dl className="divide-y text-xs" style={{ borderColor: 'var(--mj-border-subtle)' }}>
            <TelemetryRow label="Network Status" value={browserTelemetry.online ? 'Connected' : 'Offline'} />
            <TelemetryRow label="Browser Platform" value={browserTelemetry.platform} />
            <TelemetryRow
              label="Logical Cores (navigator)"
              value={browserTelemetry.hardwareConcurrency ? String(browserTelemetry.hardwareConcurrency) : 'Unavailable'}
            />
            <TelemetryRow
              label="Approx Device RAM"
              value={browserTelemetry.deviceMemoryGb ? `${browserTelemetry.deviceMemoryGb} GB` : 'Not exposed by browser'}
            />
          </dl>
        </Panel>

        <Panel className="p-6">
          <div className="mb-3 flex items-center justify-between gap-2">
            <div className="flex items-center gap-2">
              <Laptop className="h-4 w-4 text-[#9AC6E6]" />
              <h2 className="text-sm font-medium text-[#EDF3F8]">Windows / Local Host Telemetry</h2>
            </div>
            <button
              type="button"
              disabled={loadingTelemetry}
              onClick={() => void handleRefreshTelemetry()}
              className="inline-flex items-center gap-1.5 rounded-lg px-2.5 py-1 text-xs transition hover:bg-white/5 disabled:opacity-50"
              style={{ border: '1px solid var(--mj-border-subtle)', color: 'var(--mj-accent-ice)' }}
            >
              <RefreshCw className={`h-3.5 w-3.5 ${loadingTelemetry ? 'animate-spin' : ''}`} />
              <span>Read Telemetry</span>
            </button>
          </div>

          {!permissions.systemMonitoring ? (
            <div
              className="rounded-xl p-4 text-xs"
              style={{
                backgroundColor: '#07090E',
                border: '1px solid var(--mj-border-subtle)',
                color: 'var(--mj-text-muted)',
              }}
            >
              <div className="flex items-center gap-2 font-medium text-[#DCE6EE]">
                <Lock className="h-4 w-4 text-[#E3BE7E]" />
                <span>System Monitoring is OFF (Default)</span>
              </div>
              <p className="mt-1.5">
                Enable <code className="font-mono">systemMonitoring</code> individually in Privacy &amp; Permissions to read real host CPU, memory, storage, and battery stats.
              </p>
            </div>
          ) : telemetryError ? (
            <div className="rounded-xl p-4 text-xs" style={{ backgroundColor: 'rgba(240, 138, 138, 0.08)', color: '#FBE4E4' }}>
              {telemetryError}
            </div>
          ) : hostTelemetry ? (
            <dl className="divide-y text-xs" style={{ borderColor: 'var(--mj-border-subtle)' }}>
              <TelemetryRow label="Telemetry Source" value={hostTelemetry.source} />
              <TelemetryRow label="OS &amp; Arch" value={`${hostTelemetry.platform} ${hostTelemetry.osRelease} (${hostTelemetry.arch})`} />
              <TelemetryRow
                label="CPU Usage"
                value={
                  hostTelemetry.cpuUsagePercent !== null
                    ? `${hostTelemetry.cpuUsagePercent}% (${hostTelemetry.cpuCores} cores)`
                    : `${hostTelemetry.cpuCores} cores`
                }
              />
              <TelemetryRow
                label="Memory Usage"
                value={`${formatBytes(hostTelemetry.memoryUsedBytes)} / ${formatBytes(hostTelemetry.memoryTotalBytes)} (${hostTelemetry.memoryUsagePercent}%)`}
              />
              <TelemetryRow
                label="Storage"
                value={
                  hostTelemetry.storage[0]
                    ? `${hostTelemetry.storage[0].mount} ${formatBytes(hostTelemetry.storage[0].availableBytes)} free / ${formatBytes(hostTelemetry.storage[0].totalBytes)}`
                    : 'Unavailable'
                }
              />
              <TelemetryRow
                label="Battery"
                value={
                  hostTelemetry.battery && hostTelemetry.battery.percent !== null
                    ? `${hostTelemetry.battery.percent}% (${hostTelemetry.battery.charging ? 'Charging' : 'On battery'})`
                    : 'Unavailable in web host (available in Tauri Win32)'
                }
              />
              <TelemetryRow label="Elevation Level" value="asInvoker (No Admin Rights)" />
            </dl>
          ) : (
            <div className="rounded-xl p-4 text-xs" style={{ backgroundColor: '#07090E', color: 'var(--mj-text-muted)' }}>
              Permission is enabled. Click <strong>Read Telemetry</strong> to query real host metrics and record the read to your audit log.
            </div>
          )}
        </Panel>
      </div>

      {/* Individual Guarded Capabilities */}
      <div className="grid grid-cols-1 gap-5 md:grid-cols-2">
        {/* Open Approved App */}
        <Panel className="space-y-3 p-5">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2 text-sm font-medium text-[#EDF3F8]">
              <AppWindow className="h-4 w-4 text-[#9AC6E6]" />
              <span>Open Approved Application</span>
            </div>
            <StatusPill tone={permissions.appOpening ? 'good' : 'neutral'}>
              {permissions.appOpening ? 'Enabled' : 'OFF'}
            </StatusPill>
          </div>
          <select
            aria-label="Approved application to launch"
            value={selectedApp}
            onChange={(e) => setSelectedApp(e.target.value)}
            className="w-full rounded-xl px-3 py-2 font-mono text-xs text-[#EDF3F8] outline-none"
            style={{ backgroundColor: '#07090E', border: '1px solid var(--mj-border-strong)' }}
          >
            {approvedApps.length === 0 ? (
              <option value="">No approved apps in allowlist</option>
            ) : (
              approvedApps.map((app) => (
                <option key={app.id} value={app.target}>
                  {app.label} ({app.target})
                </option>
              ))
            )}
          </select>
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              onClick={() => void handleOpenApp()}
              className="inline-flex items-center gap-2 rounded-xl px-3.5 py-2 text-xs font-medium transition"
              style={{
                backgroundColor: 'rgba(154, 198, 230, 0.14)',
                border: '1px solid rgba(177, 215, 241, 0.24)',
                color: 'var(--mj-accent-ice)',
              }}
            >
              <ShieldCheck className="h-3.5 w-3.5" />
              <span>Launch Approved App</span>
            </button>
            {inTauri && (
              <button
                type="button"
                onClick={() => {
                  void tauriNativePickApprovedApp()
                    .then(async (picked) => {
                      if (picked) {
                        setSelectedApp(picked);
                        setActionResult({ tone: 'good', text: `Native Rust allowlist added: ${picked}` });
                      }
                      await onAuditUpdated();
                    })
                    .catch(async (err) => {
                      setActionResult({
                        tone: 'error',
                        text: err instanceof Error ? err.message : 'Native app picker blocked.',
                      });
                      await onAuditUpdated();
                    });
                }}
                className="inline-flex items-center gap-1.5 rounded-xl px-3 py-2 text-xs font-medium transition hover:bg-white/5"
                style={{
                  backgroundColor: 'rgba(255, 255, 255, 0.04)',
                  border: '1px solid var(--mj-border-strong)',
                  color: '#DCE6EE',
                }}
              >
                <Plus className="h-3.5 w-3.5" />
                <span>Approve .exe (Native Picker)</span>
              </button>
            )}
          </div>
        </Panel>

        {/* Launch Approved Web Page */}
        <Panel className="space-y-3 p-5">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2 text-sm font-medium text-[#EDF3F8]">
              <Globe className="h-4 w-4 text-[#9AC6E6]" />
              <span>Launch Approved Web Page</span>
            </div>
            <StatusPill tone={permissions.webLaunch ? 'good' : 'neutral'}>
              {permissions.webLaunch ? 'Enabled' : 'OFF'}
            </StatusPill>
          </div>
          <input
            type="url"
            aria-label="Approved HTTPS URL"
            value={urlInput}
            onChange={(e) => setUrlInput(e.target.value)}
            className="w-full rounded-xl px-3 py-2 font-mono text-xs text-[#EDF3F8] outline-none"
            style={{ backgroundColor: '#07090E', border: '1px solid var(--mj-border-strong)' }}
          />
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              onClick={() => void handleLaunchUrl()}
              className="inline-flex items-center gap-2 rounded-xl px-3.5 py-2 text-xs font-medium transition"
              style={{
                backgroundColor: 'rgba(154, 198, 230, 0.14)',
                border: '1px solid rgba(177, 215, 241, 0.24)',
                color: 'var(--mj-accent-ice)',
              }}
            >
              <span>Open Verified HTTPS URL</span>
            </button>
            {inTauri && (
              <button
                type="button"
                onClick={() => {
                  void tauriNativeApproveDomain(urlInput.trim())
                    .then(async (approved) => {
                      setActionResult({
                        tone: approved ? 'good' : 'error',
                        text: approved
                          ? `Approved domain in Rust native allowlist: ${urlInput.trim()}`
                          : 'Native domain approval cancelled.',
                      });
                      await onAuditUpdated();
                    })
                    .catch(async (err) => {
                      setActionResult({
                        tone: 'error',
                        text: err instanceof Error ? err.message : 'Domain approval rejected.',
                      });
                      await onAuditUpdated();
                    });
                }}
                className="inline-flex items-center gap-1.5 rounded-xl px-3 py-2 text-xs font-medium transition hover:bg-white/5"
                style={{
                  backgroundColor: 'rgba(255, 255, 255, 0.04)',
                  border: '1px solid var(--mj-border-strong)',
                  color: '#DCE6EE',
                }}
              >
                <Plus className="h-3.5 w-3.5" />
                <span>Approve Domain (Native Dialog)</span>
              </button>
            )}
          </div>
        </Panel>

        {/* Desktop Search (File Read) */}
        <Panel className="space-y-3 p-5">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2 text-sm font-medium text-[#EDF3F8]">
              <FolderSearch className="h-4 w-4 text-[#9AC6E6]" />
              <span>Desktop Search (File Read)</span>
            </div>
            <StatusPill tone={permissions.fileRead ? 'good' : 'neutral'}>
              {permissions.fileRead ? 'Enabled' : 'OFF'}
            </StatusPill>
          </div>
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
            <select
              aria-label="Approved folder"
              value={selectedFolder}
              onChange={(e) => setSelectedFolder(e.target.value)}
              className="rounded-xl px-3 py-2 font-mono text-xs text-[#EDF3F8] outline-none"
              style={{ backgroundColor: '#07090E', border: '1px solid var(--mj-border-strong)' }}
            >
              {approvedFolders.length === 0 ? (
                <option value="">No approved folders</option>
              ) : (
                approvedFolders.map((f) => (
                  <option key={f.id} value={f.target}>
                    {f.label}
                  </option>
                ))
              )}
            </select>
            <input
              type="text"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder="Filename filter…"
              aria-label="Filename filter"
              className="rounded-xl px-3 py-2 text-xs text-[#EDF3F8] outline-none placeholder:text-[#8B9CB0]"
              style={{ backgroundColor: '#07090E', border: '1px solid var(--mj-border-strong)' }}
            />
          </div>
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              onClick={() => void handleSearchFiles()}
              className="inline-flex items-center gap-2 rounded-xl px-3.5 py-2 text-xs font-medium"
              style={{
                backgroundColor: 'rgba(154, 198, 230, 0.14)',
                border: '1px solid rgba(177, 215, 241, 0.24)',
                color: 'var(--mj-accent-ice)',
              }}
            >
              <span>Search Approved Folder</span>
            </button>
            {inTauri && (
              <button
                type="button"
                onClick={() => {
                  void tauriNativePickApprovedFolder()
                    .then(async (picked) => {
                      if (picked) {
                        setSelectedFolder(picked);
                        setActionResult({ tone: 'good', text: `Native folder approved: ${picked}` });
                      }
                      await onAuditUpdated();
                    })
                    .catch(async (err) => {
                      setActionResult({
                        tone: 'error',
                        text: err instanceof Error ? err.message : 'Folder approval blocked.',
                      });
                      await onAuditUpdated();
                    });
                }}
                className="inline-flex items-center gap-1.5 rounded-xl px-3 py-2 text-xs font-medium transition hover:bg-white/5"
                style={{
                  backgroundColor: 'rgba(255, 255, 255, 0.04)',
                  border: '1px solid var(--mj-border-strong)',
                  color: '#DCE6EE',
                }}
              >
                <Plus className="h-3.5 w-3.5" />
                <span>Approve Folder (Native Picker)</span>
              </button>
            )}
          </div>
          {searchResults.length > 0 && (
            <ul className="max-h-28 overflow-auto rounded-lg bg-[#07090E] p-2 font-mono text-[11px] text-[#C7D4E1]">
              {searchResults.map((r) => (
                <li key={r.path} className="truncate py-0.5">
                  {r.path}
                </li>
              ))}
            </ul>
          )}
        </Panel>

        {/* Local File Organization (File Write) */}
        <Panel className="space-y-3 p-5">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2 text-sm font-medium text-[#EDF3F8]">
              <FolderSync className="h-4 w-4 text-[#E3BE7E]" />
              <span>Local File Organization (File Write)</span>
            </div>
            <StatusPill tone={permissions.fileWrite ? 'warn' : 'neutral'}>
              {permissions.fileWrite ? 'Enabled' : 'OFF'}
            </StatusPill>
          </div>
          <p className="text-[11px]" style={{ color: 'var(--mj-text-muted)' }}>
            Separately gated from File Read. Organizes top-level files into Documents/Images/Data subfolders without overwriting existing files.
          </p>
          <label className="flex items-center gap-2 text-xs text-[#DCE6EE]">
            <input
              type="checkbox"
              checked={confirmFileWrite}
              onChange={(e) => setConfirmFileWrite(e.target.checked)}
              className="h-4 w-4 accent-[#E3BE7E]"
            />
            <span>I explicitly confirm moving files inside the selected approved folder</span>
          </label>
          <button
            type="button"
            onClick={() => void handleOrganizeFiles()}
            className="inline-flex items-center gap-2 rounded-xl px-3.5 py-2 text-xs font-medium"
            style={{
              backgroundColor: 'rgba(227, 190, 126, 0.14)',
              border: '1px solid rgba(227, 190, 126, 0.3)',
              color: '#F5DFB5',
            }}
          >
            <HardDrive className="h-3.5 w-3.5" />
            <span>Organize Approved Folder</span>
          </button>
        </Panel>

        {/* Notifications */}
        <Panel className="space-y-3 p-5">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2 text-sm font-medium text-[#EDF3F8]">
              <Bell className="h-4 w-4 text-[#9AC6E6]" />
              <span>Desktop Notifications</span>
            </div>
            <StatusPill tone={permissions.notifications ? 'good' : 'neutral'}>
              {permissions.notifications ? 'Enabled' : 'OFF'}
            </StatusPill>
          </div>
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
            <input
              type="text"
              aria-label="Notification title"
              value={notifyTitle}
              onChange={(e) => setNotifyTitle(e.target.value)}
              className="rounded-xl px-3 py-2 text-xs text-[#EDF3F8] outline-none"
              style={{ backgroundColor: '#07090E', border: '1px solid var(--mj-border-strong)' }}
            />
            <input
              type="text"
              aria-label="Notification body"
              value={notifyBody}
              onChange={(e) => setNotifyBody(e.target.value)}
              className="rounded-xl px-3 py-2 text-xs text-[#EDF3F8] outline-none"
              style={{ backgroundColor: '#07090E', border: '1px solid var(--mj-border-strong)' }}
            />
          </div>
          <button
            type="button"
            onClick={() => void handleNotify()}
            className="inline-flex items-center gap-2 rounded-xl px-3.5 py-2 text-xs font-medium"
            style={{
              backgroundColor: 'rgba(154, 198, 230, 0.14)',
              border: '1px solid rgba(177, 215, 241, 0.24)',
              color: 'var(--mj-accent-ice)',
            }}
          >
            <span>Send Permitted Notification</span>
          </button>
        </Panel>

        {/* Clipboard Copy */}
        <Panel className="space-y-3 p-5">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2 text-sm font-medium text-[#EDF3F8]">
              <ClipboardCopy className="h-4 w-4 text-[#9AC6E6]" />
              <span>Copy Approved Text</span>
            </div>
            <StatusPill tone={permissions.clipboardWrite ? 'good' : 'neutral'}>
              {permissions.clipboardWrite ? 'Enabled' : 'OFF'}
            </StatusPill>
          </div>
          <input
            type="text"
            aria-label="Approved text to copy"
            value={clipboardText}
            onChange={(e) => setClipboardText(e.target.value)}
            className="w-full rounded-xl px-3 py-2 text-xs text-[#EDF3F8] outline-none"
            style={{ backgroundColor: '#07090E', border: '1px solid var(--mj-border-strong)' }}
          />
          <button
            type="button"
            onClick={() => void handleCopyText()}
            className="inline-flex items-center gap-2 rounded-xl px-3.5 py-2 text-xs font-medium"
            style={{
              backgroundColor: 'rgba(154, 198, 230, 0.14)',
              border: '1px solid rgba(177, 215, 241, 0.24)',
              color: 'var(--mj-accent-ice)',
            }}
          >
            <Cpu className="h-3.5 w-3.5" />
            <span>Copy Approved Text</span>
          </button>
        </Panel>
      </div>

      {/* Configurable Shortcuts (Section 14 Optional Advanced Capability — Ships OFF) */}
      <Panel className="space-y-4 p-6">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div>
            <div className="flex items-center gap-2 text-sm font-medium text-[#EDF3F8]">
              <Keyboard className="h-4 w-4 text-[#9AC6E6]" />
              <span>Configurable Shortcuts</span>
            </div>
            <p className="mt-1 text-xs" style={{ color: 'var(--mj-text-muted)' }}>
              Ships OFF. When enabled individually in Privacy Center, binds validated hotkeys (Ctrl/Alt/Meta + key) to approved MJ actions or allowlisted desktop targets with full audit logging.
            </p>
          </div>
          <StatusPill tone={permissions.configurableShortcuts ? 'good' : 'neutral'}>
            {permissions.configurableShortcuts ? 'Enabled' : 'OFF'}
          </StatusPill>
        </div>

        <form onSubmit={handleCreateShortcut} className="grid grid-cols-1 gap-2.5 sm:grid-cols-5">
          <input
            type="text"
            value={shortcutLabel}
            onChange={(e) => setShortcutLabel(e.target.value)}
            placeholder="Label (e.g. Quick Voice)"
            aria-label="Shortcut label"
            className="rounded-xl px-3 py-2 text-xs text-[#EDF3F8] outline-none placeholder:text-[#8B9CB0]"
            style={{ backgroundColor: '#07090E', border: '1px solid var(--mj-border-strong)' }}
          />
          <input
            type="text"
            value={shortcutAccelerator}
            onChange={(e) => setShortcutAccelerator(e.target.value)}
            onKeyDown={handleShortcutKeyDown}
            placeholder="Press keys (e.g. Ctrl+Shift+M)"
            aria-label="Shortcut key combo"
            className="rounded-xl px-3 py-2 font-mono text-xs text-[#EDF3F8] outline-none placeholder:text-[#8B9CB0]"
            style={{ backgroundColor: '#07090E', border: '1px solid var(--mj-border-strong)' }}
          />
          <select
            aria-label="Shortcut action"
            value={shortcutAction}
            onChange={(e) => setShortcutAction(e.target.value as ShortcutActionKind)}
            className="rounded-xl px-3 py-2 text-xs text-[#EDF3F8] outline-none"
            style={{ backgroundColor: '#07090E', border: '1px solid var(--mj-border-strong)' }}
          >
            <option value="toggle_voice">Toggle Voice Session</option>
            <option value="stop_all_mic">Emergency Stop Mic</option>
            <option value="focus_chat">Open Chat Workspace</option>
            <option value="focus_desktop">Open Desktop Companion</option>
            <option value="open_approved_app">Launch Approved App</option>
            <option value="open_approved_url">Open Approved HTTPS URL</option>
          </select>
          {shortcutAction === 'open_approved_app' || shortcutAction === 'open_approved_url' ? (
            <input
              type="text"
              value={shortcutTarget}
              onChange={(e) => setShortcutTarget(e.target.value)}
              placeholder={
                shortcutAction === 'open_approved_app'
                  ? 'Allowlisted app label/path'
                  : 'https://approved-domain.example'
              }
              aria-label="Shortcut action target"
              className="rounded-xl px-3 py-2 font-mono text-xs text-[#EDF3F8] outline-none placeholder:text-[#8B9CB0]"
              style={{ backgroundColor: '#07090E', border: '1px solid var(--mj-border-strong)' }}
            />
          ) : (
            <div
              className="flex items-center rounded-xl px-3 py-2 text-[11px]"
              style={{ backgroundColor: '#07090E', color: 'var(--mj-text-subtle)' }}
            >
              No external target needed
            </div>
          )}
          <button
            type="submit"
            disabled={savingShortcut || !shortcutLabel.trim() || !shortcutAccelerator.trim()}
            className="inline-flex items-center justify-center gap-1.5 rounded-xl px-3.5 py-2 text-xs font-medium transition disabled:opacity-50"
            style={{
              backgroundColor: 'rgba(154, 198, 230, 0.14)',
              border: '1px solid rgba(177, 215, 241, 0.24)',
              color: 'var(--mj-accent-ice)',
            }}
          >
            <Plus className="h-3.5 w-3.5" />
            <span>{savingShortcut ? 'Saving…' : 'Bind Shortcut'}</span>
          </button>
        </form>

        {shortcuts.length === 0 ? (
          <div
            className="rounded-xl p-3.5 text-xs"
            style={{
              backgroundColor: '#07090E',
              border: '1px solid var(--mj-border-subtle)',
              color: 'var(--mj-text-subtle)',
            }}
          >
            No configurable shortcuts saved yet.
          </div>
        ) : (
          <div className="space-y-2">
            {shortcuts.map((sc) => (
              <div
                key={sc.id}
                className="flex flex-wrap items-center justify-between gap-2 rounded-xl px-3.5 py-2.5 text-xs"
                style={{
                  backgroundColor: '#07090E',
                  border: '1px solid var(--mj-border-subtle)',
                }}
              >
                <div className="min-w-0 flex-1">
                  <span className="mr-2 rounded px-2 py-0.5 font-mono text-[11px] font-medium text-[#C7E3F5]" style={{ backgroundColor: 'rgba(154, 198, 230, 0.14)' }}>
                    {sc.accelerator}
                  </span>
                  <span className="font-medium text-[#EDF3F8]">{sc.label}</span>
                  <span className="ml-2 font-mono text-[11px]" style={{ color: 'var(--mj-text-muted)' }}>
                    {sc.action}
                    {sc.target ? ` -> ${sc.target}` : ''}
                  </span>
                </div>

                <div className="flex items-center gap-1.5">
                  <button
                    type="button"
                    onClick={() => void handleTriggerShortcut(sc)}
                    aria-label={`Trigger shortcut ${sc.label}`}
                    className="inline-flex items-center gap-1 rounded-lg px-2.5 py-1 text-[11px] font-medium transition hover:bg-white/5"
                    style={{
                      border: '1px solid var(--mj-border-subtle)',
                      color: 'var(--mj-accent-ice)',
                    }}
                  >
                    <Play className="h-3 w-3" />
                    <span>Trigger</span>
                  </button>
                  <button
                    type="button"
                    onClick={() => void handleDeleteShortcut(sc.id)}
                    aria-label={`Delete shortcut ${sc.label}`}
                    className="rounded-lg p-1.5 transition hover:bg-white/5"
                    style={{ color: 'var(--mj-status-error)' }}
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
      </Panel>
    </div>
  );
}

function TelemetryRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between gap-3 py-2">
      <dt style={{ color: 'var(--mj-text-muted)' }}>{label}</dt>
      <dd className="text-right font-mono text-[11px] text-[#EDF3F8]">{value}</dd>
    </div>
  );
}

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  const gb = bytes / (1024 * 1024 * 1024);
  if (gb >= 1) return `${gb.toFixed(1)} GB`;
  const mb = bytes / (1024 * 1024);
  return `${mb.toFixed(0)} MB`;
}
