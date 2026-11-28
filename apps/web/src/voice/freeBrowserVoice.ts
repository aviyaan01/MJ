import {
  DEFAULT_BARGE_IN_PCM16_THRESHOLD,
  DEFAULT_FOLLOWUP_LISTEN_SECONDS,
  MAX_BARGE_IN_PCM16_THRESHOLD,
  MAX_FOLLOWUP_LISTEN_SECONDS,
  MIN_BARGE_IN_PCM16_THRESHOLD,
  MIN_FOLLOWUP_LISTEN_SECONDS,
  VoiceStates,
  type LanguageMode,
  type VoiceState,
} from '@mj/shared';
import { uint8SamplesToPcm16Rms } from '@mj/voice';

export const IDLE_WAKE_STATUS_MESSAGE = 'Say Hey MJ to wake me';

export interface VoicePermissionsCheck {
  microphoneAccess: boolean;
  voiceSessionAccess: boolean;
  externalWebServices?: boolean;
}

export interface BargeInMonitorDeps {
  getUserMedia?: (constraints: MediaStreamConstraints) => Promise<MediaStream>;
  createAudioContext?: () => AudioContext | null;
  pollIntervalMs?: number;
}

export function clampFollowupSeconds(seconds?: number): number {
  const raw = seconds ?? DEFAULT_FOLLOWUP_LISTEN_SECONDS;
  if (!Number.isFinite(raw)) return DEFAULT_FOLLOWUP_LISTEN_SECONDS;
  return Math.min(
    MAX_FOLLOWUP_LISTEN_SECONDS,
    Math.max(MIN_FOLLOWUP_LISTEN_SECONDS, Math.round(raw)),
  );
}

export function clampBargeInThreshold(threshold?: number): number {
  const raw = threshold ?? DEFAULT_BARGE_IN_PCM16_THRESHOLD;
  if (!Number.isFinite(raw)) return DEFAULT_BARGE_IN_PCM16_THRESHOLD;
  return Math.min(
    MAX_BARGE_IN_PCM16_THRESHOLD,
    Math.max(MIN_BARGE_IN_PCM16_THRESHOLD, Math.round(raw)),
  );
}

/**
 * Monitors microphone RMS amplitude on the 16-bit PCM scale while TTS speaks.
 * When RMS exceeds `thresholdPcm16` (default ~1400), fires `onBargeIn` once and stops cleanly.
 */
export function startMicBargeInMonitor(params: {
  thresholdPcm16?: number;
  canListen?: () => boolean;
  onBargeIn: () => void;
  onAudioLevel?: (level: number) => void;
  deps?: BargeInMonitorDeps;
}): { stop: () => void } {
  if (params.canListen && !params.canListen()) {
    return { stop: () => {} };
  }

  const getUserMediaFn =
    params.deps?.getUserMedia ??
    (typeof navigator !== 'undefined' && navigator.mediaDevices?.getUserMedia
      ? (constraints: MediaStreamConstraints) => navigator.mediaDevices.getUserMedia(constraints)
      : null);

  if (!getUserMediaFn) {
    return { stop: () => {} };
  }

  const threshold = clampBargeInThreshold(params.thresholdPcm16);
  const pollMs = Math.max(20, params.deps?.pollIntervalMs ?? 60);
  let stopped = false;
  let triggered = false;
  let stream: MediaStream | null = null;
  let audioCtx: AudioContext | null = null;
  let pollTimer: ReturnType<typeof setInterval> | null = null;

  const stop = () => {
    if (stopped) return;
    stopped = true;
    if (pollTimer) {
      clearInterval(pollTimer);
      pollTimer = null;
    }
    params.onAudioLevel?.(0);
    if (audioCtx) {
      try {
        void audioCtx.close();
      } catch {
        // ignore audio context close failure
      }
      audioCtx = null;
    }
    if (stream) {
      for (const track of stream.getTracks()) {
        try {
          track.stop();
        } catch {
          // ignore track stop failure
        }
      }
      stream = null;
    }
  };

  void (async () => {
    try {
      const captured = await getUserMediaFn({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        },
      });
      if (stopped || (params.canListen && !params.canListen())) {
        for (const track of captured.getTracks()) {
          try {
            track.stop();
          } catch {
            // ignore track stop failure
          }
        }
        return;
      }
      stream = captured;

      const createCtx =
        params.deps?.createAudioContext !== undefined
          ? params.deps.createAudioContext
          : () => {
              if (typeof window === 'undefined') return null;
              const AudioCtx =
                window.AudioContext ??
                (window as unknown as { webkitAudioContext?: typeof AudioContext })
                  .webkitAudioContext;
              return AudioCtx ? new AudioCtx() : null;
            };

      const ctx = typeof createCtx === 'function' ? createCtx() : createCtx;
      if (!ctx) {
        stop();
        return;
      }
      audioCtx = ctx;

      const source = ctx.createMediaStreamSource(stream);
      const analyser = ctx.createAnalyser();
      analyser.fftSize = 1024;
      source.connect(analyser);
      const samples = new Uint8Array(analyser.fftSize);

      pollTimer = setInterval(() => {
        if (stopped || triggered) return;
        if (params.canListen && !params.canListen()) {
          stop();
          return;
        }
        analyser.getByteTimeDomainData(samples);
        const pcm16Rms = uint8SamplesToPcm16Rms(samples);
        params.onAudioLevel?.(Math.min(1, pcm16Rms / 8192));
        if (pcm16Rms >= threshold) {
          triggered = true;
          stop();
          params.onBargeIn();
        }
      }, pollMs);
    } catch {
      stop();
    }
  })();

  return { stop };
}

