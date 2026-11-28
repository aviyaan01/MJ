import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_AUTO_LISTEN,
  DEFAULT_BARGE_IN_PCM16_THRESHOLD,
  DEFAULT_FOLLOWUP_LISTEN_SECONDS,
  VoiceStates,
  type PublicSettingsDTO,
  type VoiceClientSecretDTO,
} from '@mj/shared';
import { MjVoiceService, buildGeminiLiveSetupPayload, computePcm16Rms } from '@mj/voice';
import { buildServer, type MjServerContext } from '../apps/server/src/app.js';
import { loadServerConfig } from '../apps/server/src/config.js';
import {
  IDLE_WAKE_STATUS_MESSAGE,
  startFreeBrowserVoiceSession,
} from '../apps/web/src/voice/freeBrowserVoice.js';
import {
  startResilientFreeVoiceSession,
  startServerSttVoiceSession,
  type MediaRecorderLike,
} from '../apps/web/src/voice/serverSttVoice.js';
import {
  WakeWordListener,
  canAutoStartWakeWordAtLaunch,
  matchWakePhrase,
} from '../apps/web/src/voice/wakeWordListener.js';

function createMockStream(): { stream: MediaStream; stopSpy: ReturnType<typeof vi.fn> } {
  const stopSpy = vi.fn();
  const stream = {
    getTracks: () => [{ stop: stopSpy }],
    getAudioTracks: () => [{ enabled: true, stop: stopSpy }],
  } as unknown as MediaStream;
  return { stream, stopSpy };
}

function createControllableAudioContext(getSampleByte: () => number): AudioContext {
  const analyser = {
    fftSize: 64,
    getByteTimeDomainData: (arr: Uint8Array) => {
      arr.fill(getSampleByte());
    },
    getFloatTimeDomainData: (arr: Float32Array) => {
      arr.fill(0);
    },
    connect: () => {},
  };
  return {
    state: 'running',
    sampleRate: 48000,
    currentTime: 0,
    destination: {},
    createMediaStreamSource: () => ({ connect: () => {}, disconnect: () => {} }),
    createAnalyser: () => analyser,
    createGain: () => ({
      gain: { value: 1, setTargetAtTime: () => {} },
      connect: () => {},
      disconnect: () => {},
    }),
    createScriptProcessor: () => ({
      onaudioprocess: null,
      connect: () => {},
      disconnect: () => {},
    }),
    close: async () => {},
    resume: async () => {},
  } as unknown as AudioContext;
}

