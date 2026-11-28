import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  LanguageModeSchema,
  type LanguageMode,
  type PublicSettingsDTO,
} from '@mj/shared';
import {
  buildMjSystemPrompt,
  buildMjVoiceInstructions,
  getLanguageDirective,
  transcribeSpeechWithGemini,
} from '@mj/ai';
import { buildGeminiLiveSetupPayload } from '@mj/voice';
import { buildServer, type MjServerContext } from '../apps/server/src/app.js';
import { loadServerConfig } from '../apps/server/src/config.js';
import {
  detectTtsLanguageForText,
  resolveFreeVoiceLanguages,
  selectBestSpeechSynthesisVoice,
  speakWithBrowserSpeechSynthesis,
  startFreeBrowserVoiceSession,
} from '../apps/web/src/voice/freeBrowserVoice.js';
import {
  AUTO_LANGUAGE_SERVER_STT_NOTICE,
  shouldPreferServerSttForAuto,
  startResilientFreeVoiceSession,
  type MediaRecorderLike,
} from '../apps/web/src/voice/serverSttVoice.js';
import {
  WakeWordListener,
  matchWakePhrase,
  resolveWakeWordLanguages,
} from '../apps/web/src/voice/wakeWordListener.js';

function createMockStream(): { stream: MediaStream; stopSpy: ReturnType<typeof vi.fn> } {
  const stopSpy = vi.fn();
  const stream = {
    getTracks: () => [{ stop: stopSpy }],
  } as unknown as MediaStream;
  return { stream, stopSpy };
}

function createQuickRecorder(): MediaRecorderLike {
  const rec: MediaRecorderLike = {
    state: 'inactive',
    mimeType: 'audio/webm',
    ondataavailable: null,
    onstop: null,
    onerror: null,
    start: () => {
      rec.state = 'recording';
      setTimeout(() => {
        if (rec.state === 'recording') {
          rec.ondataavailable?.({
            data: new Blob([new Uint8Array([10, 20, 30, 40, 50])], { type: 'audio/webm' }),
          });
        }
      }, 10);
    },
    stop: () => {
      if (rec.state === 'inactive') return;
      rec.state = 'inactive';
      setTimeout(() => rec.onstop?.(), 10);
    },
  };
  return rec;
}