interface BrowserSpeechRecognitionResult {
  isFinal: boolean;
  0?: { transcript?: string };
}

interface BrowserSpeechRecognitionEvent {
  resultIndex: number;
  results: ArrayLike<BrowserSpeechRecognitionResult>;
}

interface BrowserSpeechRecognition {
  lang: string;
  interimResults: boolean;
  continuous: boolean;
  maxAlternatives: number;
  onstart: (() => void) | null;
  onresult: ((ev: BrowserSpeechRecognitionEvent) => void) | null;
  onerror: ((ev: { error?: string }) => void) | null;
  onend: (() => void) | null;
  start: () => void;
  stop: () => void;
  abort: () => void;
}

type SpeechRecognitionConstructor = new () => BrowserSpeechRecognition;

function getSpeechRecognitionCtor(): SpeechRecognitionConstructor | null {
  if (typeof window === 'undefined') return null;
  const win = window as unknown as {
    SpeechRecognition?: SpeechRecognitionConstructor;
    webkitSpeechRecognition?: SpeechRecognitionConstructor;
  };
  return win.SpeechRecognition ?? win.webkitSpeechRecognition ?? null;
}

export function isFreeBrowserVoiceSupported(): boolean {
  return getSpeechRecognitionCtor() !== null;
}

export function resolveFreeVoiceLanguages(languageMode: LanguageMode): string[] {
  if (languageMode === 'bn') return ['bn-BD', 'en-US'];
  if (languageMode === 'en') return ['en-US'];
  const browserLang =
    typeof navigator !== 'undefined' ? navigator.language.toLowerCase() : '';
  return browserLang.startsWith('bn') ? ['bn-BD', 'en-US'] : ['en-US', 'bn-BD'];
}

