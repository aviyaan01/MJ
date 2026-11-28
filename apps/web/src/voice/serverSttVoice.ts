import {
  DEFAULT_BARGE_IN_PCM16_THRESHOLD,
  ErrorCodes,
  VoiceStates,
  type LanguageMode,
  type PermissionsStateDTO,
  type StructuredErrorPayload,
  type VoiceState,
} from '@mj/shared';
import { uint8SamplesToPcm16Rms } from '@mj/voice';
import {
  ApiClientError,
  mjApi,
  type SttTranscribeRequest,
  type SttTranscribeResponse,
} from '../api/client.js';
import {
  IDLE_WAKE_STATUS_MESSAGE,
  clampFollowupSeconds,
  speakVoiceReply,
  startFreeBrowserVoiceSession,
  type BargeInMonitorDeps,
  type FreeBrowserVoiceController,
  type WebSpeechUnavailableReason,
} from './freeBrowserVoice.js';

export { IDLE_WAKE_STATUS_MESSAGE };

export const SERVER_STT_MAX_RECORDING_MS = 15_000;
export const SERVER_STT_MAX_BASE64_CHARS = 12_000_000;
export const SERVER_STT_MAX_RAW_BYTES = 8_900_000;
export const SERVER_STT_FALLBACK_NOTICE =
  'Browser speech unavailable, using server transcription';

const PREFERRED_MIME_TYPES = [
  'audio/webm;codecs=opus',
  'audio/webm',
  'audio/ogg;codecs=opus',
  'audio/ogg',
  'audio/mp4',
];

export type VoicePrivacySubset = Pick<
  PermissionsStateDTO,
  'microphoneAccess' | 'voiceSessionAccess' | 'externalWebServices'
>;

export interface MediaRecorderLike {
  state: 'inactive' | 'recording' | 'paused';
  mimeType?: string;
  ondataavailable: ((ev: { data?: Blob }) => void) | null;
  onstop: (() => void) | null;
  onerror: ((ev: { error?: { message?: string } }) => void) | null;
  start: (timeslice?: number) => void;
  stop: () => void;
}

export interface ServerSttVoiceDeps {
  getUserMedia?: (constraints: MediaStreamConstraints) => Promise<MediaStream>;
  createMediaRecorder?: (stream: MediaStream, mimeType: string) => MediaRecorderLike;
  isMimeTypeSupported?: (mimeType: string) => boolean;
  createAudioContext?: () => AudioContext | null;
  transcribeSpeech?: (
    input: SttTranscribeRequest,
    signal?: AbortSignal,
  ) => Promise<SttTranscribeResponse>;
  maxDurationMs?: number;
  followupTimeoutMs?: number;
  silenceDurationMs?: number;
  minSpeechBeforeSilenceMs?: number;
  silenceThresholdRms?: number;
  bargeInDeps?: BargeInMonitorDeps;
}

export function selectRecorderMimeType(
  isSupported?: (mimeType: string) => boolean,
): string {
  const checker =
    isSupported ??
    ((mime) =>
      typeof MediaRecorder !== 'undefined' &&
      typeof MediaRecorder.isTypeSupported === 'function' &&
      MediaRecorder.isTypeSupported(mime));

  for (const candidate of PREFERRED_MIME_TYPES) {
    try {
      if (checker(candidate)) {
        return candidate;
      }
    } catch {
      // ignore invalid candidate check
    }
  }
  return 'audio/webm';
}

export function extensionForAudioMimeType(mimeType: string): string {
  const base = mimeType.toLowerCase().split(';')[0]?.trim() ?? 'audio/webm';
  switch (base) {
    case 'audio/ogg':
      return 'ogg';
    case 'audio/mp4':
      return 'mp4';
    case 'audio/mpeg':
      return 'mp3';
    case 'audio/wav':
    case 'audio/x-wav':
      return 'wav';
    case 'audio/flac':
      return 'flac';
    case 'audio/aac':
      return 'aac';
    default:
      return 'webm';
  }
}

