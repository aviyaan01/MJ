import type { ReactNode } from 'react';

export type StatusTone = 'good' | 'warn' | 'error' | 'neutral';

export interface StatusPillProps {
  tone?: StatusTone;
  children: ReactNode;
  pulse?: boolean;
}

const TONE_MAP: Record<StatusTone, { color: string; bg: string; border: string }> = {
  good: {
    color: 'var(--mj-status-good)',
    bg: 'rgba(127, 209, 174, 0.08)',
    border: 'rgba(127, 209, 174, 0.25)',
  },
  warn: {
    color: 'var(--mj-status-warn)',
    bg: 'rgba(227, 190, 126, 0.09)',
    border: 'rgba(227, 190, 126, 0.26)',
  },
  error: {
    color: 'var(--mj-status-error)',
    bg: 'rgba(240, 138, 138, 0.09)',
    border: 'rgba(240, 138, 138, 0.28)',
  },
  neutral: {
    color: 'var(--mj-accent-ice)',
    bg: 'rgba(199, 227, 245, 0.06)',
    border: 'var(--mj-border-subtle)',
  },
};

export function StatusPill({ tone = 'neutral', children, pulse = false }: StatusPillProps) {
  const palette = TONE_MAP[tone];
  return (
    <span
      className="inline-flex items-center gap-2 rounded-full px-3 py-1 text-[11px] font-medium tracking-[0.06em] uppercase whitespace-nowrap"
      style={{
        color: palette.color,
        backgroundColor: palette.bg,
        border: `1px solid ${palette.border}`,
      }}
    >
      <span
        className={`h-1.5 w-1.5 rounded-full ${pulse ? 'animate-pulse' : ''}`}
        style={{ backgroundColor: palette.color, boxShadow: `0 0 8px ${palette.color}` }}
      />
      {children}
    </span>
  );
}
