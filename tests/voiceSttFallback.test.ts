import { afterEach, describe, expect, it, vi } from 'vitest';
import { ErrorCodes, VoiceStates, type StructuredErrorPayload } from '@mj/shared';
import { buildServer, type MjServerContext } from '../apps/server/src/app.js';
import { loadServerConfig } from '../apps/server/src/config.js';
import { VoiceHealthTracker } from '../apps/server/src/routes/health.js';
import { createDefaultVoiceGateway } from '../apps/server/src/routes/voice.js';
import { ApiClientError, mjApi } from '../apps/web/src/api/client.js';
import { nextRepeatedErrorState, REPEATED_ERROR_HINT } from '../apps/web/src/components/VoiceStateBar.js';
import { startFreeBrowserVoiceSession } from '../apps/web/src/voice/freeBrowserVoice.js';
import {
  SERVER_STT_FALLBACK_NOTICE,
  startResilientFreeVoiceSession,
  startServerSttVoiceSession,
  type MediaRecorderLike,
} from '../apps/web/src/voice/serverSttVoice.js';

function createMockStream(): { stream: MediaStream; stopSpy: ReturnType<typeof vi.fn> } {
  const stopSpy = vi.fn();
  const stream = {
    getTracks: () => [{ stop: stopSpy }],
  } as unknown as MediaStream;
  return { stream, stopSpy };
}

function createMockRecorder(audioPayload = new Uint8Array([1, 2, 3, 4, 5, 6])): MediaRecorderLike {
  const rec: MediaRecorderLike = {
    state: 'inactive',
    mimeType: 'audio/webm;codecs=opus',
    ondataavailable: null,
    onstop: null,
    onerror: null,
    start: () => {
      rec.state = 'recording';
      setTimeout(() => {
        if (rec.state === 'recording') {
          rec.ondataavailable?.({ data: new Blob([audioPayload], { type: 'audio/webm' }) });
        }
      }, 15);
    },
    stop: () => {
      if (rec.state === 'inactive') return;
      rec.state = 'inactive';
      setTimeout(() => {
        rec.onstop?.();
      }, 10);
    },
  };
  return rec;
}