export function uint8ArrayToBase64(bytes: Uint8Array): string {
  if (bytes.length === 0) return '';
  if (typeof btoa === 'function') {
    const chunkSize = 0x8000;
    let binary = '';
    for (let i = 0; i < bytes.length; i += chunkSize) {
      const slice = bytes.subarray(i, Math.min(i + chunkSize, bytes.length));
      binary += String.fromCharCode(...slice);
    }
    return btoa(binary);
  }
  const nodeBuffer = (
    globalThis as { Buffer?: { from: (data: Uint8Array) => { toString: (enc: string) => string } } }
  ).Buffer;
  return nodeBuffer ? nodeBuffer.from(bytes).toString('base64') : '';
}

export function checkVoicePrivacyPermissions(
  permissions: VoicePrivacySubset,
  options: { requireExternalWebServices: boolean },
): StructuredErrorPayload | null {
  if (!permissions.microphoneAccess) {
    return {
      code: ErrorCodes.PERMISSION_DENIED,
      category: 'privacy',
      statusCode: 403,
      message: 'Microphone access is disabled in Privacy & Permissions.',
      retryable: false,
    };
  }
  if (!permissions.voiceSessionAccess) {
    return {
      code: ErrorCodes.PERMISSION_DENIED,
      category: 'privacy',
      statusCode: 403,
      message: 'Voice sessions are disabled in Privacy & Permissions.',
      retryable: false,
    };
  }
  if (options.requireExternalWebServices && !permissions.externalWebServices) {
    return {
      code: ErrorCodes.PERMISSION_DENIED,
      category: 'privacy',
      statusCode: 403,
      message:
        'External Web & AI Services is disabled in Privacy & Permissions. Audio will not be sent for server transcription.',
      retryable: false,
    };
  }
  return null;
}

function toStructuredVoiceError(err: unknown, fallbackMessage: string): StructuredErrorPayload {
  if (err instanceof ApiClientError) {
    return err.payload;
  }
  if (err instanceof Error && err.name === 'NotAllowedError') {
    return {
      code: ErrorCodes.PERMISSION_DENIED,
      category: 'privacy',
      statusCode: 403,
      message: 'Microphone permission denied in browser.',
      retryable: false,
    };
  }
  if (err instanceof Error && err.name === 'NotFoundError') {
    return {
      code: ErrorCodes.VOICE_SERVICE_UNAVAILABLE,
      category: 'voice',
      statusCode: 503,
      message: 'No microphone device found on this system.',
      retryable: true,
    };
  }
  return {
    code: ErrorCodes.VOICE_SERVICE_UNAVAILABLE,
    category: 'voice',
    statusCode: 503,
    message: err instanceof Error && err.message ? err.message : fallbackMessage,
    retryable: true,
  };
}

/**
 * Records microphone audio via MediaRecorder (until silence or max 15s), enforces the 12 MB STT limit
 * and all privacy gates, sends base64 audio to `POST /api/voice/stt`, submits the transcript to chat,
 * speaks the assistant reply (with RMS barge-in), and optionally reopens for follow-up listening.
 */
