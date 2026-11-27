import type { VoiceState } from '@mj/shared';

export type OrbState = VoiceState | 'streaming';

export interface MJCoreOrbProps {
  state: OrbState;
  statusLabel: string;
  audioLevel?: number;
  micActive?: boolean;
  compact?: boolean;
}

const BAR_COUNT = 19;

/**
 * AURA-inspired central AI Orb for MJ Assistant.
 * Responds strictly to real audio RMS input/output levels or active text streaming,
 * and never fabricates microphone activity.
 */
export function MJCoreOrb({
  state,
  statusLabel,
  audioLevel = 0,
  micActive = false,
  compact = false,
}: MJCoreOrbProps) {
  const size = compact ? 184 : 244;
  const coreSize = compact ? 106 : 140;

  const isListening = state === 'listening';
  const isSpeaking = state === 'speaking' || state === 'streaming';
  const isConnecting =
    state === 'connecting' ||
    state === 'requesting_permission' ||
    state === 'processing' ||
    state === 'reconnecting';
  const isError = state === 'error';
  const isInterrupted = state === 'interrupted';

  const stateClass = isSpeaking
    ? 'mj-orb-streaming'
    : isListening || isConnecting
      ? 'mj-orb-connecting'
      : 'mj-orb-idle';

  const clampedAudio = Math.max(0, Math.min(1, audioLevel));
  const audioScale = isListening || isSpeaking ? 1 + clampedAudio * 0.1 : 1;

  const coreBorderColor = isError
    ? 'rgba(240, 138, 138, 0.44)'
    : isInterrupted
      ? 'rgba(227, 190, 126, 0.44)'
      : isSpeaking || isListening
        ? 'rgba(199, 227, 245, 0.5)'
        : 'rgba(194, 226, 247, 0.22)';

  const waveStroke = isError ? '#F08A8A' : isInterrupted ? '#E3BE7E' : '#D8EFFF';
  const dotColor = isError
    ? 'var(--mj-status-error)'
    : isConnecting || isInterrupted
      ? 'var(--mj-status-warn)'
      : isSpeaking
        ? 'var(--mj-accent-ice)'
        : isListening
          ? 'var(--mj-status-good)'
          : 'var(--mj-text-muted)';

  return (
    <div className="flex flex-col items-center select-none">
      <div
        className={`relative grid place-items-center ${stateClass}`}
        style={{ width: size, height: size }}
        role="img"
        aria-label={`MJ Core status: ${statusLabel}`}
      >
        {/* Orbital rings */}
        <div
          className="mj-orb-orbit-one pointer-events-none absolute rounded-full"
          style={{
            inset: '-6px',
            border: `1px solid ${
              isError
                ? 'rgba(240,138,138,0.24)'
                : isListening || isSpeaking
                  ? 'rgba(196,229,249,0.32)'
                  : 'rgba(166,208,237,0.16)'
            }`,
            transform: 'rotate(-22deg) scaleY(0.77)',
          }}
        />
        <div
          className="mj-orb-orbit-two pointer-events-none absolute rounded-full"
          style={{
            inset: '4px',
            border: '1px dashed rgba(166, 208, 237, 0.15)',
            transform: 'rotate(62deg) scaleY(0.9)',
          }}
        />
        <div
          className="pointer-events-none absolute rounded-full"
          style={{
            inset: '20px',
            border: '1px dotted rgba(176, 215, 240, 0.11)',
          }}
        />

        {/* Ambient halos */}
        <div
          className="pointer-events-none absolute rounded-full"
          style={{
            inset: '10px',
            border: '1px solid rgba(173, 211, 238, 0.14)',
            boxShadow:
              '0 0 64px rgba(107, 165, 207, 0.08), inset 0 0 34px rgba(134, 183, 217, 0.04)',
          }}
        />

        {/* Core Sphere */}
        <div
          className="mj-orb-core relative rounded-full transition-transform duration-150"
          style={{
            width: coreSize,
            height: coreSize,
            transform: `scale(${audioScale.toFixed(3)})`,
            background: isError
              ? 'radial-gradient(circle at 34% 24%, rgba(255,232,232,0.92) 0%, rgba(240,150,150,0.72) 10%, rgba(130,52,60,0.48) 38%, rgba(16,12,18,0.28) 72%, rgba(7,8,11,0.1) 85%)'
              : isInterrupted
                ? 'radial-gradient(circle at 34% 24%, rgba(255,244,224,0.92) 0%, rgba(227,190,126,0.72) 10%, rgba(128,96,42,0.42) 40%, rgba(16,14,12,0.28) 72%, rgba(7,8,11,0.1) 85%)'
                : 'radial-gradient(circle at 34% 24%, rgba(231,247,255,0.98) 0%, rgba(183,220,243,0.88) 7%, rgba(117,169,207,0.55) 20%, rgba(49,83,112,0.46) 42%, rgba(13,25,39,0.25) 68%, rgba(7,8,11,0.08) 82%)',
            boxShadow: isError
              ? '0 0 28px rgba(240,138,138,0.24), inset -14px -20px 32px rgba(0,0,0,0.52)'
              : 'var(--mj-shadow-orb), inset -14px -20px 34px rgba(0,0,0,0.52), inset 8px 10px 26px rgba(238,249,255,0.26)',
          }}
        >
          <div
            className="pointer-events-none absolute rounded-full"
            style={{
              inset: '-12px',
              border: `1px solid ${coreBorderColor}`,
              boxShadow: '0 0 24px rgba(144, 193, 226, 0.14)',
            }}
          />
        </div>

        {/* Harmonic Signal Line */}
        <svg
          className="pointer-events-none absolute z-10 overflow-visible"
          style={{
            width: compact ? 210 : 276,
            height: compact ? 64 : 80,
            filter: 'drop-shadow(0 0 6px rgba(172, 215, 244, 0.65))',
            opacity: isSpeaking || isListening ? 0.96 : 0.7,
          }}
          viewBox="0 0 300 86"
          aria-hidden="true"
        >
          <path
            d="M0 43 C28 43 34 43 48 35 S68 12 83 27 S102 62 119 43 S138 6 151 28 S170 70 186 43 S207 20 220 35 S242 49 254 43 S282 43 300 43"
            fill="none"
            stroke={waveStroke}
            strokeWidth="1.25"
            strokeLinecap="round"
            strokeOpacity="0.88"
          />
          <path
            d="M0 43 C34 43 44 43 58 39 S78 22 92 34 S108 54 125 43 S143 19 157 37 S174 61 191 43 S215 31 229 40 S251 46 265 43 S286 43 300 43"
            fill="none"
            stroke="#8CB9DA"
            strokeWidth="0.75"
            strokeOpacity="0.55"
          />
        </svg>

        {/* Real Audio-Synced Sound Bars */}
        <div
          className="mj-sound-bars pointer-events-none absolute inset-0 z-10 flex items-center justify-center gap-1.5"
          style={{
            opacity: isSpeaking || isListening || isConnecting ? 0.62 : 0.22,
          }}
          aria-hidden="true"
        >
          {Array.from({ length: BAR_COUNT }).map((_, index) => {
            const centerWeight = 1 - Math.abs(index - (BAR_COUNT - 1) / 2) / ((BAR_COUNT - 1) / 2);
            const liveHeightPx =
              clampedAudio > 0.01 && (isListening || isSpeaking)
                ? 8 + clampedAudio * 44 * (0.35 + centerWeight * 0.65)
                : compact
                  ? 8
                  : 10;
            return (
              <i
                key={index}
                className="block rounded-full transition-[height] duration-75"
                style={{
                  width: '2px',
                  height: `${Math.round(liveHeightPx)}px`,
                  background: 'linear-gradient(180deg, transparent, #B6D9EF, transparent)',
                }}
              />
            );
          })}
        </div>
      </div>

      <div
        className="mt-2 flex items-center gap-2.5 text-[11px] font-medium tracking-[0.16em] uppercase"
        style={{ color: 'var(--mj-text-secondary)' }}
        aria-live="polite"
      >
        <span
          className={`inline-block h-2 w-2 rounded-full ${micActive ? 'animate-pulse' : ''}`}
          style={{
            backgroundColor: dotColor,
            boxShadow: `0 0 10px ${dotColor}`,
          }}
        />
        <span>{statusLabel}</span>
      </div>
    </div>
  );
}
