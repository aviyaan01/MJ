import { useEffect, useState } from 'react';
import { Check, Mic, ShieldAlert, X } from 'lucide-react';
import type { PendingToolConfirmationDTO } from '@mj/shared';

interface ToolConfirmationBannerProps {
  confirmation: PendingToolConfirmationDTO;
  busy?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}

/**
 * Displays a 20-second interactive confirmation prompt for `confirm`-risk AI tools
 * with both UI buttons and multilingual voice confirmation hints (English / Bangla / Hindi).
 */
export function ToolConfirmationBanner({
  confirmation,
  busy = false,
  onConfirm,
  onCancel,
}: ToolConfirmationBannerProps) {
  const [remainingSeconds, setRemainingSeconds] = useState<number>(() => {
    const expiresMs = Date.parse(confirmation.expiresAt);
    if (!Number.isFinite(expiresMs)) return confirmation.timeoutSeconds;
    return Math.max(0, Math.ceil((expiresMs - Date.now()) / 1000));
  });

  useEffect(() => {
    const expiresMs = Date.parse(confirmation.expiresAt);
    const updateRemaining = () => {
      if (!Number.isFinite(expiresMs)) {
        setRemainingSeconds(confirmation.timeoutSeconds);
        return;
      }
      setRemainingSeconds(Math.max(0, Math.ceil((expiresMs - Date.now()) / 1000)));
    };
    updateRemaining();
    const timer = setInterval(updateRemaining, 250);
    return () => clearInterval(timer);
  }, [confirmation.confirmationId, confirmation.expiresAt, confirmation.timeoutSeconds]);

  return (
    <div
      role="alertdialog"
      aria-label={`Confirm tool action ${confirmation.toolName}`}
      className="mx-auto w-full max-w-2xl rounded-2xl p-4 text-xs shadow-lg"
      style={{
        backgroundColor: 'rgba(22, 18, 11, 0.92)',
        border: '1px solid rgba(227, 190, 126, 0.45)',
        color: '#F5DFB5',
      }}
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex min-w-0 flex-1 items-start gap-2.5">
          <ShieldAlert className="mt-0.5 h-4 w-4 shrink-0 text-[#E3BE7E]" />
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2 font-medium text-[#FAF0D7]">
              <span>Confirmation Required</span>
              <span className="rounded bg-white/10 px-1.5 py-0.5 font-mono text-[10px] text-[#E3BE7E]">
                {confirmation.toolName}
              </span>
              <span className="rounded bg-white/5 px-1.5 py-0.5 font-mono text-[10px] text-[#C7D4E1]">
                {remainingSeconds}s
              </span>
            </div>
            <p className="mt-1 text-xs leading-relaxed text-[#E6EEF5]">{confirmation.summary}</p>
            <div
              className="mt-1.5 flex items-center gap-1.5 text-[11px]"
              style={{ color: 'var(--mj-text-muted)' }}
            >
              <Mic className="h-3 w-3 shrink-0 text-[#9AC6E6]" />
              <span>
                Voice: say <strong>&quot;Yes / Haan / করো / हाँ&quot;</strong> to approve or{' '}
                <strong>&quot;No / Na / না / नहीं&quot;</strong> to cancel ({remainingSeconds}s left)
              </span>
            </div>
          </div>
        </div>

        <div className="flex shrink-0 items-center gap-2">
          <button
            type="button"
            disabled={busy || remainingSeconds <= 0}
            onClick={onConfirm}
            className="inline-flex items-center gap-1 rounded-xl px-3 py-1.5 text-xs font-medium transition disabled:opacity-50"
            style={{
              backgroundColor: 'rgba(127, 209, 174, 0.18)',
              border: '1px solid rgba(127, 209, 174, 0.45)',
              color: 'var(--mj-status-good)',
            }}
          >
            <Check className="h-3.5 w-3.5" />
            <span>Confirm</span>
          </button>

          <button
            type="button"
            disabled={busy}
            onClick={onCancel}
            className="inline-flex items-center gap-1 rounded-xl px-3 py-1.5 text-xs font-medium transition disabled:opacity-50"
            style={{
              backgroundColor: 'rgba(240, 138, 138, 0.14)',
              border: '1px solid rgba(240, 138, 138, 0.4)',
              color: 'var(--mj-status-error)',
            }}
          >
            <X className="h-3.5 w-3.5" />
            <span>Cancel</span>
          </button>
        </div>
      </div>
    </div>
  );
}