describe('Auto-Listen Follow-Up, Barge-In, Gemini Live Resumption & Multilingual Wake Word', () => {
  const contexts: MjServerContext[] = [];
  const originalWindow = (globalThis as { window?: unknown }).window;
  const originalNavigator = (globalThis as { navigator?: unknown }).navigator;
  const originalWebSocket = (globalThis as { WebSocket?: unknown }).WebSocket;

  afterEach(async () => {
    vi.useRealTimers();
    (globalThis as { window?: unknown }).window = originalWindow;
    if (originalNavigator !== undefined) {
      Object.defineProperty(globalThis, 'navigator', {
        value: originalNavigator,
        configurable: true,
        writable: true,
      });
    }
    (globalThis as { WebSocket?: unknown }).WebSocket = originalWebSocket;
    vi.restoreAllMocks();
    while (contexts.length > 0) {
      const ctx = contexts.pop()!;
      await ctx.app.close();
      ctx.dbHandle.close();
    }
  });

  it('exposes voice.autoListen=true, voice.followupListenSeconds=7 (3-30), and bargeInThreshold=1400 with validation', async () => {
    const config = loadServerConfig({
      APP_ENV: 'test',
      DATABASE_URL: ':memory:',
      AUTH_SECRET: 'auto-listen-test-auth-secret-32-chars-min',
      SERVE_WEB_DIST: 'false',
    });
    const ctx = await buildServer({ config });
    contexts.push(ctx);

    const loginRes = await ctx.app.inject({ method: 'POST', url: '/api/auth/login', payload: {} });
    const cookie = String(loginRes.headers['set-cookie']).split(';')[0]!;

    const getRes = await ctx.app.inject({
      method: 'GET',
      url: '/api/settings',
      headers: { cookie },
    });
    expect(getRes.statusCode).toBe(200);
    const initial = getRes.json() as PublicSettingsDTO;
    expect(initial.voice.autoListen).toBe(DEFAULT_AUTO_LISTEN);
    expect(initial.voice.autoListen).toBe(true);
    expect(initial.voice.followupListenSeconds).toBe(DEFAULT_FOLLOWUP_LISTEN_SECONDS);
    expect(initial.voice.followupListenSeconds).toBe(7);
    expect(initial.voice.bargeInThreshold).toBe(DEFAULT_BARGE_IN_PCM16_THRESHOLD);
    expect(initial.voice.bargeInThreshold).toBe(1400);

    const updateRes = await ctx.app.inject({
      method: 'PATCH',
      url: '/api/settings',
      headers: { cookie },
      payload: {
        voice: {
          autoListen: false,
          followupListenSeconds: 15,
          bargeInThreshold: 2100,
        },
      },
    });
    expect(updateRes.statusCode).toBe(200);
    const updated = updateRes.json() as PublicSettingsDTO;
    expect(updated.voice.autoListen).toBe(false);
    expect(updated.voice.followupListenSeconds).toBe(15);
    expect(updated.voice.bargeInThreshold).toBe(2100);

    const invalidLow = await ctx.app.inject({
      method: 'PATCH',
      url: '/api/settings',
      headers: { cookie },
      payload: { voice: { followupListenSeconds: 2 } },
    });
    expect(invalidLow.statusCode).toBe(400);

    const invalidHigh = await ctx.app.inject({
      method: 'PATCH',
      url: '/api/settings',
      headers: { cookie },
      payload: { voice: { followupListenSeconds: 31 } },
    });
    expect(invalidHigh.statusCode).toBe(400);
  });

  it('reopens free browser mic for followupListenSeconds after TTS onEnd, expires to "Say Hey MJ to wake me", and cancels timer on speech', async () => {
    vi.useFakeTimers();

    interface FakeRec {
      lang: string;
      interimResults: boolean;
      continuous: boolean;
      maxAlternatives: number;
      onresult: ((ev: { resultIndex: number; results: ArrayLike<{ isFinal: boolean; 0?: { transcript?: string } }> }) => void) | null;
      onerror: ((ev: { error?: string }) => void) | null;
      onend: (() => void) | null;
      start: () => void;
      stop: ReturnType<typeof vi.fn>;
      abort: ReturnType<typeof vi.fn>;
    }

    const instances: FakeRec[] = [];
    let currentUtterance: { onend?: (() => void) | null } | null = null;
    const cancelTtsSpy = vi.fn();

    class FakeSpeechRecognition implements FakeRec {
      lang = 'en-US';
      interimResults = true;
      continuous = false;
      maxAlternatives = 1;
      onresult = null;
      onerror = null;
      onend = null;
      stop = vi.fn();
      abort = vi.fn();
      start() {
        instances.push(this);
      }
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
        cancel: cancelTtsSpy,
        getVoices: () => [],
        speak: (u: { onend?: (() => void) | null }) => {
          currentUtterance = u;
        },
      },
    };

    const states: Array<{ state: string; detail: string }> = [];
    const submitted: string[] = [];
    const onFinish = vi.fn();

    startFreeBrowserVoiceSession({
      languageMode: 'en',
      volume: 0.9,
      speakingRate: 1,
      voiceOutputEnabled: true,
      autoListen: true,
      followupListenSeconds: 5,
      getPermissions: () => ({ microphoneAccess: true, voiceSessionAccess: true }),
      onStateChange: (state, detail) => states.push({ state, detail }),
      onTranscriptPreview: () => {},
      onSubmitTranscript: async (text) => {
        submitted.push(text);
        return `Reply to ${text}`;
      },
      onFinish,
      onErrorMessage: () => {},
    });

    // Turn 1
    expect(instances).toHaveLength(1);
    instances[0]!.onresult?.({
      resultIndex: 0,
      results: [{ isFinal: true, 0: { transcript: 'First question' } }],
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(submitted).toEqual(['First question']);
    expect(currentUtterance).not.toBeNull();

    // TTS finishes -> follow-up window reopens mic automatically for 5s
    currentUtterance!.onend?.();
    expect(instances).toHaveLength(2);
    expect(states.some((s) => s.state === VoiceStates.LISTENING && s.detail.includes('follow-up (5s'))).toBe(true);

    // Silence until expiry -> transitions cleanly to IDLE with "Say Hey MJ to wake me"
    await vi.advanceTimersByTimeAsync(4900);
    expect(onFinish).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(200);
    expect(onFinish).toHaveBeenCalledTimes(1);
    expect(instances).toHaveLength(2);
    expect(states[states.length - 1]).toEqual({
      state: VoiceStates.IDLE,
      detail: IDLE_WAKE_STATUS_MESSAGE,
    });

    // Second run: speaking cancels the follow-up timer so long follow-ups aren't cut off at 5s
    instances.length = 0;
    states.length = 0;
    submitted.length = 0;
    const onFinish2 = vi.fn();

    startFreeBrowserVoiceSession({
      languageMode: 'en',
      volume: 0.9,
      speakingRate: 1,
      voiceOutputEnabled: true,
      autoListen: true,
      followupListenSeconds: 5,
      getPermissions: () => ({ microphoneAccess: true, voiceSessionAccess: true }),
      onStateChange: (state, detail) => states.push({ state, detail }),
      onTranscriptPreview: () => {},
      onSubmitTranscript: async (text) => {
        submitted.push(text);
        return 'Done';
      },
      onFinish: onFinish2,
      onErrorMessage: () => {},
    });

    instances[0]!.onresult?.({
      resultIndex: 0,
      results: [{ isFinal: true, 0: { transcript: 'Initial turn' } }],
    });
    await vi.advanceTimersByTimeAsync(0);
    currentUtterance!.onend?.();
    expect(instances).toHaveLength(2);

    // User starts speaking at 3.5s -> timer cancelled
    await vi.advanceTimersByTimeAsync(3500);
    instances[1]!.onresult?.({
      resultIndex: 0,
      results: [{ isFinal: false, 0: { transcript: 'Longer follow up' } }],
    });
    await vi.advanceTimersByTimeAsync(10_000);
    expect(onFinish2).not.toHaveBeenCalled();
    expect(instances[1]!.abort).not.toHaveBeenCalled();

    // Finalize follow-up speech
    instances[1]!.onresult?.({
      resultIndex: 0,
      results: [{ isFinal: true, 0: { transcript: 'Longer follow up completed' } }],
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(submitted).toEqual(['Initial turn', 'Longer follow up completed']);
  });

  it('reopens Server STT follow-up after TTS onEnd and expires cleanly without uploading silence', async () => {
    vi.useFakeTimers();
    const { stream } = createMockStream();
    let sampleByte = 190; // loud speech initially
    let activeRecorderCount = 0;
    const activeRecorders: MediaRecorderLike[] = [];

    const createRecorder = (): MediaRecorderLike => {
      const rec: MediaRecorderLike = {
        state: 'inactive',
        mimeType: 'audio/webm',
        ondataavailable: null,
        onstop: null,
        onerror: null,
        start: () => {
          rec.state = 'recording';
          activeRecorderCount += 1;
          setTimeout(() => {
            if (rec.state === 'recording') {
              rec.ondataavailable?.({ data: new Blob([new Uint8Array([1, 2, 3, 4])], { type: 'audio/webm' }) });
            }
          }, 50);
        },
        stop: () => {
          if (rec.state === 'inactive') return;
          rec.state = 'inactive';
          setTimeout(() => rec.onstop?.(), 10);
        },
      };
      activeRecorders.push(rec);
      return rec;
    };

    let currentUtterance: { onend?: (() => void) | null } | null = null;
    (globalThis as { window?: unknown }).window = {
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
          currentUtterance = u;
        },
      },
    };

    const sttSpy = vi.fn(async () => ({
      text: 'Server STT initial turn',
      language: 'en',
      modelUsed: 'gemini-2.5-flash',
      isFree: true,
    }));
    const states: Array<{ state: string; detail: string }> = [];
    const onFinish = vi.fn();

    startServerSttVoiceSession(
      {
        languageMode: 'en',
        volume: 0.9,
        speakingRate: 1,
        voiceOutputEnabled: true,
        autoListen: true,
        followupListenSeconds: 4,
        getPermissions: () => ({
          microphoneAccess: true,
          voiceSessionAccess: true,
          externalWebServices: true,
        }),
        onStateChange: (state, detail) => states.push({ state, detail }),
        onTranscriptPreview: () => {},
        onSubmitTranscript: async () => 'Assistant spoken response',
        onFinish,
        onError: () => {},
      },
      {
        getUserMedia: async () => stream,
        createMediaRecorder: createRecorder,
        createAudioContext: () => createControllableAudioContext(() => sampleByte),
        transcribeSpeech: sttSpy,
        silenceDurationMs: 250,
        minSpeechBeforeSilenceMs: 100,
        followupTimeoutMs: 400,
      },
    );

    // Hear speech then silence to finish Turn 1
    await vi.advanceTimersByTimeAsync(150);
    sampleByte = 128; // silence
    await vi.advanceTimersByTimeAsync(450);

    expect(sttSpy).toHaveBeenCalledTimes(1);
    expect(currentUtterance).not.toBeNull();

    // TTS finishes -> Turn 2 opens in follow-up mode with silence (sampleByte remains 128)
    currentUtterance!.onend?.();
    await vi.advanceTimersByTimeAsync(50);
    expect(activeRecorderCount).toBe(2);

    // Follow-up timer expires at 400ms with no speech -> no second STT request, returns IDLE "Say Hey MJ to wake me"
    await vi.advanceTimersByTimeAsync(500);
    expect(sttSpy).toHaveBeenCalledTimes(1);
    expect(onFinish).toHaveBeenCalledTimes(1);
    expect(states[states.length - 1]).toEqual({
      state: VoiceStates.IDLE,
      detail: IDLE_WAKE_STATUS_MESSAGE,
    });
  });

  it('barge-in stops TTS immediately when mic PCM16 RMS exceeds threshold (~1400) and resumes listening', async () => {
    vi.useFakeTimers();
    const { stream, stopSpy } = createMockStream();
    let sampleByte = 130; // ~512 PCM16 RMS (< 1400 threshold)

    const instances: Array<{
      onresult: ((ev: { resultIndex: number; results: ArrayLike<{ isFinal: boolean; 0?: { transcript?: string } }> }) => void) | null;
      stop: () => void;
      abort: () => void;
      start: () => void;
    }> = [];

    class FakeSpeechRecognition {
      lang = 'en-US';
      interimResults = true;
      continuous = false;
      maxAlternatives = 1;
      onresult = null;
      onerror = null;
      onend = null;
      stop = vi.fn();
      abort = vi.fn();
      start() {
        instances.push(this);
      }
    }

    const cancelTtsSpy = vi.fn();
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
        cancel: cancelTtsSpy,
        getVoices: () => [],
        speak: () => {
          // Keeps speaking until barged in!
        },
      },
    };

    const states: Array<{ state: string; detail: string }> = [];
    const controller = startFreeBrowserVoiceSession({
      languageMode: 'en',
      volume: 0.9,
      speakingRate: 1,
      voiceOutputEnabled: true,
      autoListen: true,
      followupListenSeconds: 7,
      bargeInThreshold: 1400,
      getPermissions: () => ({ microphoneAccess: true, voiceSessionAccess: true }),
      bargeInDeps: {
        getUserMedia: async () => stream,
        createAudioContext: () => createControllableAudioContext(() => sampleByte),
        pollIntervalMs: 50,
      },
      onStateChange: (state, detail) => states.push({ state, detail }),
      onTranscriptPreview: () => {},
      onSubmitTranscript: async () => 'Long spoken reply from MJ',
      onFinish: () => {},
      onErrorMessage: () => {},
    });

    instances[0]!.onresult?.({
      resultIndex: 0,
      results: [{ isFinal: true, 0: { transcript: 'Tell me a long story' } }],
    });
    await vi.advanceTimersByTimeAsync(120);

    // Below threshold (~512 < 1400): must NOT barge in
    expect(cancelTtsSpy).toHaveBeenCalledTimes(1); // initial clear inside speakWithBrowserSpeechSynthesis
    expect(instances).toHaveLength(1);

    // User speaks loudly (~4352 PCM16 RMS >= 1400): must immediately cancel TTS & reopen listening
    sampleByte = 145;
    await vi.advanceTimersByTimeAsync(100);
    expect(cancelTtsSpy).toHaveBeenCalledTimes(2);
    expect(stopSpy).toHaveBeenCalled();
    expect(states.some((s) => s.state === VoiceStates.INTERRUPTED)).toBe(true);
    expect(instances).toHaveLength(2);
    controller.stop();

    // Direct PCM16 RMS helper & MjVoiceService barge-in check
    expect(computePcm16Rms(new Float32Array(128).fill(0.02))).toBeLessThan(1400);
    expect(computePcm16Rms(new Float32Array(128).fill(0.06))).toBeGreaterThan(1400);
    const voiceSvc = new MjVoiceService(
      { fetchClientSecret: async () => ({} as VoiceClientSecretDTO) },
      {
        voiceId: 'ara',
        languageMode: 'auto',
        speakingRate: 1,
        volume: 0.9,
        voiceOutputEnabled: true,
        bargeInThreshold: 1400,
      },
    );
    (
      voiceSvc as unknown as {
        stateMachine: { transition: (s: string) => boolean };
      }
    ).stateMachine.transition(VoiceStates.SPEAKING);
    expect(voiceSvc.shouldTriggerBargeIn(new Float32Array(64).fill(0.02))).toBe(false);
    expect(voiceSvc.shouldTriggerBargeIn(new Float32Array(64).fill(0.06))).toBe(true);
  });

  it('never auto-listens or loops when privacy toggles are OFF or mic permission is denied', async () => {
    vi.useFakeTimers();

    const instances: Array<{
      onresult: ((ev: { resultIndex: number; results: ArrayLike<{ isFinal: boolean; 0?: { transcript?: string } }> }) => void) | null;
      onerror: ((ev: { error?: string }) => void) | null;
      start: () => void;
    }> = [];
    let currentUtterance: { onend?: (() => void) | null } | null = null;

    class FakeSpeechRecognition {
      lang = 'en-US';
      interimResults = true;
      continuous = false;
      maxAlternatives = 1;
      onresult = null;
      onerror = null;
      onend = null;
      stop = vi.fn();
      abort = vi.fn();
      start() {
        instances.push(this);
      }
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
          currentUtterance = u;
        },
      },
    };

    let micAllowed = true;
    const onFinish = vi.fn();
    startFreeBrowserVoiceSession({
      languageMode: 'en',
      volume: 0.9,
      speakingRate: 1,
      voiceOutputEnabled: true,
      autoListen: true,
      followupListenSeconds: 7,
      getPermissions: () => ({ microphoneAccess: micAllowed, voiceSessionAccess: true }),
      onStateChange: () => {},
      onTranscriptPreview: () => {},
      onSubmitTranscript: async () => 'Okay',
      onFinish,
      onErrorMessage: () => {},
    });

    instances[0]!.onresult?.({
      resultIndex: 0,
      results: [{ isFinal: true, 0: { transcript: 'Turn off mic now' } }],
    });
    await vi.advanceTimersByTimeAsync(0);

    // Privacy toggle turned OFF before TTS finishes -> must NOT reopen mic for follow-up
    micAllowed = false;
    currentUtterance!.onend?.();
    await vi.advanceTimersByTimeAsync(100);
    expect(instances).toHaveLength(1);
    expect(onFinish).toHaveBeenCalledTimes(1);

    // Privacy toggle OFF upfront in startResilientFreeVoiceSession -> never opens mic
    const blockedErrors: string[] = [];
    const blockedFinish = vi.fn();
    startResilientFreeVoiceSession({
      languageMode: 'en',
      volume: 0.9,
      speakingRate: 1,
      voiceOutputEnabled: true,
      autoListen: true,
      followupListenSeconds: 7,
      getPermissions: () => ({
        microphoneAccess: false,
        voiceSessionAccess: true,
        externalWebServices: true,
      }),
      onNotice: () => {},
      onStateChange: () => {},
      onTranscriptPreview: () => {},
      onSubmitTranscript: async () => '',
      onFinish: blockedFinish,
      onError: (msg) => blockedErrors.push(msg),
    });
    expect(instances).toHaveLength(1);
    expect(blockedFinish).toHaveBeenCalledTimes(1);
    expect(blockedErrors[0]).toContain('Microphone access is disabled');

    // Browser not-allowed error -> stops cleanly and never loops
    instances.length = 0;
    const deniedErrors: string[] = [];
    const deniedFinish = vi.fn();
    startFreeBrowserVoiceSession({
      languageMode: 'en',
      volume: 0.9,
      speakingRate: 1,
      voiceOutputEnabled: false,
      autoListen: true,
      followupListenSeconds: 7,
      onStateChange: () => {},
      onTranscriptPreview: () => {},
      onSubmitTranscript: async () => '',
      onFinish: deniedFinish,
      onErrorMessage: (m) => deniedErrors.push(m),
    });
    instances[0]!.onerror?.({ error: 'not-allowed' });
    await vi.advanceTimersByTimeAsync(5000);
    expect(instances).toHaveLength(1);
    expect(deniedFinish).toHaveBeenCalledTimes(1);
    expect(deniedErrors[0]).toContain('Microphone permission denied');
  });

  it('adds Gemini Live automaticActivityDetection, sessionResumption, and contextWindowCompression and auto-reconnects when autoListen is ON', async () => {
    vi.useFakeTimers();

    const setup = buildGeminiLiveSetupPayload({
      model: 'gemini-2.5-flash-native-audio-preview-12-2025',
      voiceId: 'ara',
      instructions: 'Be helpful',
      sessionHandle: 'handle-prev-1',
    });
    expect(setup.setup.realtimeInputConfig.automaticActivityDetection).toEqual({
      disabled: false,
      startOfSpeechSensitivity: 'START_SENSITIVITY_HIGH',
      endOfSpeechSensitivity: 'END_SENSITIVITY_LOW',
      prefixPaddingMs: 120,
      silenceDurationMs: 650,
    });
    expect(setup.setup.sessionResumption).toEqual({ handle: 'handle-prev-1' });
    expect(setup.setup.contextWindowCompression).toEqual({ slidingWindow: {} });

    const sentFrames: Array<Record<string, unknown>> = [];
    const sockets: Array<{
      onopen: (() => void) | null;
      onmessage: ((ev: { data: string }) => void) | null;
      onerror: (() => void) | null;
      onclose: ((ev: { code: number }) => void) | null;
      readyState: number;
      close: () => void;
    }> = [];

    class FakeWebSocket {
      static CONNECTING = 0;
      static OPEN = 1;
      static CLOSING = 2;
      static CLOSED = 3;
      readyState = 1;
      onopen: (() => void) | null = null;
      onmessage: ((ev: { data: string }) => void) | null = null;
      onerror: (() => void) | null = null;
      onclose: ((ev: { code: number }) => void) | null = null;
      constructor(public url: string) {
        sockets.push(this);
      }
      send(data: string) {
        sentFrames.push(JSON.parse(data) as Record<string, unknown>);
      }
      close() {
        this.readyState = 3;
      }
    }
    (globalThis as { WebSocket?: unknown }).WebSocket = FakeWebSocket;

    const { stream } = createMockStream();
    Object.defineProperty(globalThis, 'navigator', {
      value: { mediaDevices: { getUserMedia: async () => stream } },
      configurable: true,
      writable: true,
    });
    (globalThis as { window?: unknown }).window = {
      AudioContext: class {
        state = 'running';
        sampleRate = 48000;
        currentTime = 0;
        destination = {};
        createMediaStreamSource = () => ({ connect: () => {}, disconnect: () => {} });
        createAnalyser = () => ({ fftSize: 256, connect: () => {}, getFloatTimeDomainData: () => {} });
        createGain = () => ({ gain: { value: 1, setTargetAtTime: () => {} }, connect: () => {}, disconnect: () => {} });
        createScriptProcessor = () => ({ onaudioprocess: null, connect: () => {}, disconnect: () => {} });
        close = async () => {};
        resume = async () => {};
      },
    };

    const service = new MjVoiceService(
      {
        fetchClientSecret: async () => ({
          protocol: 'gemini-live',
          token: 'eph-1',
          expiresAt: 9999999,
          realtimeUrl: 'wss://generativelanguage.googleapis.com/ws/test',
          model: 'gemini-2.5-flash-native-audio-preview-12-2025',
          voice: 'ara',
          languageMode: 'auto',
          instructions: 'Stay concise.',
          contextTurns: [],
        }),
      },
      {
        voiceId: 'ara',
        languageMode: 'auto',
        speakingRate: 1,
        volume: 0.9,
        voiceOutputEnabled: true,
        autoListen: true,
      },
    );

    await service.startSession();
    expect(sockets).toHaveLength(1);
    sockets[0]!.onopen?.();
    sockets[0]!.onmessage?.({ data: JSON.stringify({ setupComplete: {} }) });
    sockets[0]!.onmessage?.({
      data: JSON.stringify({
        sessionResumptionUpdate: { newHandle: 'resume-tok-777', resumable: true },
      }),
    });
    sockets[0]!.onmessage?.({ data: JSON.stringify({ goAway: { timeLeft: '5s' } }) });

    // Even a code=1000 clean close triggers seamless resumption while autoListen=true & goAway received
    sockets[0]!.onclose?.({ code: 1000 });
    await vi.advanceTimersByTimeAsync(400);

    expect(sockets).toHaveLength(2);
    sockets[1]!.onopen?.();
    expect(sentFrames).toHaveLength(2);
    const secondSetup = sentFrames[1]!.setup as Record<string, unknown>;
    expect(secondSetup.sessionResumption).toEqual({ handle: 'resume-tok-777' });

    await service.stopSession('manual');
  });

  it('matches multilingual wake phrases (EN, Bangla, Banglish, Hindi), restarts reliably, and enforces browser vs Tauri startup policy', async () => {
    expect(matchWakePhrase('Hey, M.J.! What is up?')).toBe('hey mj');
    expect(matchWakePhrase('Shuno MJ ekta kotha')).toBe('shuno mj');
    expect(matchWakePhrase('হেই এমজে আজকে কি করব')).toBe('হেই এমজে');
    expect(matchWakePhrase('सुनो एमजे आज का प्लान बताओ')).toBe('सुनो एमजे');
    expect(matchWakePhrase('major update in server')).toBeNull();

    // Browser vs Tauri startup policy
    expect(
      canAutoStartWakeWordAtLaunch({
        authenticated: true,
        isTauriDesktop: false,
        wakeWordStandby: true,
        microphoneAccess: true,
        voiceSessionAccess: true,
        hasBrowserUserGesture: false,
        browserMicPermission: 'prompt',
        micActive: false,
      }),
    ).toEqual({ allowed: false, reason: 'browser_click_required' });

    expect(
      canAutoStartWakeWordAtLaunch({
        authenticated: true,
        isTauriDesktop: false,
        wakeWordStandby: true,
        microphoneAccess: true,
        voiceSessionAccess: true,
        hasBrowserUserGesture: true,
        browserMicPermission: 'prompt',
        micActive: false,
      }),
    ).toEqual({ allowed: true, reason: 'browser_gesture_or_granted' });

    expect(
      canAutoStartWakeWordAtLaunch({
        authenticated: true,
        isTauriDesktop: true,
        wakeWordStandby: false,
        microphoneAccess: true,
        voiceSessionAccess: true,
        hasBrowserUserGesture: false,
        micActive: false,
      }),
    ).toEqual({ allowed: false, reason: 'permission_off' });

    expect(
      canAutoStartWakeWordAtLaunch({
        authenticated: true,
        isTauriDesktop: true,
        wakeWordStandby: true,
        microphoneAccess: true,
        voiceSessionAccess: true,
        hasBrowserUserGesture: false,
        micActive: false,
      }),
    ).toEqual({ allowed: true, reason: 'tauri_standby_enabled' });

    // WakeWordListener restart + multilingual rotation
    vi.useFakeTimers();
    const wakeRecs: Array<{
      lang: string;
      onresult: ((ev: { results: ArrayLike<ArrayLike<{ transcript: string }>> }) => void) | null;
      onerror: ((ev: { error?: string }) => void) | null;
      onend: (() => void) | null;
      abort: () => void;
    }> = [];

    class FakeWakeRecognition {
      continuous = true;
      interimResults = true;
      maxAlternatives = 1;
      lang = 'en-US';
      onresult = null;
      onerror = null;
      onend = null;
      stop = vi.fn();
      abort = vi.fn();
      start() {
        wakeRecs.push(this);
      }
    }
    (globalThis as { window?: unknown }).window = { SpeechRecognition: FakeWakeRecognition };

    const detected: string[] = [];
    const statuses: Array<{ active: boolean; message: string }> = [];
    const listener = new WakeWordListener(
      (phrase) => detected.push(phrase),
      (st) => statuses.push({ active: st.active, message: st.message }),
      { languageMode: 'auto', canRun: () => true },
    );

    expect(listener.start()).toBe(true);
    expect(wakeRecs).toHaveLength(1);
    expect(wakeRecs[0]!.lang).toBe('en-US');

    // Recover from no-speech -> restarts in next language (bn-BD)
    wakeRecs[0]!.onerror?.({ error: 'no-speech' });
    wakeRecs[0]!.onend?.();
    await vi.advanceTimersByTimeAsync(400);
    expect(wakeRecs).toHaveLength(2);
    expect(wakeRecs[1]!.lang).toBe('bn-BD');

    // Detects Bengali wake phrase across alternatives and cleanly stops
    wakeRecs[1]!.onresult?.({
      results: [[{ transcript: 'random' }, { transcript: 'হেই এমজে শুরু করো' }]],
    });
    expect(detected).toEqual(['হেই এমজে শুরু করো']);
    expect(listener.isActive()).toBe(false);
    expect(statuses[statuses.length - 1]?.message).toContain('OFF');
  });
});
