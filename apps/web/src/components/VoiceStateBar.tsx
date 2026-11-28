import { Mic, MicOff } from 'lucide-react';
import { ALL_VOICE_STATES, VOICE_STATE_META } from '@mj/voice';
import type { VoiceState } from '@mj/shared';

export const REPEATED_ERROR_HINT = 'Try Settings -> Voice, or check VPN/browser';

export function nextRepeatedErrorState(
  prevSignature: string | null,
  prevCount: number,
  payload: { code: string; message: string },
): { signature: string; count: number; hint: string | null } {
  const signature = `${payload.code}:${payload.message.trim()}`;
  const count = prevSignature === signature ? prevCount + 1 : 1;
  return {
    signature,
    count,
    hint: count >= 2 ? REPEATED_ERROR_HINT : null,
  };
}

interface VoiceStateBarProps {
  currentState: VoiceState;
  detail: string;
  micActive: boolean;
  muted: boolean;
  repeatErrorHint?: string | null;
}

/**
 * Visible UI indicator for all 9 states of the Section 05 Voice State Machine,
 * plus an explicit live microphone capture status pill (privacy rule).
 */
export function VoiceStateBar({
  currentState,
  detail,
  micActive,
  muted,
  repeatErrorHint,
}: VoiceStateBarProps) {
  const meta = VOICE_STATE_META[currentState];

  return (
    <div
      className="w-full max-w-2xl rounded-2xl px-4 py-3"
      style={{
        backgroundColor: 'rgba(7, 9, 14, 0.72)',
        border: '1px solid var(--mj-border-subtle)',
      }}
    >
      <div className="flex flex-wrap items-center justify-between gap-2 text-xs">
        <div className="flex items-center gap-2">
          <span
            className="font-mono text-[10px] uppercase tracking-[0.14em]"
            style={{ color: 'var(--mj-text-subtle)' }}
          >
            STATE {meta.stepOrder}/9
          </span>
          <span className="font-medium text-[#EDF3F8]">{meta.label}</span>
          <span className="inline" style={{ color: 'var(--mj-text-muted)' }}>
            — {detail || meta.description}
          </span>
        </div>

        <div
          className="inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-[11px]"
          style={{
            backgroundColor: micActive
              ? muted
                ? 'rgba(227, 190, 126, 0.1)'
                : 'rgba(127, 209, 174, 0.1)'
              : 'rgba(255, 255, 255, 0.04)',
            border: micActive
              ? muted
                ? '1px solid rgba(227, 190, 126, 0.3)'
                : '1px solid rgba(127, 209, 174, 0.3)'
              : '1px solid var(--mj-border-subtle)',
            color: micActive
              ? muted
                ? 'var(--mj-status-warn)'
                : 'var(--mj-status-good)'
              : 'var(--mj-text-subtle)',
          }}
        >
          {micActive && !muted ? (
            <Mic className="h-3 w-3 animate-pulse" />
          ) : (
            <MicOff className="h-3 w-3" />
          )}
          <span>
            {micActive ? (muted ? 'Mic Muted' : 'Mic Live') : 'Mic Off'}
          </span>
        </div>
      </div>

      {/* 9-State Visual Machine Strip */}
      <div
        className="mt-2.5 flex flex-wrap gap-1.5"
        role="list"
        aria-label="Voice state machine states"
      >
        {ALL_VOICE_STATES.map((state) => {
          const item = VOICE_STATE_META[state];
          const active = state === currentState;
          const activeColor =
            item.tone === 'error'
              ? 'var(--mj-status-error)'
              : item.tone === 'warn'
                ? 'var(--mj-status-warn)'
                : item.tone === 'good'
                  ? 'var(--mj-status-good)'
                  : 'var(--mj-accent-ice)';

          return (
            <span
              key={state}
              role="listitem"
              aria-current={active ? 'step' : undefined}
              className="rounded-md px-2 py-0.5 text-[10px] font-medium transition"
              style={{
                backgroundColor: active
                  ? 'rgba(154, 198, 230, 0.14)'
                  : 'rgba(255, 255, 255, 0.02)',
                border: active
                  ? `1px solid ${activeColor}`
                  : '1px solid rgba(208, 225, 241, 0.06)',
                color: active ? activeColor : 'var(--mj-text-subtle)',
              }}
            >
              {item.label}
            </span>
          );
        })}
      </div>

      {repeatErrorHint && (
        <div
          role="status"
          className="mt-2.5 rounded-lg px-2.5 py-1.5 text-[11px]"
          style={{
            backgroundColor: 'rgba(227, 190, 126, 0.1)',
            border: '1px solid rgba(227, 190, 126, 0.28)',
            color: 'var(--mj-status-warn)',
          }}
        >
          {repeatErrorHint}
        </div>
      )}
    </div>
  );
}
