import { Mic, Square } from 'lucide-react';

interface MicActiveBannerProps {
  liveVoiceActive: boolean;
  voiceMuted: boolean;
  wakeWordStandbyActive: boolean;
  onStopAllMic: () => void;
}

/**
 * Mandatory persistent, unmissable on-screen indicator shown whenever the
 * microphone is actively capturing audio—including wake-word standby (Section 14).
 */
export function MicActiveBanner({
  liveVoiceActive,
  voiceMuted,
  wakeWordStandbyActive,
  onStopAllMic,
}: MicActiveBannerProps) {
  if (!liveVoiceActive && !wakeWordStandbyActive) {
    return null;
  }

  const label = liveVoiceActive
    ? voiceMuted
      ? 'MICROPHONE SESSION OPEN · MUTED'
      : 'MICROPHONE ACTIVE · REALTIME VOICE CAPTURING'
    : 'MICROPHONE ACTIVE · WAKE-WORD STANDBY ("HEY MJ")';

  const bgColor = voiceMuted && !wakeWordStandbyActive
    ? 'rgba(227, 190, 126, 0.14)'
    : 'rgba(240, 138, 138, 0.15)';
  const borderColor = voiceMuted && !wakeWordStandbyActive
    ? 'rgba(227, 190, 126, 0.42)'
    : 'rgba(240, 138, 138, 0.45)';
  const textColor = voiceMuted && !wakeWordStandbyActive
    ? '#F5DFB5'
    : '#FFE2E2';

  return (
    <div
      role="status"
      aria-live="polite"
      className="sticky top-0 z-30 flex flex-wrap items-center justify-between gap-3 border-b px-4 py-2 text-xs backdrop-blur-md sm:px-6"
      style={{
        backgroundColor: bgColor,
        borderColor,
        color: textColor,
      }}
    >
      <div className="flex items-center gap-2.5">
        <span
          className="inline-block h-2.5 w-2.5 animate-pulse rounded-full"
          style={{
            backgroundColor: voiceMuted && !wakeWordStandbyActive ? '#E3BE7E' : '#F08A8A',
            boxShadow: '0 0 12px currentColor',
          }}
        />
        <Mic className="h-3.5 w-3.5 shrink-0" />
        <span className="font-mono text-[11px] font-medium tracking-[0.08em]">{label}</span>
      </div>

      <button
        type="button"
        onClick={onStopAllMic}
        className="inline-flex items-center gap-1.5 rounded-lg px-2.5 py-1 text-[11px] font-medium transition hover:bg-black/25"
        style={{
          border: `1px solid ${borderColor}`,
          color: textColor,
        }}
      >
        <Square className="h-3 w-3 fill-current" />
        <span>{liveVoiceActive ? 'Stop Voice' : 'Disable Wake-Word'}</span>
      </button>
    </div>
  );
}
