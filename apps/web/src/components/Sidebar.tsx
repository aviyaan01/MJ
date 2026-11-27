import { Home, LogOut, MessageSquare, Settings, ShieldCheck } from 'lucide-react';
import { BrandMark } from '@mj/ui';
import type { AuthSessionDTO, SystemHealthDTO, VoiceState } from '@mj/shared';

export type ActiveNavTab = 'home' | 'chat' | 'settings';

interface SidebarProps {
  activeTab: ActiveNavTab;
  onSelectTab: (tab: ActiveNavTab) => void;
  health: SystemHealthDTO | null;
  session: AuthSessionDTO | null;
  voiceState: VoiceState;
  micActive: boolean;
  onLogout: () => void;
}

const NAV_ITEMS: Array<{ id: ActiveNavTab; label: string; icon: typeof Home }> = [
  { id: 'home', label: 'Home', icon: Home },
  { id: 'chat', label: 'Chat', icon: MessageSquare },
  { id: 'settings', label: 'Settings', icon: Settings },
];

const UPCOMING_STAGES = [
  { label: 'Memory & Tools', stage: 'Stage 3' },
  { label: 'Desktop OS', stage: 'Stage 4' },
];

export function Sidebar({
  activeTab,
  onSelectTab,
  health,
  session,
  voiceState,
  micActive,
  onLogout,
}: SidebarProps) {
  const backendOnline = health?.backend === 'online';
  const engineReady = health?.aiEngine === 'ready';

  return (
    <aside
      className="flex flex-col border-b md:sticky md:top-0 md:h-screen md:border-r md:border-b-0"
      style={{
        background: 'linear-gradient(180deg, rgba(13, 16, 23, 0.94), rgba(8, 10, 14, 0.92))',
        borderColor: 'var(--mj-border-subtle)',
        backdropFilter: 'blur(22px)',
      }}
    >
      <div className="flex items-center justify-between gap-3 px-4 py-3.5 md:px-5 md:pt-6 md:pb-5">
        <div className="flex items-center gap-3">
          <div
            className="grid h-10 w-10 shrink-0 place-items-center rounded-xl"
            style={{
              border: '1px solid rgba(199, 227, 245, 0.25)',
              background:
                'linear-gradient(145deg, rgba(164, 205, 232, 0.14), rgba(255, 255, 255, 0.02))',
              boxShadow:
                'inset 0 1px rgba(255, 255, 255, 0.12), 0 8px 24px rgba(87, 145, 184, 0.1)',
            }}
          >
            <BrandMark className="h-5 w-5" />
          </div>
          <div>
            <div className="text-sm font-semibold tracking-[0.2em] text-[#EDF3F8]">MJ</div>
            <div
              className="text-[10px] tracking-[0.16em] uppercase"
              style={{ color: 'var(--mj-text-subtle)' }}
            >
              STAGE 2 · VOICE &amp; TEXT
            </div>
          </div>
        </div>

        {/* Mobile quick status indicator */}
        <div className="flex items-center gap-2 md:hidden">
          <span
            className={`h-2 w-2 rounded-full ${micActive ? 'animate-pulse' : ''}`}
            style={{
              backgroundColor: micActive
                ? 'var(--mj-status-good)'
                : engineReady
                  ? 'var(--mj-status-good)'
                  : backendOnline
                    ? 'var(--mj-status-warn)'
                    : 'var(--mj-status-error)',
            }}
          />
          <span className="text-xs" style={{ color: 'var(--mj-text-secondary)' }}>
            {micActive ? `Voice: ${voiceState}` : engineReady ? 'Ready' : backendOnline ? 'Setup' : 'Offline'}
          </span>
        </div>
      </div>

      {/* Navigation */}
      <div className="px-3 pb-3 md:px-3.5 md:pb-0">
        <div
          className="mb-2 hidden px-2.5 text-[10px] font-medium tracking-[0.18em] uppercase md:block"
          style={{ color: 'var(--mj-text-subtle)' }}
        >
          Workspace
        </div>
        <nav aria-label="Main navigation" className="flex gap-1.5 overflow-x-auto md:flex-col">
          {NAV_ITEMS.map((item) => {
            const Icon = item.icon;
            const active = activeTab === item.id;
            return (
              <button
                key={item.id}
                type="button"
                onClick={() => onSelectTab(item.id)}
                aria-current={active ? 'page' : undefined}
                className="flex shrink-0 items-center gap-2.5 rounded-xl px-3.5 py-2.5 text-left text-xs font-medium transition md:w-full"
                style={{
                  background: active
                    ? 'linear-gradient(100deg, rgba(154, 198, 230, 0.14), rgba(154, 198, 230, 0.04))'
                    : 'transparent',
                  border: active
                    ? '1px solid rgba(177, 215, 241, 0.2)'
                    : '1px solid transparent',
                  color: active ? 'var(--mj-accent-ice)' : 'var(--mj-text-muted)',
                  boxShadow: active ? 'inset 2px 0 0 var(--mj-accent-blue)' : 'none',
                }}
              >
                <Icon className="h-4 w-4 shrink-0" />
                <span>{item.label}</span>
              </button>
            );
          })}
        </nav>
      </div>

      {/* Desktop Stage Status & Security Footer */}
      <div className="mt-auto hidden flex-col gap-3 p-4 md:flex">
        <div
          className="rounded-xl p-3.5"
          style={{
            backgroundColor: 'rgba(255, 255, 255, 0.02)',
            border: '1px solid var(--mj-border-subtle)',
          }}
        >
          <div
            className="mb-2.5 text-[10px] font-medium tracking-[0.16em] uppercase"
            style={{ color: 'var(--mj-text-secondary)' }}
          >
            Stage Roadmap
          </div>
          <ul className="space-y-1.5 text-[11px]">
            <li className="flex items-center justify-between">
              <span style={{ color: 'var(--mj-text-primary)' }}>Grok Text Chat</span>
              <span style={{ color: 'var(--mj-status-good)' }}>Active</span>
            </li>
            <li className="flex items-center justify-between">
              <span style={{ color: 'var(--mj-text-primary)' }}>Realtime Voice</span>
              <span style={{ color: 'var(--mj-status-good)' }}>Active</span>
            </li>
            {UPCOMING_STAGES.map((item) => (
              <li key={item.label} className="flex items-center justify-between">
                <span style={{ color: 'var(--mj-text-subtle)' }}>{item.label}</span>
                <span
                  className="rounded px-1.5 py-0.5 text-[10px]"
                  style={{
                    backgroundColor: 'rgba(255, 255, 255, 0.03)',
                    color: 'var(--mj-text-subtle)',
                  }}
                >
                  {item.stage}
                </span>
              </li>
            ))}
          </ul>
        </div>

        <div
          className="flex items-center justify-between gap-2 border-t pt-3.5"
          style={{ borderColor: 'var(--mj-border-subtle)' }}
        >
          <div className="flex min-w-0 items-center gap-2.5">
            <div
              className="grid h-8 w-8 shrink-0 place-items-center rounded-full text-xs font-medium"
              style={{
                background: 'linear-gradient(145deg, #24394B, #121C27)',
                border: '1px solid rgba(191, 220, 241, 0.22)',
                color: 'var(--mj-accent-ice)',
              }}
            >
              <ShieldCheck className="h-4 w-4" />
            </div>
            <div className="min-w-0">
              <div className="truncate text-xs font-medium text-[#DCE6EE]">
                Personal Session
              </div>
              <div className="flex items-center gap-1.5 text-[11px]" style={{ color: 'var(--mj-text-subtle)' }}>
                <span
                  className="inline-block h-1.5 w-1.5 rounded-full"
                  style={{
                    backgroundColor: session?.authenticated
                      ? 'var(--mj-status-good)'
                      : 'var(--mj-status-warn)',
                  }}
                />
                <span>{session?.mode === 'passcode' ? 'Passcode Auth' : 'Local Session'}</span>
              </div>
            </div>
          </div>

          {session?.passcodeRequired && (
            <button
              type="button"
              onClick={onLogout}
              title="Lock session"
              aria-label="Lock session"
              className="rounded-lg p-2 transition hover:bg-white/5"
              style={{ color: 'var(--mj-text-muted)' }}
            >
              <LogOut className="h-4 w-4" />
            </button>
          )}
        </div>
      </div>
    </aside>
  );
}