export function startServerSttVoiceSession(
  params: {
    languageMode: LanguageMode;
    volume: number;
    speakingRate: number;
    voiceOutputEnabled: boolean;
    autoListen?: boolean;
    followupListenSeconds?: number;
    bargeInThreshold?: number;
    isFollowup?: boolean;
    getPermissions?: () => VoicePrivacySubset;
    statusNotice?: string;
    onAudioLevel?: (level: number) => void;
    onStateChange: (state: VoiceState, detail: string) => void;
    onTranscriptPreview: (text: string) => void;
    onSubmitTranscript: (text: string) => Promise<string>;
    onFinish: () => void;
    onError: (msg: string, payload?: StructuredErrorPayload) => void;
  },
  deps: ServerSttVoiceDeps = {},
): FreeBrowserVoiceController {
  const initialPermissionError = params.getPermissions
    ? checkVoicePrivacyPermissions(params.getPermissions(), {
        requireExternalWebServices: true,
      })
    : null;
  if (initialPermissionError) {
    params.onError(initialPermissionError.message, initialPermissionError);
    params.onFinish();
    return { stop: () => {}, interrupt: () => {} };
  }

  const getUserMediaFn =
    deps.getUserMedia ??
    (typeof navigator !== 'undefined' && navigator.mediaDevices?.getUserMedia
      ? (constraints: MediaStreamConstraints) => navigator.mediaDevices.getUserMedia(constraints)
      : null);

  const hasRecorderCtor =
    Boolean(deps.createMediaRecorder) || typeof MediaRecorder !== 'undefined';

  if (!getUserMediaFn || !hasRecorderCtor) {
    const payload: StructuredErrorPayload = {
      code: ErrorCodes.VOICE_SERVICE_UNAVAILABLE,
      category: 'voice',
      statusCode: 503,
      message:
        'Microphone recording (MediaRecorder) is unavailable in this browser for server transcription.',
      retryable: false,
    };
    params.onError(payload.message, payload);
    params.onFinish();
    return { stop: () => {}, interrupt: () => {} };
  }

  let stopped = false;
  let aborted = false;
  let speaking = false;
  let activeTurnIsFollowup = Boolean(params.isFollowup);
  let stream: MediaStream | null = null;
  let recorder: MediaRecorderLike | null = null;
  let audioCtx: AudioContext | null = null;
  let silenceTimer: ReturnType<typeof setInterval> | null = null;
  let maxDurationTimer: ReturnType<typeof setTimeout> | null = null;
  let followupTimer: ReturnType<typeof setTimeout> | null = null;
  let uploadAbort = new AbortController();
  let clearBargeInSpeechHandler: (() => void) | null = null;

  const autoListenEnabled = Boolean(params.autoListen);
  const followupSecs = clampFollowupSeconds(params.followupListenSeconds);
  const followupMs =
    deps.followupTimeoutMs && deps.followupTimeoutMs > 0
      ? deps.followupTimeoutMs
      : followupSecs * 1000;

  const canContinueVoice = (): boolean => {
    if (stopped || aborted) return false;
    if (!params.getPermissions) return true;
    return (
      checkVoicePrivacyPermissions(params.getPermissions(), {
        requireExternalWebServices: true,
      }) === null
    );
  };

  const cleanupMedia = () => {
    if (followupTimer) {
      clearTimeout(followupTimer);
      followupTimer = null;
    }
    if (silenceTimer) {
      clearInterval(silenceTimer);
      silenceTimer = null;
    }
    if (maxDurationTimer) {
      clearTimeout(maxDurationTimer);
      maxDurationTimer = null;
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
          // ignore track stop error
        }
      }
      stream = null;
    }
  };

  const finishWithIdle = (detail = 'Ready') => {
    cleanupMedia();
    recorder = null;
    params.onStateChange(VoiceStates.IDLE, detail);
    params.onFinish();
  };

  const prefix = params.statusNotice ? `${params.statusNotice} · ` : '';

  const startCaptureTurn = (isFollowupTurn: boolean) => {
    if (stopped || aborted) return;
    if (!canContinueVoice()) {
      stopped = true;
      finishWithIdle('Ready');
      return;
    }

    activeTurnIsFollowup = isFollowupTurn;
    uploadAbort = new AbortController();

    void (async () => {
      try {
        params.onStateChange(
          VoiceStates.REQUESTING_PERMISSION,
          isFollowupTurn
            ? `${prefix}Reopening mic for follow-up (${followupSecs}s)…`
            : `${prefix}Requesting microphone permission…`,
        );
        stream = await getUserMediaFn({ audio: true });
        if (stopped || aborted) {
          cleanupMedia();
          return;
        }

        const recheckPerms = params.getPermissions
          ? checkVoicePrivacyPermissions(params.getPermissions(), {
              requireExternalWebServices: true,
            })
          : null;
        if (recheckPerms) {
          cleanupMedia();
          params.onError(recheckPerms.message, recheckPerms);
          params.onFinish();
          return;
        }

        const mimeType = selectRecorderMimeType(deps.isMimeTypeSupported);
        const activeRecorder: MediaRecorderLike = deps.createMediaRecorder
          ? deps.createMediaRecorder(stream, mimeType)
          : (new MediaRecorder(
              stream,
              mimeType ? { mimeType } : undefined,
            ) as unknown as MediaRecorderLike);
        recorder = activeRecorder;

        const chunks: Blob[] = [];
        let totalBytes = 0;
        let recorderStopped = false;
        let heardSpeech = false;
        let followupExpired = false;
        const startedAtMs = Date.now();

        const stopRecordingCleanly = () => {
          if (recorderStopped) return;
          recorderStopped = true;
          if (activeRecorder.state !== 'inactive') {
            try {
              activeRecorder.stop();
            } catch {
              // ignore stop race
            }
          }
        };

        const cancelFollowupTimer = () => {
          if (followupTimer) {
            clearTimeout(followupTimer);
            followupTimer = null;
          }
        };

        activeRecorder.ondataavailable = (ev) => {
          if (ev.data && ev.data.size > 0) {
            chunks.push(ev.data);
            totalBytes += ev.data.size;
            if (totalBytes >= SERVER_STT_MAX_RAW_BYTES) {
              stopRecordingCleanly();
            }
          }
        };

        activeRecorder.onerror = (ev) => {
          if (stopped || aborted) return;
          cleanupMedia();
          recorder = null;
          const errMsg = ev.error?.message || 'Microphone recorder error during capture.';
          const payload = toStructuredVoiceError(new Error(errMsg), errMsg);
          params.onError(payload.message, payload);
          params.onFinish();
        };

        activeRecorder.onstop = () => {
          cleanupMedia();
          recorder = null;
          if (stopped || aborted) {
            return;
          }

          if (followupExpired && !heardSpeech) {
            finishWithIdle(IDLE_WAKE_STATUS_MESSAGE);
            return;
          }

          const runtimePerms = params.getPermissions
            ? checkVoicePrivacyPermissions(params.getPermissions(), {
                requireExternalWebServices: true,
              })
            : null;
          if (runtimePerms) {
            params.onError(runtimePerms.message, runtimePerms);
            params.onFinish();
            return;
          }

          void (async () => {
            try {
              const actualMime = (activeRecorder.mimeType || mimeType || 'audio/webm').trim();
              const recordedBlob = new Blob(chunks, { type: actualMime });
              const arrayBuf = await recordedBlob.arrayBuffer();
              if (stopped || aborted) return;

              const bytes = new Uint8Array(arrayBuf);
              if (bytes.byteLength === 0) {
                finishWithIdle(
                  isFollowupTurn ? IDLE_WAKE_STATUS_MESSAGE : 'No speech detected.',
                );
                return;
              }
              if (bytes.byteLength > SERVER_STT_MAX_RAW_BYTES) {
                const errPayload: StructuredErrorPayload = {
                  code: ErrorCodes.VALIDATION_ERROR,
                  category: 'validation',
                  statusCode: 413,
                  message: 'Recorded audio exceeds the 12 MB server transcription limit.',
                  retryable: true,
                };
                params.onError(errPayload.message, errPayload);
                params.onFinish();
                return;
              }

              const audioBase64 = uint8ArrayToBase64(bytes);
              if (audioBase64.length < 4) {
                finishWithIdle(
                  isFollowupTurn ? IDLE_WAKE_STATUS_MESSAGE : 'No speech detected.',
                );
                return;
              }
              if (audioBase64.length > SERVER_STT_MAX_BASE64_CHARS) {
                const errPayload: StructuredErrorPayload = {
                  code: ErrorCodes.VALIDATION_ERROR,
                  category: 'validation',
                  statusCode: 413,
                  message: 'Encoded audio exceeds the 12 MB server transcription limit.',
                  retryable: true,
                };
                params.onError(errPayload.message, errPayload);
                params.onFinish();
                return;
              }

              const durationSeconds = Math.max(
                0.1,
                Number(((Date.now() - startedAtMs) / 1000).toFixed(2)),
              );
              params.onStateChange(
                VoiceStates.PROCESSING,
                `${prefix}Transcribing via server STT…`,
              );

              const sttFn = deps.transcribeSpeech ?? mjApi.transcribeSpeech;
              const sttResult = await sttFn(
                {
                  audioBase64,
                  filename: `voice.${extensionForAudioMimeType(actualMime)}`,
                  mimeType: actualMime,
                  languageMode: params.languageMode,
                  durationSeconds,
                },
                uploadAbort.signal,
              );
              if (stopped || aborted) return;

              const transcript = sttResult.text?.trim() ?? '';
              if (!transcript) {
                finishWithIdle(
                  isFollowupTurn ? IDLE_WAKE_STATUS_MESSAGE : 'No clear speech detected.',
                );
                return;
              }

              params.onTranscriptPreview(transcript);
              params.onStateChange(
                VoiceStates.PROCESSING,
                'Thinking via free AI provider…',
              );

              const replyText = await params.onSubmitTranscript(transcript);
              if (stopped || aborted) return;

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
                isStopped: () => stopped || aborted || bargeInTriggered,
                bargeIn: {
                  enabled: true,
                  threshold: params.bargeInThreshold ?? DEFAULT_BARGE_IN_PCM16_THRESHOLD,
                  canListen: canContinueVoice,
                  onAudioLevel: params.onAudioLevel,
                  deps: deps.bargeInDeps,
                  onBargeIn: () => {
                    speaking = false;
                    clearBargeInSpeechHandler = null;
                    if (canContinueVoice()) {
                      startCaptureTurn(false);
                    } else {
                      finishWithIdle('Ready');
                    }
                  },
                },
                onFinish: () => {
                  speaking = false;
                  clearBargeInSpeechHandler = null;
                  if (stopped || aborted || bargeInTriggered) return;
                  if (autoListenEnabled && canContinueVoice()) {
                    startCaptureTurn(true);
                  } else {
                    finishWithIdle('Ready');
                  }
                },
              });
            } catch (err) {
              speaking = false;
              if (stopped || aborted || (err instanceof Error && err.name === 'AbortError')) {
                return;
              }
              const payload = toStructuredVoiceError(err, 'Server speech transcription failed.');
              params.onError(payload.message, payload);
              params.onFinish();
            }
          })();
        };

        if (isFollowupTurn) {
          followupTimer = setTimeout(() => {
            if (stopped || aborted || heardSpeech) return;
            followupExpired = true;
            stopRecordingCleanly();
          }, followupMs);
        }

        const maxMs = Math.max(
          500,
          Math.min(SERVER_STT_MAX_RECORDING_MS, deps.maxDurationMs ?? SERVER_STT_MAX_RECORDING_MS),
        );
        maxDurationTimer = setTimeout(() => {
          stopRecordingCleanly();
        }, maxMs);

        const Ctx =
          deps.createAudioContext !== undefined
            ? deps.createAudioContext
            : () => {
                if (typeof window === 'undefined') return null;
                const AudioCtx =
                  window.AudioContext ??
                  (window as unknown as { webkitAudioContext?: typeof AudioContext })
                    .webkitAudioContext;
                return AudioCtx ? new AudioCtx() : null;
              };

        const ctx = typeof Ctx === 'function' ? Ctx() : Ctx;
        if (ctx) {
          try {
            audioCtx = ctx;
            const source = ctx.createMediaStreamSource(stream);
            const analyser = ctx.createAnalyser();
            analyser.fftSize = 1024;
            source.connect(analyser);
            const samples = new Uint8Array(analyser.fftSize);
            const threshold = deps.silenceThresholdRms ?? 0.018;
            const silenceLimitMs = deps.silenceDurationMs ?? 1600;
            const minSpeechMs = deps.minSpeechBeforeSilenceMs ?? 700;
            let silenceStartedAt: number | null = null;

            silenceTimer = setInterval(() => {
              if (stopped || aborted || recorderStopped) return;
              analyser.getByteTimeDomainData(samples);
              const pcm16Rms = uint8SamplesToPcm16Rms(samples);
              const rms = pcm16Rms / 32768;
              params.onAudioLevel?.(Math.min(1, rms * 4));

              if (rms >= threshold) {
                if (!heardSpeech) {
                  heardSpeech = true;
                  cancelFollowupTimer();
                }
                silenceStartedAt = null;
              } else if (heardSpeech && Date.now() - startedAtMs >= minSpeechMs) {
                if (silenceStartedAt === null) {
                  silenceStartedAt = Date.now();
                } else if (Date.now() - silenceStartedAt >= silenceLimitMs) {
                  stopRecordingCleanly();
                }
              }
            }, 100);
          } catch {
            // AudioContext silence analysis unavailable; rely on max/followup timer or Stop button.
          }
        }

        activeRecorder.start(250);
        params.onStateChange(
          VoiceStates.LISTENING,
          isFollowupTurn
            ? `${prefix}Listening for follow-up (${followupSecs}s)… Speak now`
            : `${prefix}Recording mic for server STT (up to 15s)…`,
        );
      } catch (err) {
        cleanupMedia();
        recorder = null;
        if (stopped || aborted) return;
        const payload = toStructuredVoiceError(err, 'Could not start microphone recording.');
        params.onError(payload.message, payload);
        params.onFinish();
      }
    })();
  };

  startCaptureTurn(Boolean(params.isFollowup));

  return {
    stop: () => {
      if (stopped) return;
      stopped = true;
      aborted = true;
      speaking = false;
      clearBargeInSpeechHandler?.();
      clearBargeInSpeechHandler = null;
      uploadAbort.abort();
      if (recorder && recorder.state !== 'inactive') {
        try {
          recorder.stop();
        } catch {
          // ignore stop error
        }
      }
      recorder = null;
      cleanupMedia();
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
        startCaptureTurn(false);
        return;
      }
      speaking = false;
      stopped = true;
      aborted = true;
      finishWithIdle(activeTurnIsFollowup ? IDLE_WAKE_STATUS_MESSAGE : 'Ready');
    },
  };
}