export function speakWithBrowserSpeechSynthesis(
  text: string,
  options: {
    volume: number;
    speakingRate: number;
    languageMode: LanguageMode;
    voiceOutputEnabled?: boolean;
    onStart?: () => void;
    onEnd?: () => void;
    onError?: (msg: string) => void;
  },
): boolean {
  const trimmed = text.trim();
  if (!trimmed) {
    options.onEnd?.();
    return false;
  }
  if (options.voiceOutputEnabled === false) {
    options.onEnd?.();
    return false;
  }
  const UtteranceCtor =
    typeof window !== 'undefined'
      ? ((
          window as unknown as {
            SpeechSynthesisUtterance?: typeof SpeechSynthesisUtterance;
          }
        ).SpeechSynthesisUtterance ??
        (typeof SpeechSynthesisUtterance !== 'undefined' ? SpeechSynthesisUtterance : null))
      : null;

  if (typeof window === 'undefined' || !('speechSynthesis' in window) || !UtteranceCtor) {
    options.onError?.('Browser speech synthesis is unavailable.');
    options.onEnd?.();
    return false;
  }

  window.speechSynthesis.cancel();
  const utterance = new UtteranceCtor(trimmed.slice(0, 1200));
  const hasBengaliScript = /[\u0980-\u09FF]/.test(trimmed);
  utterance.lang = hasBengaliScript || options.languageMode === 'bn' ? 'bn-BD' : 'en-US';
  utterance.volume = Math.max(0, Math.min(1, options.volume));
  utterance.rate = Math.max(0.7, Math.min(1.6, options.speakingRate));

  const voices =
    typeof window.speechSynthesis.getVoices === 'function'
      ? window.speechSynthesis.getVoices()
      : [];
  const prefix = utterance.lang.split('-')[0]!.toLowerCase();
  const matchedVoice = voices.find((v) => v.lang.toLowerCase().startsWith(prefix));
  if (matchedVoice) {
    utterance.voice = matchedVoice;
  }

  utterance.onend = () => {
    options.onEnd?.();
  };
  utterance.onerror = () => {
    options.onEnd?.();
  };

  options.onStart?.();
  window.speechSynthesis.speak(utterance);
  return true;
}

export interface FreeBrowserVoiceController {
  stop: () => void;
  interrupt: () => void;
}

export type WebSpeechUnavailableReason = 'unsupported' | 'network' | 'service-not-allowed';

export interface SpeakReplyHandle {
  cancel: () => void;
}

/**
 * Shared Browser SpeechSynthesis reply speaker used by both Web Speech and Server STT fallbacks.
 * Supports optional RMS barge-in monitoring so speaking above threshold stops TTS and listens.
 */
export function speakVoiceReply(
  replyText: string,
  options: {
    volume: number;
    speakingRate: number;
    languageMode: LanguageMode;
    voiceOutputEnabled: boolean;
    onStateChange: (state: VoiceState, detail: string) => void;
    onFinish: () => void;
    isStopped?: () => boolean;
    statusPrefix?: string;
    skipIdleTransition?: boolean;
    bargeIn?: {
      enabled: boolean;
      threshold?: number;
      canListen?: () => boolean;
      onBargeIn: () => void;
      onAudioLevel?: (level: number) => void;
      deps?: BargeInMonitorDeps;
    };
  },
): boolean {
  const prefix = options.statusPrefix ? `${options.statusPrefix} · ` : '';
  let settled = false;
  let monitor: { stop: () => void } | null = null;

  const stopMonitor = () => {
    monitor?.stop();
    monitor = null;
  };

  const spoke = speakWithBrowserSpeechSynthesis(replyText, {
    volume: options.volume,
    speakingRate: options.speakingRate,
    languageMode: options.languageMode,
    voiceOutputEnabled: options.voiceOutputEnabled,
    onStart: () => {
      if (options.isStopped?.()) return;
      options.onStateChange(
        VoiceStates.SPEAKING,
        `${prefix}Speaking via Free Browser TTS ($0.00)…`,
      );
      if (
        options.bargeIn?.enabled &&
        (!options.bargeIn.canListen || options.bargeIn.canListen())
      ) {
        monitor = startMicBargeInMonitor({
          thresholdPcm16: options.bargeIn.threshold,
          canListen: () => !settled && !options.isStopped?.() && (options.bargeIn?.canListen?.() ?? true),
          onAudioLevel: options.bargeIn.onAudioLevel,
          deps: options.bargeIn.deps,
          onBargeIn: () => {
            if (settled || options.isStopped?.()) return;
            settled = true;
            stopMonitor();
            if (typeof window !== 'undefined' && 'speechSynthesis' in window) {
              window.speechSynthesis.cancel();
            }
            options.onStateChange(
              VoiceStates.INTERRUPTED,
              'Speech interrupted. Listening…',
            );
            options.bargeIn?.onBargeIn();
          },
        });
      }
    },
    onEnd: () => {
      stopMonitor();
      if (settled) return;
      settled = true;
      if (!options.isStopped?.()) {
        if (!options.skipIdleTransition) {
          options.onStateChange(VoiceStates.IDLE, 'Ready');
        }
        options.onFinish();
      }
    },
  });
  if (!spoke && !settled && !options.isStopped?.()) {
    settled = true;
    stopMonitor();
    if (!options.skipIdleTransition) {
      options.onStateChange(VoiceStates.IDLE, 'Ready');
    }
    options.onFinish();
  }
  return spoke;
}