describe('Multilingual Understanding (Bangla, Hindi, English, Banglish, Hinglish)', () => {
  const contexts: MjServerContext[] = [];
  const originalWindow = (globalThis as { window?: unknown }).window;

  afterEach(async () => {
    (globalThis as { window?: unknown }).window = originalWindow;
    vi.restoreAllMocks();
    while (contexts.length > 0) {
      const ctx = contexts.pop()!;
      await ctx.app.close();
      ctx.dbHandle.close();
    }
  });

  it('supports all 6 LanguageModes in schema, settings store, systemPrompt, and Gemini STT hints', async () => {
    const allModes: LanguageMode[] = ['auto', 'en', 'bn', 'banglish', 'hi', 'hinglish'];
    for (const mode of allModes) {
      expect(LanguageModeSchema.parse(mode)).toBe(mode);
      const directive = getLanguageDirective(mode);
      expect(directive.length).toBeGreaterThan(20);
    }

    expect(getLanguageDirective('hi')).toContain('हिन्दी');
    expect(getLanguageDirective('hinglish')).toContain('Hinglish');
    const autoDirective = getLanguageDirective('auto');
    expect(autoDirective).toContain('each user turn');
    expect(autoDirective).toContain('Never translate');
    expect(autoDirective).toContain('Hinglish');
    expect(autoDirective).toContain('Banglish');

    const prompt = buildMjSystemPrompt({ languageMode: 'hinglish' });
    expect(prompt).toContain('Hinglish');
    const voicePrompt = buildMjVoiceInstructions({
      languageMode: 'auto',
      contextTurns: [
        { role: 'user', content: 'मुझे इस Fastify route को debug करना है' },
        { role: 'user', content: 'Vai ei bug ta ektu fix kore dao' },
      ],
    });
    expect(voicePrompt).toContain('मुझे इस Fastify route को debug करना है');
    expect(voicePrompt).toContain('Vai ei bug ta ektu fix kore dao');

    // Gemini STT prompt matches mixed/specific sample modes cleanly
    let capturedPrompt = '';
    const sttRes = await transcribeSpeechWithGemini(
      {
        apiKey: 'gem-secret',
        fetchImpl: async (_url, init) => {
          const parsed = JSON.parse(String(init?.body ?? '{}')) as {
            contents?: Array<{ parts?: Array<{ text?: string }> }>;
          };
          capturedPrompt = parsed.contents?.[0]?.parts?.[1]?.text ?? '';
          return new Response(
            JSON.stringify({
              candidates: [
                { content: { parts: [{ text: 'Kal subah meeting schedule kar do please' }] } },
              ],
            }),
            { status: 200, headers: { 'Content-Type': 'application/json' } },
          );
        },
      },
      { audioBytes: new Uint8Array([1, 2, 3, 4]), mimeType: 'audio/webm', languageMode: 'hinglish' },
    );
    expect(capturedPrompt).toContain('Hinglish');
    expect(sttRes.text).toBe('Kal subah meeting schedule kar do please');

    // Settings API persists 'hi' and 'hinglish'
    const config = loadServerConfig({
      APP_ENV: 'test',
      DATABASE_URL: ':memory:',
      AUTH_SECRET: 'multilang-test-auth-secret-32-chars-min',
      SERVE_WEB_DIST: 'false',
    });
    const ctx = await buildServer({ config });
    contexts.push(ctx);
    const loginRes = await ctx.app.inject({ method: 'POST', url: '/api/auth/login', payload: {} });
    const cookie = String(loginRes.headers['set-cookie']).split(';')[0]!;

    for (const targetMode of ['hi', 'hinglish'] as const) {
      const patchRes = await ctx.app.inject({
        method: 'PATCH',
        url: '/api/settings',
        headers: { cookie },
        payload: { voice: { languageMode: targetMode } },
      });
      expect(patchRes.statusCode).toBe(200);
      expect((patchRes.json() as PublicSettingsDTO).voice.languageMode).toBe(targetMode);
    }
  });

  it('keeps Gemini Live inputAudioTranscription ON and prefers Server STT in auto mode instead of Web Speech', async () => {
    const setup = buildGeminiLiveSetupPayload({
      model: 'gemini-2.5-flash-native-audio-preview-12-2025',
      voiceId: 'ara',
      instructions: 'Multilingual assistant',
    });
    expect(setup.setup.inputAudioTranscription).toEqual({});

    expect(shouldPreferServerSttForAuto('auto', true)).toBe(true);
    expect(shouldPreferServerSttForAuto('auto', false)).toBe(false);
    expect(shouldPreferServerSttForAuto('en', true)).toBe(false);
    expect(shouldPreferServerSttForAuto('bn', true)).toBe(false);
    expect(shouldPreferServerSttForAuto('hi', true)).toBe(false);
    expect(shouldPreferServerSttForAuto('banglish', true)).toBe(false);
    expect(shouldPreferServerSttForAuto('hinglish', true)).toBe(false);

    // When App prefers Server STT for 'auto', Web Speech is skipped completely and sample scripts transcribe via /api/voice/stt
    const webSpeechSpy = vi.fn();
    const notices: string[] = [];
    const { stream } = createMockStream();
    const samples = [
      'আমি বাংলায় কথা বলছি',
      'मैं हिंदी में बात कर रहा हूँ',
      'Ami Banglish e likhchi, etao bujho',
      'Bhaiya aaj Hinglish mein baat karte hain',
    ];

    for (const sampleText of samples) {
      const sttSpy = vi.fn(async () => ({
        text: sampleText,
        modelUsed: 'gemini-2.5-flash',
        isFree: true,
      }));
      const submitted: string[] = [];

      await new Promise<void>((resolve) => {
        startResilientFreeVoiceSession(
          {
            languageMode: 'auto',
            volume: 0.9,
            speakingRate: 1,
            voiceOutputEnabled: false,
            preferServerStt: shouldPreferServerSttForAuto('auto', true),
            initialNotice: AUTO_LANGUAGE_SERVER_STT_NOTICE,
            getPermissions: () => ({
              microphoneAccess: true,
              voiceSessionAccess: true,
              externalWebServices: true,
            }),
            onNotice: (n) => notices.push(n),
            onStateChange: () => {},
            onTranscriptPreview: () => {},
            onSubmitTranscript: async (text) => {
              submitted.push(text);
              return 'OK';
            },
            onFinish: () => resolve(),
            onError: () => resolve(),
          },
          {
            startWebSpeech: webSpeechSpy,
            serverSttDeps: {
              getUserMedia: async () => stream,
              createMediaRecorder: () => createQuickRecorder(),
              createAudioContext: () => null,
              transcribeSpeech: sttSpy,
              maxDurationMs: 500,
            },
          },
        );
      });

      expect(webSpeechSpy).not.toHaveBeenCalled();
      expect(sttSpy).toHaveBeenCalledTimes(1);
      expect(submitted).toEqual([sampleText]);
    }
    expect(notices[0]).toContain(AUTO_LANGUAGE_SERVER_STT_NOTICE);
  });

  it('resolves hi-IN/en-IN/bn-BD/en-US languages and retries next language on empty or low-confidence Web Speech results', async () => {
    expect(resolveFreeVoiceLanguages('auto')).toEqual(['en-IN', 'bn-BD', 'hi-IN', 'en-US']);
    expect(resolveFreeVoiceLanguages('hi')).toEqual(['hi-IN', 'en-IN', 'en-US']);
    expect(resolveFreeVoiceLanguages('hinglish')).toEqual(['en-IN', 'hi-IN', 'en-US']);
    expect(resolveFreeVoiceLanguages('banglish')).toEqual(['en-IN', 'bn-BD', 'en-US']);
    expect(resolveFreeVoiceLanguages('bn')).toEqual(['bn-BD', 'en-IN', 'en-US']);
    expect(resolveFreeVoiceLanguages('en')).toEqual(['en-US']);

    const instances: Array<{
      lang: string;
      onresult: ((ev: {
        resultIndex: number;
        results: ArrayLike<{ isFinal: boolean; 0?: { transcript?: string; confidence?: number } }>;
      }) => void) | null;
      abort: ReturnType<typeof vi.fn>;
    }> = [];

    class FakeSpeechRecognition {
      lang = 'en-IN';
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
    (globalThis as { window?: unknown }).window = { SpeechRecognition: FakeSpeechRecognition };

    const submitted: string[] = [];
    const done = new Promise<void>((resolve) => {
      startFreeBrowserVoiceSession({
        languageMode: 'hinglish',
        volume: 0.9,
        speakingRate: 1,
        voiceOutputEnabled: false,
        onStateChange: () => {},
        onTranscriptPreview: () => {},
        onSubmitTranscript: async (text) => {
          submitted.push(text);
          return 'Done';
        },
        onFinish: () => resolve(),
        onErrorMessage: () => resolve(),
      });
    });

    // Attempt 1 (en-IN): empty final result -> retries hi-IN
    expect(instances[0]!.lang).toBe('en-IN');
    instances[0]!.onresult?.({
      resultIndex: 0,
      results: [{ isFinal: true, 0: { transcript: '   ', confidence: 0.9 } }],
    });
    expect(instances).toHaveLength(2);
    expect(instances[1]!.lang).toBe('hi-IN');

    // Attempt 2 (hi-IN): low confidence final result -> retries en-US
    instances[1]!.onresult?.({
      resultIndex: 0,
      results: [{ isFinal: true, 0: { transcript: 'noise guess', confidence: 0.2 } }],
    });
    expect(instances).toHaveLength(3);
    expect(instances[2]!.lang).toBe('en-US');

    // Attempt 3 (en-US): confident result -> submits cleanly
    instances[2]!.onresult?.({
      resultIndex: 0,
      results: [{ isFinal: true, 0: { transcript: 'Kal meeting fix karo', confidence: 0.92 } }],
    });

    await done;
    expect(submitted).toEqual(['Kal meeting fix karo']);
  });

  it('uses selected languages instead of hardcoded en-US in WakeWordListener and fuzzy-matches Bangla/Hindi/mix phrases', () => {
    expect(resolveWakeWordLanguages({ languageMode: 'hi' })).toEqual(['hi-IN', 'en-IN', 'en-US']);
    expect(resolveWakeWordLanguages({ languageMode: 'bn' })).toEqual(['bn-BD', 'en-IN', 'en-US']);
    expect(resolveWakeWordLanguages({ languageMode: 'hinglish' })).toEqual(['en-IN', 'hi-IN', 'en-US']);

    const startedLangs: string[] = [];
    class FakeWakeRecognition {
      continuous = true;
      interimResults = true;
      maxAlternatives = 3;
      lang = '';
      onresult = null;
      onerror = null;
      onend = null;
      stop = vi.fn();
      abort = vi.fn();
      start() {
        startedLangs.push(this.lang);
      }
    }
    (globalThis as { window?: unknown }).window = { SpeechRecognition: FakeWakeRecognition };

    const listener = new WakeWordListener(
      () => {},
      () => {},
      { languageMode: 'hi' },
    );
    listener.start();
    expect(startedLangs).toEqual(['hi-IN']);
    listener.stop();

    // Multilingual & mixed wake phrases + fuzzy variants
    const positiveSamples = [
      'hey mj',
      'hi mj please open notes',
      'ও এমজে একটু শোনো',
      'শুনো এমজে একটু সাহায্য করো',
      'हे एमजे सुनो ना',
      'ওহ এম জে কি খবর',
      'Suno MJ bhai ek kaam tha',
      'Shuno MJ amar ekta file khujo',
      // Fuzzy typos from speech recognizers
      'Hay MJ start voice',
      'Hei M.J. help',
      'Sunno MJ please',
      'ओ एम जे सुनो',
    ];
    for (const sample of positiveSamples) {
      expect(matchWakePhrase(sample), sample).not.toBeNull();
    }

    const negativeSamples = [
      'hello world how are you',
      'major upgrade to fastify server',
      'আজকে আবহাওয়া খুব সুন্দর',
      'आज मौसम बहुत अच्छा है',
      'bhai ye React code check karo',
    ];
    for (const sample of negativeSamples) {
      expect(matchWakePhrase(sample), sample).toBeNull();
    }
  });

  it('picks the right Browser TTS language and voice per detected script (Bengali, Devanagari, Latin)', () => {
    expect(detectTtsLanguageForText('হ্যালো! আমি আজকের কাজ গুছিয়ে দিচ্ছি', 'auto')).toBe('bn-BD');
    expect(detectTtsLanguageForText('नमस्ते! आपका API सर्वर तैयार है', 'auto')).toBe('hi-IN');
    expect(detectTtsLanguageForText('Sure, I compiled TypeScript cleanly.', 'auto')).toBe('en-US');
    expect(detectTtsLanguageForText('Bhaia server ektu check koro', 'banglish')).toBe('en-IN');
    expect(detectTtsLanguageForText('Yaar ye Fastify route check kar', 'hinglish')).toBe('en-IN');
    expect(detectTtsLanguageForText('TypeScript আর Fastify রেডি', 'en')).toBe('bn-BD');
    expect(detectTtsLanguageForText('React और Vite तैयार है', 'en')).toBe('hi-IN');

    const mockVoices = [
      { lang: 'en-US', name: 'English US' },
      { lang: 'en-IN', name: 'English India' },
      { lang: 'bn-BD', name: 'Bangla BD' },
      { lang: 'hi-IN', name: 'Hindi India' },
    ] as unknown as SpeechSynthesisVoice[];

    expect(selectBestSpeechSynthesisVoice(mockVoices, 'bn-BD')?.name).toBe('Bangla BD');
    expect(selectBestSpeechSynthesisVoice(mockVoices, 'hi-IN')?.name).toBe('Hindi India');
    expect(selectBestSpeechSynthesisVoice(mockVoices, 'en-IN')?.name).toBe('English India');
    expect(selectBestSpeechSynthesisVoice(mockVoices, 'en-US')?.name).toBe('English US');

    const spokenUtterances: Array<{ lang: string; voice?: { name?: string } }> = [];
    (globalThis as { window?: unknown }).window = {
      SpeechSynthesisUtterance: class {
        lang = '';
        volume = 1;
        rate = 1;
        voice?: { name?: string };
        onend: (() => void) | null = null;
        onerror: (() => void) | null = null;
        constructor(public text: string) {}
      },
      speechSynthesis: {
        cancel: vi.fn(),
        getVoices: () => mockVoices,
        speak: (u: { lang: string; voice?: { name?: string }; onend?: (() => void) | null }) => {
          spokenUtterances.push(u);
          u.onend?.();
        },
      },
    };

    speakWithBrowserSpeechSynthesis('সব ঠিক আছে, শুরু করি', {
      volume: 1,
      speakingRate: 1,
      languageMode: 'auto',
    });
    speakWithBrowserSpeechSynthesis('सब ठीक है, शुरू करते हैं', {
      volume: 1,
      speakingRate: 1,
      languageMode: 'auto',
    });
    speakWithBrowserSpeechSynthesis('Everything is tested and ready.', {
      volume: 1,
      speakingRate: 1,
      languageMode: 'auto',
    });

    expect(spokenUtterances.map((u) => [u.lang, u.voice?.name])).toEqual([
      ['bn-BD', 'Bangla BD'],
      ['hi-IN', 'Hindi India'],
      ['en-US', 'English US'],
    ]);
  });
});
