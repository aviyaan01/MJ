import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_GEMINI_FEMALE_VOICE_ID,
  DEFAULT_VOICE_PERSONA,
  type LanguageMode,
  type PublicSettingsDTO,
  type VoiceClientSecretDTO,
} from '@mj/shared';
import {
  buildMjSystemPrompt,
  buildMjVoiceInstructions,
  mapGeminiVoiceName,
} from '@mj/ai';
import { mapToGeminiPrebuiltVoice } from '@mj/voice';
import { buildServer, type MjServerContext } from '../apps/server/src/app.js';
import { loadServerConfig } from '../apps/server/src/config.js';
import {
  isPreferredFemaleVoiceName,
  selectBestSpeechSynthesisVoice,
  speakWithBrowserSpeechSynthesis,
} from '../apps/web/src/voice/freeBrowserVoice.js';

describe('Warm Female Voice & Friendly Personality', () => {
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

  it('supports USER_NAME / userName, voice.persona (friendly | professional), and real Gemini female voice IDs across server API', async () => {
    const config = loadServerConfig({
      APP_ENV: 'test',
      DATABASE_URL: ':memory:',
      USER_NAME: 'Tariq',
      GEMINI_API_KEY: 'gem-fake-test-key-for-voice-list',
      AUTH_SECRET: 'persona-test-auth-secret-32-characters-min',
      SERVE_WEB_DIST: 'false',
    });
    const ctx = await buildServer({
      config,
      voiceGateway: {
        createClientSecret: async () => ({
          token: 'eph-gem-female',
          expiresAt: 1999999999,
          protocol: 'gemini-live',
          realtimeUrl: 'wss://generativelanguage.googleapis.com/ws/test',
          model: 'gemini-2.5-flash-native-audio-preview-12-2025',
        }),
        synthesizeSpeech: async () => ({
          audioBuffer: new ArrayBuffer(8),
          contentType: 'audio/wav',
          isFree: true,
        }),
        listVoices: async () => [
          { id: 'Aoede', label: 'Aoede (Female · Default)', description: 'Warm female voice' },
          { id: 'Kore', label: 'Kore (Female)', description: 'Clear female voice' },
          { id: 'Leda', label: 'Leda (Female)', description: 'Bright female voice' },
          { id: 'Zephyr', label: 'Zephyr (Female)', description: 'Smooth female voice' },
        ],
        transcribeSpeech: async () => ({ text: 'hi', isFree: true }),
      },
    });
    contexts.push(ctx);

    const loginRes = await ctx.app.inject({ method: 'POST', url: '/api/auth/login', payload: {} });
    const cookie = String(loginRes.headers['set-cookie']).split(';')[0]!;

    const settingsRes = await ctx.app.inject({
      method: 'GET',
      url: '/api/settings',
      headers: { cookie },
    });
    expect(settingsRes.statusCode).toBe(200);
    const initial = settingsRes.json() as PublicSettingsDTO;
    expect(initial.userName).toBe('Tariq');
    expect(initial.voice.voiceId).toBe(DEFAULT_GEMINI_FEMALE_VOICE_ID);
    expect(initial.voice.voiceId).toBe('Aoede');
    expect(initial.voice.persona).toBe(DEFAULT_VOICE_PERSONA);
    expect(initial.voice.persona).toBe('friendly');
    expect(initial.voice.availableVoices.map((v) => v.id)).toEqual([
      'Aoede',
      'Kore',
      'Leda',
      'Zephyr',
    ]);

    const voicesRes = await ctx.app.inject({
      method: 'GET',
      url: '/api/voice/voices',
      headers: { cookie },
    });
    expect(voicesRes.statusCode).toBe(200);
    expect((voicesRes.json() as { voices: Array<{ id: string }> }).voices.map((v) => v.id)).toEqual([
      'Aoede',
      'Kore',
      'Leda',
      'Zephyr',
    ]);

    // Update userName & voice.persona -> verify /api/voice/client-secret instructions inherit them
    const patchRes = await ctx.app.inject({
      method: 'PATCH',
      url: '/api/settings',
      headers: { cookie },
      payload: {
        userName: 'Nadia',
        voice: { voiceId: 'Leda', persona: 'professional' },
      },
    });
    expect(patchRes.statusCode).toBe(200);
    const patched = patchRes.json() as PublicSettingsDTO;
    expect(patched.userName).toBe('Nadia');
    expect(patched.voice.voiceId).toBe('Leda');
    expect(patched.voice.persona).toBe('professional');

    await ctx.app.inject({
      method: 'PATCH',
      url: '/api/privacy/permissions',
      headers: { cookie },
      payload: { key: 'microphoneAccess', enabled: true },
    });
    await ctx.app.inject({
      method: 'PATCH',
      url: '/api/privacy/permissions',
      headers: { cookie },
      payload: { key: 'voiceSessionAccess', enabled: true },
    });

    const secretRes = await ctx.app.inject({
      method: 'POST',
      url: '/api/voice/client-secret',
      headers: { cookie },
      payload: {},
    });
    expect(secretRes.statusCode).toBe(200);
    const secret = secretRes.json() as VoiceClientSecretDTO;
    expect(secret.voice).toBe('Leda');
    expect(secret.instructions).toContain('Nadia');
    expect(secret.instructions).toContain('composed');
  });

  it('builds warm female friend prompts per language with feminine Hindi/Hinglish and Bangla tone', () => {
    const modes: LanguageMode[] = ['auto', 'en', 'bn', 'banglish', 'hi', 'hinglish'];
    for (const mode of modes) {
      const prompt = buildMjSystemPrompt({
        userName: 'Rafi',
        persona: 'friendly',
        languageMode: mode,
      });
      expect(prompt).toContain('female AI friend');
      expect(prompt).toContain('Rafi');
      expect(prompt).toContain('light tasteful humor');
      expect(prompt).toContain('Never pretend to have completed an action');
      expect(prompt.toLowerCase()).not.toContain('never pretend to be conscious or have human feelings');
    }

    const hiPrompt = buildMjSystemPrompt({ languageMode: 'hi', persona: 'friendly' });
    expect(hiPrompt).toContain('मैं कर रही हूँ');
    expect(hiPrompt).toContain('feminine first-person');

    const hinglishPrompt = buildMjSystemPrompt({ languageMode: 'hinglish', persona: 'friendly' });
    expect(hinglishPrompt).toContain('main kar rahi hoon');

    const bnPrompt = buildMjSystemPrompt({ languageMode: 'bn', persona: 'friendly' });
    expect(bnPrompt).toContain('female speaker tone');

    const friendlyVoice = buildMjVoiceInstructions({
      userName: 'Maya',
      persona: 'friendly',
      languageMode: 'auto',
    });
    expect(friendlyVoice).toContain('close friend right beside them');
    expect(friendlyVoice).toContain('Maya');
    expect(friendlyVoice).toContain('main kar rahi hoon');

    const proVoice = buildMjVoiceInstructions({
      userName: 'Maya',
      persona: 'professional',
      languageMode: 'en',
    });
    expect(proVoice).toContain('composed and concise');
    expect(proVoice).not.toContain('close friend right beside them');
  });

  it('maps Gemini Live voice names (Aoede, Kore, Leda, Zephyr + legacy aliases) accurately', () => {
    const cases: Array<[string | undefined, string]> = [
      ['Aoede', 'Aoede'],
      ['aoede', 'Aoede'],
      ['Kore', 'Kore'],
      ['kore', 'Kore'],
      ['Leda', 'Leda'],
      ['leda', 'Leda'],
      ['Zephyr', 'Zephyr'],
      ['zephyr', 'Zephyr'],
      ['ara', 'Aoede'],
      ['eve', 'Kore'],
      [undefined, 'Aoede'],
    ];
    for (const [input, expected] of cases) {
      expect(mapToGeminiPrebuiltVoice(input)).toBe(expected);
      expect(mapGeminiVoiceName(input)).toBe(expected);
    }
  });

  it('prefers female Browser SpeechSynthesis voices per target language and falls back cleanly when absent', () => {
    expect(isPreferredFemaleVoiceName('Microsoft Zira Desktop - English (United States)')).toBe(true);
    expect(isPreferredFemaleVoiceName('Microsoft Heera - Hindi (India)')).toBe(true);
    expect(isPreferredFemaleVoiceName('Microsoft Neerja Online (Natural)')).toBe(true);
    expect(isPreferredFemaleVoiceName('Microsoft Tanishaa Online (Natural)')).toBe(true);
    expect(isPreferredFemaleVoiceName('Samantha')).toBe(true);
    expect(isPreferredFemaleVoiceName('Google UK English Female')).toBe(true);
    expect(isPreferredFemaleVoiceName('Google UK English Male')).toBe(false);
    expect(isPreferredFemaleVoiceName('Microsoft David Desktop')).toBe(false);

    const mixedVoices = [
      { lang: 'en-US', name: 'Microsoft David Desktop' },
      { lang: 'en-US', name: 'Microsoft Zira Desktop' },
      { lang: 'en-IN', name: 'Microsoft Ravi' },
      { lang: 'en-IN', name: 'Microsoft Neerja Online (Natural)' },
      { lang: 'hi-IN', name: 'Microsoft Hemant' },
      { lang: 'hi-IN', name: 'Microsoft Heera' },
      { lang: 'bn-BD', name: 'Microsoft Pradeep Online' },
      { lang: 'bn-IN', name: 'Microsoft Tanishaa Online (Natural)' },
    ] as unknown as SpeechSynthesisVoice[];

    expect(selectBestSpeechSynthesisVoice(mixedVoices, 'en-US')?.name).toBe('Microsoft Zira Desktop');
    expect(selectBestSpeechSynthesisVoice(mixedVoices, 'en-IN')?.name).toBe(
      'Microsoft Neerja Online (Natural)',
    );
    expect(selectBestSpeechSynthesisVoice(mixedVoices, 'hi-IN')?.name).toBe('Microsoft Heera');
    // Matches base language female voice (Tanishaa bn-IN) even over exact-locale male voice (Pradeep bn-BD)!
    expect(selectBestSpeechSynthesisVoice(mixedVoices, 'bn-BD')?.name).toBe(
      'Microsoft Tanishaa Online (Natural)',
    );

    // Fallback: returns non-female voice when no female voice exists for that language
    const maleOnlyVoices = [
      { lang: 'en-US', name: 'Microsoft David' },
      { lang: 'hi-IN', name: 'Microsoft Hemant' },
    ] as unknown as SpeechSynthesisVoice[];
    expect(selectBestSpeechSynthesisVoice(maleOnlyVoices, 'en-US')?.name).toBe('Microsoft David');

    // End-to-end speakWithBrowserSpeechSynthesis binds the female voice per detected script
    const selected: Array<{ lang: string; voiceName?: string }> = [];
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
        getVoices: () => mixedVoices,
        speak: (u: { lang: string; voice?: { name?: string }; onend?: (() => void) | null }) => {
          selected.push({ lang: u.lang, voiceName: u.voice?.name });
          u.onend?.();
        },
      },
    };

    speakWithBrowserSpeechSynthesis('मैं देख रही हूँ, चिंता मत करो।', {
      volume: 1,
      speakingRate: 1,
      languageMode: 'auto',
    });
    speakWithBrowserSpeechSynthesis('আমি দেখে নিচ্ছি, একদম চিন্তা করো না।', {
      volume: 1,
      speakingRate: 1,
      languageMode: 'auto',
    });
    speakWithBrowserSpeechSynthesis('Got it, checking that for you now!', {
      volume: 1,
      speakingRate: 1,
      languageMode: 'auto',
    });

    expect(selected).toEqual([
      { lang: 'hi-IN', voiceName: 'Microsoft Heera' },
      { lang: 'bn-BD', voiceName: 'Microsoft Tanishaa Online (Natural)' },
      { lang: 'en-US', voiceName: 'Microsoft Zira Desktop' },
    ]);
  });
});
