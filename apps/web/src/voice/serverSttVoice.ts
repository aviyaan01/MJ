import {
  ErrorCodes,
  VoiceStates,
  type LanguageMode,
  type PermissionsStateDTO,
  type StructuredErrorPayload,
  type VoiceState,
} from '@mj/shared';
import {
  ApiClientError,
  mjApi,
  type SttTranscribeRequest,
  type SttTranscribeResponse,
} from '../api/client.js';
import {
  speakVoiceReply,
  startFreeBrowserVoiceSession,
  type FreeBrowserVoiceController,
  type WebSpeechUnavailableReason,
} from './freeBrowserVoice.js';

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
  silenceDurationMs?: number;
  minSpeechBeforeSilenceMs?: number;
  silenceThresholdRms?: number;
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
 * and speaks the assistant reply.
 */
export function startServerSttVoiceSession(
  params: {
    languageMode: LanguageMode;
    volume: number;
    speakingRate: number;
    voiceOutputEnabled: boolean;
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
  let stream: MediaStream | null = null;
  let recorder: MediaRecorderLike | null = null;
  let audioCtx: AudioContext | null = null;
  let silenceTimer: ReturnType<typeof setInterval> | null = null;
  let maxDurationTimer: ReturnType<typeof setTimeout> | null = null;
  const uploadAbort = new AbortController();

  const cleanupMedia = () => {
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

  const prefix = params.statusNotice ? `${params.statusNotice} · ` : '';

  void (async () => {
    try {
      params.onStateChange(
        VoiceStates.REQUESTING_PERMISSION,
        `${prefix}Requesting microphone permission…`,
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
        const errMsg = ev.error?.message || 'Microphone recorder error during capture.';
        const payload = toStructuredVoiceError(new Error(errMsg), errMsg);
        params.onError(payload.message, payload);
        params.onFinish();
      };

      activeRecorder.onstop = () => {
        cleanupMedia();
        if (stopped || aborted) {
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
              params.onStateChange(VoiceStates.IDLE, 'No speech detected.');
              params.onFinish();
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
              params.onStateChange(VoiceStates.IDLE, 'No speech detected.');
              params.onFinish();
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
              params.onStateChange(VoiceStates.IDLE, 'No clear speech detected.');
              params.onFinish();
              return;
            }

            params.onTranscriptPreview(transcript);
            params.onStateChange(
              VoiceStates.PROCESSING,
              'Thinking via free AI provider…',
            );

            const replyText = await params.onSubmitTranscript(transcript);
            if (stopped || aborted) return;

            speakVoiceReply(replyText, {
              volume: params.volume,
              speakingRate: params.speakingRate,
              languageMode: params.languageMode,
              voiceOutputEnabled: params.voiceOutputEnabled,
              onStateChange: params.onStateChange,
              onFinish: params.onFinish,
              isStopped: () => stopped || aborted,
            });
          } catch (err) {
            if (stopped || aborted || (err instanceof Error && err.name === 'AbortError')) {
              return;
            }
            const payload = toStructuredVoiceError(err, 'Server speech transcription failed.');
            params.onError(payload.message, payload);
            params.onFinish();
          }
        })();
      };

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
          let heardSpeech = false;
          let silenceStartedAt: number | null = null;

          silenceTimer = setInterval(() => {
            if (stopped || aborted || recorderStopped) return;
            analyser.getByteTimeDomainData(samples);
            let sumSq = 0;
            for (let i = 0; i < samples.length; i++) {
              const normalized = (samples[i]! - 128) / 128;
              sumSq += normalized * normalized;
            }
            const rms = Math.sqrt(sumSq / samples.length);
            params.onAudioLevel?.(Math.min(1, rms * 4));

            if (rms >= threshold) {
              heardSpeech = true;
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
          // AudioContext silence analysis unavailable; rely on max 15s timer or Stop button.
        }
      }

      activeRecorder.start(250);
      params.onStateChange(
        VoiceStates.LISTENING,
        `${prefix}Recording mic for server STT (up to 15s)…`,
      );
    } catch (err) {
      cleanupMedia();
      if (stopped || aborted) return;
      const payload = toStructuredVoiceError(err, 'Could not start microphone recording.');
      params.onError(payload.message, payload);
      params.onFinish();
    }
  })();

  return {
    stop: () => {
      stopped = true;
      aborted = true;
      uploadAbort.abort();
      if (recorder && recorder.state !== 'inactive') {
        try {
          recorder.stop();
        } catch {
          // ignore stop error
        }
      }
      cleanupMedia();
      if (typeof window !== 'undefined' && 'speechSynthesis' in window) {
        window.speechSynthesis.cancel();
      }
      params.onStateChange(VoiceStates.IDLE, 'Ready');
      params.onFinish();
    },
    interrupt: () => {
      if (typeof window !== 'undefined' && 'speechSynthesis' in window) {
        window.speechSynthesis.cancel();
      }
      params.onStateChange(VoiceStates.IDLE, 'Ready');
      params.onFinish();
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

  const launchServerStt = (notice?: string) => {
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
    activeController = startServer(
      {
        languageMode: params.languageMode,
        volume: params.volume,
        speakingRate: params.speakingRate,
        voiceOutputEnabled: params.voiceOutputEnabled,
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
      deps?.serverSttDeps,
    );
  };

  const sttFallbackNotice = params.initialNotice
    ? `${params.initialNotice} · ${SERVER_STT_FALLBACK_NOTICE}`
    : SERVER_STT_FALLBACK_NOTICE;

  if (params.preferServerStt) {
    switchedToServerStt = true;
    launchServerStt(sttFallbackNotice);
  } else {
    const webCtrl = startWeb({
      languageMode: params.languageMode,
      volume: params.volume,
      speakingRate: params.speakingRate,
      voiceOutputEnabled: params.voiceOutputEnabled,
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
      onUnavailable: (reason) => {
        if (stopped || switchedToServerStt) return;
        switchedToServerStt = true;
        params.onUseServerSttFallback?.(reason);
        launchServerStt(sttFallbackNotice);
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