export function startFreeBrowserVoiceSession(params: {
  languageMode: LanguageMode;
  volume: number;
  speakingRate: number;
  voiceOutputEnabled: boolean;
  autoListen?: boolean;
  followupListenSeconds?: number;
  followupTimeoutMs?: number;
  bargeInThreshold?: number;
  statusPrefix?: string;
  getPermissions?: () => VoicePermissionsCheck;
  bargeInDeps?: BargeInMonitorDeps;
  onAudioLevel?: (level: number) => void;
  onStateChange: (state: VoiceState, detail: string) => void;
  onTranscriptPreview: (text: string) => void;
  onSubmitTranscript: (text: string) => Promise<string>;
  onFinish: () => void;
  onErrorMessage: (msg: string) => void;
  onUnavailable?: (
    reason: WebSpeechUnavailableReason,
    detail: string,
    context?: { isFollowup: boolean },
  ) => void;
}): FreeBrowserVoiceController {
  const Ctor = getSpeechRecognitionCtor();
  if (!Ctor) {
    if (params.onUnavailable) {
      params.onUnavailable('unsupported', 'Web Speech unavailable in this browser.', {
        isFollowup: false,
      });
    } else {
      params.onErrorMessage(
        'Web Speech unavailable in this browser. Chrome or Edge supports Web Speech, or use Server STT.',
      );
      params.onFinish();
    }
    return { stop: () => {}, interrupt: () => {} };
  }

  let stopped = false;
  let speaking = false;
  let activeTurnIsFollowup = false;
  const candidateLangs = resolveFreeVoiceLanguages(params.languageMode);
  let langIdx = 0;
  let recognition: BrowserSpeechRecognition | null = null;
  let followupTimer: ReturnType<typeof setTimeout> | null = null;
  let restartTimer: ReturnType<typeof setTimeout> | null = null;
  let clearBargeInSpeechHandler: (() => void) | null = null;

  const autoListenEnabled = Boolean(params.autoListen);
  const followupSecs = clampFollowupSeconds(params.followupListenSeconds);
  const followupMs =
    params.followupTimeoutMs && params.followupTimeoutMs > 0
      ? params.followupTimeoutMs
      : followupSecs * 1000;

  const clearTimers = () => {
    if (followupTimer) {
      clearTimeout(followupTimer);
      followupTimer = null;
    }
    if (restartTimer) {
      clearTimeout(restartTimer);
      restartTimer = null;
    }
  };

  const canContinueVoice = (): boolean => {
    if (stopped) return false;
    if (!params.getPermissions) return true;
    const perms = params.getPermissions();
    return Boolean(perms.microphoneAccess && perms.voiceSessionAccess);
  };

  const finishWithIdle = (detail = 'Ready') => {
    clearTimers();
    recognition = null;
    params.onStateChange(VoiceStates.IDLE, detail);
    params.onFinish();
  };

  const startRecognitionPass = (isFollowup: boolean, existingDeadlineMs?: number) => {
    if (stopped) return;
    if (!canContinueVoice()) {
      stopped = true;
      finishWithIdle('Ready');
      return;
    }

    clearTimers();
    activeTurnIsFollowup = isFollowup;
    const deadlineMs = isFollowup ? (existingDeadlineMs ?? Date.now() + followupMs) : undefined;
    if (deadlineMs !== undefined && deadlineMs <= Date.now()) {
      finishWithIdle(IDLE_WAKE_STATUS_MESSAGE);
      return;
    }

    const activeLang = candidateLangs[langIdx] ?? 'en-US';
    const rec = new Ctor();
    recognition = rec;
    rec.lang = activeLang;
    rec.interimResults = true;
    rec.continuous = false;
    rec.maxAlternatives = 1;

    let handledFinal = false;
    let followupExpired = false;
    let heardSpeechInFollowup = false;

    const cancelFollowupTimer = () => {
      if (followupTimer) {
        clearTimeout(followupTimer);
        followupTimer = null;
      }
    };

    if (isFollowup && deadlineMs !== undefined) {
      const remaining = Math.max(1, deadlineMs - Date.now());
      followupTimer = setTimeout(() => {
        if (stopped || handledFinal || recognition !== rec) return;
        followupExpired = true;
        try {
          rec.abort();
        } catch {
          // ignore abort race
        }
        finishWithIdle(IDLE_WAKE_STATUS_MESSAGE);
      }, remaining);
    }

    const prefix = params.statusPrefix ? `${params.statusPrefix} · ` : '';
    params.onStateChange(
      VoiceStates.LISTENING,
      isFollowup
        ? `${prefix}Listening for follow-up (${followupSecs}s · ${activeLang})… Speak now`
        : `${prefix}Listening (Free Browser Voice · ${activeLang} · $0.00)… Speak now`,
    );

    rec.onresult = (event) => {
      if (stopped || followupExpired || recognition !== rec) return;
      let transcript = '';
      let isFinal = false;
      for (let i = event.resultIndex; i < event.results.length; i++) {
        const item = event.results[i];
        if (item?.[0]?.transcript) {
          transcript += item[0].transcript;
        }
        if (item?.isFinal) isFinal = true;
      }
      const trimmed = transcript.trim();
      if (!trimmed) return;

      // Cancel the follow-up countdown as soon as the user starts speaking.
      if (!heardSpeechInFollowup) {
        heardSpeechInFollowup = true;
        cancelFollowupTimer();
      }
      params.onTranscriptPreview(trimmed);

      if (isFinal && !handledFinal) {
        handledFinal = true;
        cancelFollowupTimer();
        recognition = null;
        try {
          rec.stop();
        } catch {
          // ignore stop race
        }
        params.onStateChange(
          VoiceStates.PROCESSING,
          'Thinking via free AI provider…',
        );
        void (async () => {
          try {
            const replyText = await params.onSubmitTranscript(trimmed);
            if (stopped) return;
            speaking = true;
            let bargeInTriggered = false;
            clearBargeInSpeechHandler = () => {
              bargeInTriggered = true;
            };
            speakVoiceReply(replyText, {
              volume: params.volume,
              speakingRate: params.speakingRate,
              languageMode: params.languageMode,
              voiceOutputEnabled: params.voiceOutputEnabled,
              skipIdleTransition: autoListenEnabled && canContinueVoice(),
              onStateChange: params.onStateChange,
              isStopped: () => stopped || bargeInTriggered,
              bargeIn: {
                enabled: true,
                threshold: params.bargeInThreshold,
                canListen: () => !stopped && canContinueVoice(),
                onAudioLevel: params.onAudioLevel,
                deps: params.bargeInDeps,
                onBargeIn: () => {
                  speaking = false;
                  clearBargeInSpeechHandler = null;
                  if (!stopped && canContinueVoice()) {
                    startRecognitionPass(false);
                  } else {
                    finishWithIdle('Ready');
                  }
                },
              },
              onFinish: () => {
                speaking = false;
                clearBargeInSpeechHandler = null;
                if (stopped || bargeInTriggered) return;
                if (autoListenEnabled && canContinueVoice()) {
                  startRecognitionPass(true);
                } else {
                  finishWithIdle('Ready');
                }
              },
            });
          } catch (err) {
            speaking = false;
            if (!stopped) {
              clearTimers();
              params.onErrorMessage(
                err instanceof Error ? err.message : 'Free voice turn failed.',
              );
              params.onFinish();
            }
          }
        })();
      }
    };

    rec.onerror = (ev) => {
      if (stopped || followupExpired || handledFinal || recognition !== rec) return;
      const errType = ev.error ?? 'unknown';
      if (errType === 'aborted') return;

      if (
        (errType === 'language-not-supported' || errType === 'no-speech') &&
        !isFollowup &&
        langIdx + 1 < candidateLangs.length
      ) {
        langIdx += 1;
        startRecognitionPass(false);
        return;
      }

      if (errType === 'network' || errType === 'service-not-allowed') {
        handledFinal = true;
        cancelFollowupTimer();
        recognition = null;
        try {
          rec.abort();
        } catch {
          // ignore abort race
        }
        if (params.onUnavailable) {
          params.onUnavailable(errType, `Web Speech unavailable (${errType}).`, {
            isFollowup,
          });
        } else {
          params.onErrorMessage(`Web Speech unavailable (${errType}).`);
          params.onFinish();
        }
        return;
      }

      if (errType === 'not-allowed') {
        stopped = true;
        cancelFollowupTimer();
        recognition = null;
        params.onErrorMessage('Microphone permission denied in browser.');
        params.onFinish();
        return;
      }

      if (errType === 'no-speech') {
        if (isFollowup && deadlineMs !== undefined && !heardSpeechInFollowup) {
          const remaining = deadlineMs - Date.now();
          if (remaining > 300 && canContinueVoice()) {
            restartTimer = setTimeout(() => {
              if (!stopped && recognition === null) {
                startRecognitionPass(true, deadlineMs);
              }
            }, 150);
            recognition = null;
            return;
          }
          finishWithIdle(IDLE_WAKE_STATUS_MESSAGE);
          return;
        }
        finishWithIdle('No speech detected.');
        return;
      }

      clearTimers();
      recognition = null;
      params.onErrorMessage(`Browser speech error: ${errType}`);
      params.onFinish();
    };

    rec.onend = () => {
      if (stopped || followupExpired || handledFinal || recognition !== rec) return;
      recognition = null;
      if (isFollowup && deadlineMs !== undefined && !heardSpeechInFollowup) {
        const remaining = deadlineMs - Date.now();
        if (remaining > 300 && canContinueVoice()) {
          restartTimer = setTimeout(() => {
            if (!stopped && recognition === null) {
              startRecognitionPass(true, deadlineMs);
            }
          }, 150);
          return;
        }
        finishWithIdle(IDLE_WAKE_STATUS_MESSAGE);
        return;
      }
      finishWithIdle('Ready');
    };

    try {
      rec.start();
    } catch (err) {
      clearTimers();
      recognition = null;
      params.onErrorMessage(err instanceof Error ? err.message : 'Could not start speech input.');
      params.onFinish();
    }
  };

  startRecognitionPass(false);

  return {
    stop: () => {
      if (stopped) return;
      stopped = true;
      speaking = false;
      clearBargeInSpeechHandler?.();
      clearBargeInSpeechHandler = null;
      clearTimers();
      try {
        recognition?.abort();
      } catch {
        // ignore abort error
      }
      recognition = null;
      if (typeof window !== 'undefined' && 'speechSynthesis' in window) {
        window.speechSynthesis.cancel();
      }
      params.onStateChange(VoiceStates.IDLE, 'Ready');
      params.onFinish();
    },
    interrupt: () => {
      if (stopped) return;
      clearBargeInSpeechHandler?.();
      clearBargeInSpeechHandler = null;
      if (typeof window !== 'undefined' && 'speechSynthesis' in window) {
        window.speechSynthesis.cancel();
      }
      if (speaking && autoListenEnabled && canContinueVoice()) {
        speaking = false;
        params.onStateChange(VoiceStates.INTERRUPTED, 'Speech interrupted. Listening…');
        startRecognitionPass(false);
        return;
      }
      speaking = false;
      if (!activeTurnIsFollowup) {
        stopped = true;
        finishWithIdle('Ready');
      } else {
        stopped = true;
        finishWithIdle(IDLE_WAKE_STATUS_MESSAGE);
      }
    },
  };
}