describe('Home Voice Web Speech Unavailable & Server STT Fallback', () => {
  const originalWindow = (globalThis as { window?: unknown }).window;
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    (globalThis as { window?: unknown }).window = originalWindow;
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it('treats Web Speech network, service-not-allowed, and missing SpeechRecognition as unavailable without raw error', () => {
    // 1. Missing SpeechRecognition constructor
    (globalThis as { window?: unknown }).window = {};
    const unavailableReasons: string[] = [];
    const errorMessages: string[] = [];
    const finishes = vi.fn();

    startFreeBrowserVoiceSession({
      languageMode: 'auto',
      volume: 0.9,
      speakingRate: 1.0,
      voiceOutputEnabled: true,
      onStateChange: () => {},
      onTranscriptPreview: () => {},
      onSubmitTranscript: async () => '',
      onFinish: finishes,
      onErrorMessage: (m) => errorMessages.push(m),
      onUnavailable: (reason) => unavailableReasons.push(reason),
    });
    expect(unavailableReasons).toEqual(['unsupported']);
    expect(errorMessages).toHaveLength(0);
    expect(finishes).not.toHaveBeenCalled();

    // 2. recognition.onerror('network') & ('service-not-allowed') trigger onUnavailable, not raw onErrorMessage
    for (const errKind of ['network', 'service-not-allowed'] as const) {
      let instance: { onerror?: ((ev: { error?: string }) => void) | null; abort: () => void } | null =
        null;
      class FakeSpeechRecognition {
        lang = 'en-US';
        interimResults = true;
        continuous = false;
        maxAlternatives = 1;
        onstart = null;
        onresult = null;
        onerror: ((ev: { error?: string }) => void) | null = null;
        onend = null;
        start() {
          instance = this;
        }
        stop() {}
        abort() {}
      }
      (globalThis as { window?: unknown }).window = { SpeechRecognition: FakeSpeechRecognition };

      const reasons: string[] = [];
      const errors: string[] = [];
      startFreeBrowserVoiceSession({
        languageMode: 'en',
        volume: 0.9,
        speakingRate: 1.0,
        voiceOutputEnabled: false,
        onStateChange: () => {},
        onTranscriptPreview: () => {},
        onSubmitTranscript: async () => '',
        onFinish: () => {},
        onErrorMessage: (m) => errors.push(m),
        onUnavailable: (r) => reasons.push(r),
      });

      instance!.onerror?.({ error: errKind });
      expect(reasons).toEqual([errKind]);
      expect(errors).toHaveLength(0);
    }
  });

  it('network error triggers server STT fallback ONCE, submits transcript, speaks reply, and never loops', async () => {
    const speakSpy = vi.fn();
    let activeRecError: ((ev: { error?: string }) => void) | null = null;
    class FakeSpeechRecognition {
      lang = 'en-US';
      interimResults = true;
      continuous = false;
      maxAlternatives = 1;
      onstart = null;
      onresult = null;
      onerror: ((ev: { error?: string }) => void) | null = null;
      onend = null;
      start() {
        activeRecError = this.onerror;
      }
      stop() {}
      abort() {}
    }

    (globalThis as { window?: unknown }).window = {
      SpeechRecognition: FakeSpeechRecognition,
      SpeechSynthesisUtterance: class {
        lang = '';
        volume = 1;
        rate = 1;
        onend: (() => void) | null = null;
        onerror: (() => void) | null = null;
        constructor(public text: string) {}
      },
      speechSynthesis: {
        cancel: vi.fn(),
        getVoices: () => [],
        speak: (u: { onend?: (() => void) | null }) => {
          speakSpy(u);
          u.onend?.();
        },
      },
    };

    const { stream, stopSpy } = createMockStream();
    const notices: string[] = [];
    const errors: Array<{ msg: string; payload?: StructuredErrorPayload }> = [];
    const transcriptsSubmitted: string[] = [];
    const webStartSpy = vi.fn(startFreeBrowserVoiceSession);
    const sttSpy = vi.fn(async () => ({
      text: 'Hello MJ from server STT',
      language: 'en',
      modelUsed: 'gemini-2.5-flash',
      isFree: true,
    }));

    const finished = new Promise<void>((resolve) => {
      startResilientFreeVoiceSession(
        {
          languageMode: 'auto',
          volume: 0.9,
          speakingRate: 1.0,
          voiceOutputEnabled: true,
          getPermissions: () => ({
            microphoneAccess: true,
            voiceSessionAccess: true,
            externalWebServices: true,
          }),
          onNotice: (n) => notices.push(n),
          onStateChange: () => {},
          onTranscriptPreview: () => {},
          onSubmitTranscript: async (text) => {
            transcriptsSubmitted.push(text);
            return 'Server STT reply ready';
          },
          onFinish: () => resolve(),
          onError: (msg, payload) => errors.push({ msg, payload }),
        },
        {
          startWebSpeech: webStartSpy,
          serverSttDeps: {
            getUserMedia: async () => stream,
            createMediaRecorder: () => createMockRecorder(),
            createAudioContext: () => null,
            transcribeSpeech: sttSpy,
            maxDurationMs: 600,
          },
        },
      );
    });

    // Simulate Chromium / Edge Web Speech cloud 'network' error
    activeRecError?.({ error: 'network' });
    await finished;

    expect(webStartSpy).toHaveBeenCalledTimes(1);
    expect(notices).toEqual([SERVER_STT_FALLBACK_NOTICE]);
    expect(errors).toHaveLength(0);
    expect(sttSpy).toHaveBeenCalledTimes(1);
    expect(transcriptsSubmitted).toEqual(['Hello MJ from server STT']);
    expect(speakSpy).toHaveBeenCalledTimes(1);
    expect(stopSpy).toHaveBeenCalled();

    // Retry with preferServerStt=true runs Server STT directly without looping back into Web Speech
    await new Promise<void>((resolve) => {
      startResilientFreeVoiceSession(
        {
          languageMode: 'auto',
          volume: 0.9,
          speakingRate: 1.0,
          voiceOutputEnabled: false,
          preferServerStt: true,
          getPermissions: () => ({
            microphoneAccess: true,
            voiceSessionAccess: true,
            externalWebServices: true,
          }),
          onNotice: (n) => notices.push(n),
          onStateChange: () => {},
          onTranscriptPreview: () => {},
          onSubmitTranscript: async (text) => {
            transcriptsSubmitted.push(text);
            return 'Retry reply ok';
          },
          onFinish: () => resolve(),
          onError: (msg, payload) => errors.push({ msg, payload }),
        },
        {
          startWebSpeech: webStartSpy,
          serverSttDeps: {
            getUserMedia: async () => stream,
            createMediaRecorder: () => createMockRecorder(),
            createAudioContext: () => null,
            transcribeSpeech: sttSpy,
            maxDurationMs: 600,
          },
        },
      );
    });
    expect(webStartSpy).toHaveBeenCalledTimes(1);
    expect(sttSpy).toHaveBeenCalledTimes(2);
    expect(errors).toHaveLength(0);
  });

  it('surfaces a clear error with the real backend reason when server STT fallback also fails', async () => {
    let activeRecError: ((ev: { error?: string }) => void) | null = null;
    class FakeSpeechRecognition {
      lang = 'en-US';
      interimResults = true;
      continuous = false;
      maxAlternatives = 1;
      onstart = null;
      onresult = null;
      onerror: ((ev: { error?: string }) => void) | null = null;
      onend = null;
      start() {
        activeRecError = this.onerror;
      }
      stop() {}
      abort() {}
    }
    (globalThis as { window?: unknown }).window = { SpeechRecognition: FakeSpeechRecognition };

    const { stream, stopSpy } = createMockStream();
    const notices: string[] = [];
    const errors: Array<{ msg: string; payload?: StructuredErrorPayload }> = [];

    const finished = new Promise<void>((resolve) => {
      startResilientFreeVoiceSession(
        {
          languageMode: 'auto',
          volume: 0.9,
          speakingRate: 1.0,
          voiceOutputEnabled: false,
          getPermissions: () => ({
            microphoneAccess: true,
            voiceSessionAccess: true,
            externalWebServices: true,
          }),
          onNotice: (n) => notices.push(n),
          onStateChange: () => {},
          onTranscriptPreview: () => {},
          onSubmitTranscript: async () => 'unreachable',
          onFinish: () => resolve(),
          onError: (msg, payload) => errors.push({ msg, payload }),
        },
        {
          serverSttDeps: {
            getUserMedia: async () => stream,
            createMediaRecorder: () => createMockRecorder(),
            createAudioContext: () => null,
            transcribeSpeech: async () => {
              throw new ApiClientError({
                code: ErrorCodes.INVALID_API_KEY,
                category: 'api',
                statusCode: 502,
                message: 'Gemini API key invalid, check Google AI Studio.',
                retryable: false,
              });
            },
            maxDurationMs: 500,
          },
        },
      );
    });

    activeRecError?.({ error: 'network' });
    await finished;

    expect(notices).toEqual([SERVER_STT_FALLBACK_NOTICE]);
    expect(errors).toHaveLength(1);
    expect(errors[0]!.msg).toBe('Gemini API key invalid, check Google AI Studio.');
    expect(errors[0]!.payload?.code).toBe(ErrorCodes.INVALID_API_KEY);
    expect(stopSpy).toHaveBeenCalled();
  });

  it('blocks mic capture and server STT upload whenever microphoneAccess, voiceSessionAccess, or externalWebServices is OFF', async () => {
    const cases: Array<{
      name: string;
      perms: { microphoneAccess: boolean; voiceSessionAccess: boolean; externalWebServices: boolean };
      preferServerStt: boolean;
    }> = [
      {
        name: 'microphoneAccess OFF',
        perms: { microphoneAccess: false, voiceSessionAccess: true, externalWebServices: true },
        preferServerStt: false,
      },
      {
        name: 'voiceSessionAccess OFF',
        perms: { microphoneAccess: true, voiceSessionAccess: false, externalWebServices: true },
        preferServerStt: false,
      },
      {
        name: 'externalWebServices OFF on server STT',
        perms: { microphoneAccess: true, voiceSessionAccess: true, externalWebServices: false },
        preferServerStt: true,
      },
    ];

    for (const tc of cases) {
      const getUserMediaSpy = vi.fn(async () => createMockStream().stream);
      const sttSpy = vi.fn(async () => ({ text: 'should never run' }));
      const errors: Array<{ msg: string; payload?: StructuredErrorPayload }> = [];
      const onFinish = vi.fn();

      startResilientFreeVoiceSession(
        {
          languageMode: 'auto',
          volume: 0.9,
          speakingRate: 1.0,
          voiceOutputEnabled: false,
          preferServerStt: tc.preferServerStt,
          getPermissions: () => tc.perms,
          onNotice: () => {},
          onStateChange: () => {},
          onTranscriptPreview: () => {},
          onSubmitTranscript: async () => '',
          onFinish,
          onError: (msg, payload) => errors.push({ msg, payload }),
        },
        {
          serverSttDeps: {
            getUserMedia: getUserMediaSpy,
            createMediaRecorder: () => createMockRecorder(),
            transcribeSpeech: sttSpy,
            maxDurationMs: 500,
          },
        },
      );

      expect(getUserMediaSpy, tc.name).not.toHaveBeenCalled();
      expect(sttSpy, tc.name).not.toHaveBeenCalled();
      expect(onFinish, tc.name).toHaveBeenCalledTimes(1);
      expect(errors[0]?.payload?.code, tc.name).toBe(ErrorCodes.PERMISSION_DENIED);
    }

    // Also test Web Speech failing with 'network' while externalWebServices is OFF -> blocks STT upload!
    let netErrorFn: ((ev: { error?: string }) => void) | null = null;
    class FakeSpeechRec {
      lang = 'en-US';
      interimResults = true;
      continuous = false;
      maxAlternatives = 1;
      onstart = null;
      onresult = null;
      onerror: ((ev: { error?: string }) => void) | null = null;
      onend = null;
      start() {
        netErrorFn = this.onerror;
      }
      stop() {}
      abort() {}
    }
    (globalThis as { window?: unknown }).window = { SpeechRecognition: FakeSpeechRec };

    const getUserMediaSpy = vi.fn(async () => createMockStream().stream);
    const sttSpy = vi.fn(async () => ({ text: 'blocked' }));
    const errors: Array<{ msg: string; payload?: StructuredErrorPayload }> = [];

    startResilientFreeVoiceSession(
      {
        languageMode: 'auto',
        volume: 0.9,
        speakingRate: 1.0,
        voiceOutputEnabled: false,
        getPermissions: () => ({
          microphoneAccess: true,
          voiceSessionAccess: true,
          externalWebServices: false,
        }),
        onNotice: () => {},
        onStateChange: () => {},
        onTranscriptPreview: () => {},
        onSubmitTranscript: async () => '',
        onFinish: () => {},
        onError: (msg, payload) => errors.push({ msg, payload }),
      },
      {
        serverSttDeps: {
          getUserMedia: getUserMediaSpy,
          createMediaRecorder: () => createMockRecorder(),
          transcribeSpeech: sttSpy,
          maxDurationMs: 500,
        },
      },
    );

    netErrorFn?.({ error: 'network' });
    expect(getUserMediaSpy).not.toHaveBeenCalled();
    expect(sttSpy).not.toHaveBeenCalled();
    expect(errors[0]?.payload?.code).toBe(ErrorCodes.PERMISSION_DENIED);
  });

  it('mjApi.transcribeSpeech posts to /api/voice/stt with SttBodySchema fields and enforces the 12 MB limit', async () => {
    const fetchMock = vi.fn(async () =>
      new Response(
        JSON.stringify({
          text: 'Transcribed audio',
          language: 'en',
          modelUsed: 'whisper-large-v3-turbo',
          isFree: true,
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      ),
    );
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const result = await mjApi.transcribeSpeech({
      audioBase64: 'YWJjZA==',
      filename: 'voice.webm',
      mimeType: 'audio/webm;codecs=opus',
      languageMode: 'auto',
      durationSeconds: 3.4,
    });

    expect(result.text).toBe('Transcribed audio');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('/api/voice/stt');
    expect(init.method).toBe('POST');
    expect(init.credentials).toBe('include');
    expect(JSON.parse(String(init.body))).toEqual({
      audioBase64: 'YWJjZA==',
      filename: 'voice.webm',
      mimeType: 'audio/webm;codecs=opus',
      languageMode: 'auto',
      durationSeconds: 3.4,
    });

    // Reject oversized > 12 MB payload before hitting network
    const oversizedBase64 = 'A'.repeat(12_000_001);
    await expect(
      mjApi.transcribeSpeech({ audioBase64: oversizedBase64 }),
    ).rejects.toMatchObject({
      payload: {
        code: ErrorCodes.VALIDATION_ERROR,
        statusCode: 413,
      },
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);

    // Server STT voice session also surfaces IDLE cleanly without hitting STT if bytes empty
    const sttSpy = vi.fn();
    const stateSpy = vi.fn();
    const { stream } = createMockStream();
    await new Promise<void>((resolve) => {
      startServerSttVoiceSession(
        {
          languageMode: 'en',
          volume: 0.9,
          speakingRate: 1.0,
          voiceOutputEnabled: false,
          onStateChange: stateSpy,
          onTranscriptPreview: () => {},
          onSubmitTranscript: async () => '',
          onFinish: () => resolve(),
          onError: () => {},
        },
        {
          getUserMedia: async () => stream,
          createMediaRecorder: () => createMockRecorder(new Uint8Array(0)),
          createAudioContext: () => null,
          transcribeSpeech: sttSpy,
          maxDurationMs: 500,
        },
      );
    });
    expect(sttSpy).not.toHaveBeenCalled();
    expect(stateSpy).toHaveBeenCalledWith(VoiceStates.IDLE, 'No speech detected.');
  });

  it('logs sanitized Gemini Live fallbackReason, returns it in client-secret DTO, marks voiceEngine degraded for 10m, and generates repeated-error hints', async () => {
    // 1. Repeated same error triggers troubleshooting hint instead of endless retries
    const first = nextRepeatedErrorState(null, 0, {
      code: ErrorCodes.VOICE_SERVICE_UNAVAILABLE,
      message: 'Microphone stream failed',
    });
    expect(first.hint).toBeNull();
    expect(first.count).toBe(1);

    const second = nextRepeatedErrorState(first.signature, first.count, {
      code: ErrorCodes.VOICE_SERVICE_UNAVAILABLE,
      message: 'Microphone stream failed',
    });
    expect(second.count).toBe(2);
    expect(second.hint).toBe(REPEATED_ERROR_HINT);

    // 2. Gemini Live client-secret failure logs sanitized fallbackReason, returns it in DTO, and flips voiceEngine -> degraded for 10m
    let fakeNowMs = 1_750_000_000_000;
    const tracker = new VoiceHealthTracker(() => fakeNowMs);
    const leakedGemKey = 'AIzaSyFakeSecretKeyValue1234567890ABCDE';
    const warnLogs: unknown[] = [];

    const cfg = loadServerConfig({
      APP_ENV: 'test',
      FREE_ONLY_MODE: 'true',
      GEMINI_API_KEY: leakedGemKey,
      DATABASE_URL: ':memory:',
      AUTH_SECRET: 'test-signing-secret-must-be-at-least-32-bytes-long',
      APP_ACCESS_PASSCODE: 'mj-voice-health',
      CORS_ORIGIN: 'http://localhost:5173',
    });

    const failingGeminiGateway = createDefaultVoiceGateway(cfg, async () =>
      new Response(
        JSON.stringify({
          error: {
            message: `Invalid key ${leakedGemKey} at generativelanguage.googleapis.com`,
          },
        }),
        { status: 403, headers: { 'Content-Type': 'application/json' } },
      ),
    );

    const ctx = await buildServer({
      config: cfg,
      voiceGateway: failingGeminiGateway,
      voiceTracker: tracker,
    });
    try {
      ctx.app.log.warn = ((...args: unknown[]) => {
        warnLogs.push(args);
      }) as typeof ctx.app.log.warn;

      const loginRes = await ctx.app.inject({
        method: 'POST',
        url: '/api/auth/login',
        payload: { passcode: 'mj-voice-health' },
      });
      const cookie = String(loginRes.headers['set-cookie']).split(';')[0]!;

      for (const key of ['microphoneAccess', 'voiceSessionAccess', 'externalWebServices']) {
        await ctx.app.inject({
          method: 'PATCH',
          url: '/api/privacy/permissions',
          headers: { cookie },
          payload: { key, enabled: true },
        });
      }

      const secretRes = await ctx.app.inject({
        method: 'POST',
        url: '/api/voice/client-secret',
        headers: { cookie },
        payload: {},
      });
      expect(secretRes.statusCode).toBe(200);
      const secretBody = secretRes.json() as { protocol?: string; fallbackReason?: string };
      expect(secretBody.protocol).toBe('free-browser');
      expect(secretBody.fallbackReason).toBeTruthy();
      expect(secretBody.fallbackReason).not.toContain(leakedGemKey);
      expect(JSON.stringify(warnLogs)).toContain('fallbackReason');
      expect(JSON.stringify(warnLogs)).not.toContain(leakedGemKey);

      const degradedHealth = await ctx.app.inject({
        method: 'GET',
        url: '/api/health',
        headers: { cookie },
      });
      expect(degradedHealth.json().voiceEngine).toBe('degraded');

      // After >10 minutes without another failure, voiceEngine returns to 'ready'
      fakeNowMs += 10 * 60 * 1000 + 1000;
      const recoveredHealth = await ctx.app.inject({
        method: 'GET',
        url: '/api/health',
        headers: { cookie },
      });
      expect(recoveredHealth.json().voiceEngine).toBe('ready');

      // Voice usage failure marks 'degraded', followed by voice usage success recovering immediately to 'ready'
      await ctx.app.inject({
        method: 'POST',
        url: '/api/voice/usage',
        headers: { cookie },
        payload: {
          model: 'free-browser-voice',
          durationSeconds: 10,
          status: 'error',
          errorCode: 'WEBSOCKET_CONNECTION_FAILED',
        },
      });
      expect(
        (await ctx.app.inject({ method: 'GET', url: '/api/health', headers: { cookie } })).json()
          .voiceEngine,
      ).toBe('degraded');

      await ctx.app.inject({
        method: 'POST',
        url: '/api/voice/usage',
        headers: { cookie },
        payload: {
          model: 'free-browser-voice',
          durationSeconds: 20,
          status: 'success',
        },
      });
      expect(
        (await ctx.app.inject({ method: 'GET', url: '/api/health', headers: { cookie } })).json()
          .voiceEngine,
      ).toBe('ready');
    } finally {
      await ctx.app.close();
      ctx.dbHandle.close();
    }
  });
});