/**
 * Coordinates free voice fallback: tries Web Speech first (unless already unavailable), transitions ONCE
 * to Server STT (`MediaRecorder` -> `POST /api/voice/stt`) on `network`, `service-not-allowed`, or missing
 * `SpeechRecognition`, and prevents retry loops back into failing Web Speech.
 */
export function startResilientFreeVoiceSession(
  params: {
    languageMode: LanguageMode;
    volume: number;
    speakingRate: number;
    voiceOutputEnabled: boolean;
    autoListen?: boolean;
    followupListenSeconds?: number;
    followupTimeoutMs?: number;
    bargeInThreshold?: number;
    preferServerStt?: boolean;
    initialNotice?: string;
    getPermissions: () => VoicePrivacySubset;
    onNotice: (notice: string) => void;
    onUseServerSttFallback?: (reason: WebSpeechUnavailableReason) => void;
    onAudioLevel?: (level: number) => void;
    onStateChange: (state: VoiceState, detail: string) => void;
    onTranscriptPreview: (text: string) => void;
    onSubmitTranscript: (text: string) => Promise<string>;
    onFinish: () => void;
    onError: (msg: string, payload?: StructuredErrorPayload) => void;
  },
  deps?: {
    startWebSpeech?: typeof startFreeBrowserVoiceSession;
    startServerStt?: typeof startServerSttVoiceSession;
    serverSttDeps?: ServerSttVoiceDeps;
    bargeInDeps?: BargeInMonitorDeps;
  },
): FreeBrowserVoiceController {
  const permErr = checkVoicePrivacyPermissions(params.getPermissions(), {
    requireExternalWebServices: Boolean(params.preferServerStt),
  });
  if (permErr) {
    params.onError(permErr.message, permErr);
    params.onFinish();
    return { stop: () => {}, interrupt: () => {} };
  }

  let stopped = false;
  let switchedToServerStt = false;
  let activeController: FreeBrowserVoiceController | null = null;
  const startWeb = deps?.startWebSpeech ?? startFreeBrowserVoiceSession;
  const startServer = deps?.startServerStt ?? startServerSttVoiceSession;

  const launchServerStt = (notice?: string, isFollowup = false) => {
    if (stopped) return;
    const serverPermErr = checkVoicePrivacyPermissions(params.getPermissions(), {
      requireExternalWebServices: true,
    });
    if (serverPermErr) {
      params.onError(serverPermErr.message, serverPermErr);
      params.onFinish();
      return;
    }
    if (notice) {
      params.onNotice(notice);
    }
    const mergedServerDeps: ServerSttVoiceDeps = {
      ...(deps?.serverSttDeps ?? {}),
      ...(params.followupTimeoutMs ? { followupTimeoutMs: params.followupTimeoutMs } : {}),
      ...(deps?.bargeInDeps && !deps?.serverSttDeps?.bargeInDeps
        ? { bargeInDeps: deps.bargeInDeps }
        : {}),
    };
    activeController = startServer(
      {
        languageMode: params.languageMode,
        volume: params.volume,
        speakingRate: params.speakingRate,
        voiceOutputEnabled: params.voiceOutputEnabled,
        autoListen: params.autoListen,
        followupListenSeconds: params.followupListenSeconds,
        bargeInThreshold: params.bargeInThreshold,
        isFollowup,
        getPermissions: params.getPermissions,
        statusNotice: notice,
        onAudioLevel: params.onAudioLevel,
        onStateChange: params.onStateChange,
        onTranscriptPreview: params.onTranscriptPreview,
        onSubmitTranscript: params.onSubmitTranscript,
        onFinish: () => {
          activeController = null;
          params.onFinish();
        },
        onError: params.onError,
      },
      mergedServerDeps,
    );
  };

  const sttFallbackNotice = params.initialNotice
    ? `${params.initialNotice} · ${SERVER_STT_FALLBACK_NOTICE}`
    : SERVER_STT_FALLBACK_NOTICE;

  if (params.preferServerStt) {
    switchedToServerStt = true;
    launchServerStt(sttFallbackNotice, false);
  } else {
    const webCtrl = startWeb({
      languageMode: params.languageMode,
      volume: params.volume,
      speakingRate: params.speakingRate,
      voiceOutputEnabled: params.voiceOutputEnabled,
      autoListen: params.autoListen,
      followupListenSeconds: params.followupListenSeconds,
      followupTimeoutMs: params.followupTimeoutMs,
      bargeInThreshold: params.bargeInThreshold,
      getPermissions: params.getPermissions,
      bargeInDeps: deps?.bargeInDeps,
      onAudioLevel: params.onAudioLevel,
      ...(params.initialNotice ? { statusPrefix: params.initialNotice } : {}),
      onStateChange: params.onStateChange,
      onTranscriptPreview: params.onTranscriptPreview,
      onSubmitTranscript: params.onSubmitTranscript,
      onFinish: () => {
        if (!switchedToServerStt) {
          activeController = null;
          params.onFinish();
        }
      },
      onErrorMessage: (msg) => {
        params.onError(msg, {
          code: ErrorCodes.VOICE_SERVICE_UNAVAILABLE,
          category: 'voice',
          statusCode: 503,
          message: msg,
          retryable: true,
        });
      },
      onUnavailable: (reason, _detail, ctx) => {
        if (stopped || switchedToServerStt) return;
        switchedToServerStt = true;
        params.onUseServerSttFallback?.(reason);
        launchServerStt(sttFallbackNotice, Boolean(ctx?.isFollowup));
      },
    });
    if (stopped) {
      webCtrl.stop();
    } else if (!switchedToServerStt) {
      activeController = webCtrl;
    }
  }

  return {
    stop: () => {
      stopped = true;
      activeController?.stop();
      activeController = null;
    },
    interrupt: () => {
      activeController?.interrupt();
    },
  };
}
