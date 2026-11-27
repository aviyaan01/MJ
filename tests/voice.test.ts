import { describe, expect, it } from 'vitest';
import { ErrorCodes, VoiceStates } from '@mj/shared';
import {
  ALL_VOICE_STATES,
  VOICE_STATE_META,
  VoiceStateMachine,
  computeRmsLevel,
  float32ToPcm16Base64,
  pcm16Base64ToFloat32,
  resampleFloat32,
  toVoiceAppError,
} from '@mj/voice';
import {
  buildMjVoiceInstructions,
  createRealtimeClientSecret,
  transcribeSpeech,
} from '@mj/ai';

describe('VoiceStateMachine (Section 05)', () => {
  it('supports all 9 required voice states with metadata and guarded transitions', () => {
    expect(ALL_VOICE_STATES).toHaveLength(9);
    for (const st of ALL_VOICE_STATES) {
      expect(VOICE_STATE_META[st].label.length).toBeGreaterThan(0);
    }

    const sm = new VoiceStateMachine();
    expect(sm.getState()).toBe(VoiceStates.IDLE);

    // Invalid jump straight from idle -> speaking
    expect(sm.transition(VoiceStates.LISTENING)).toBe(false);

    expect(sm.transition(VoiceStates.REQUESTING_PERMISSION)).toBe(true);
    expect(sm.transition(VoiceStates.CONNECTING)).toBe(true);
    expect(sm.transition(VoiceStates.LISTENING)).toBe(true);
    expect(sm.transition(VoiceStates.PROCESSING)).toBe(true);
    expect(sm.transition(VoiceStates.SPEAKING)).toBe(true);
    expect(sm.transition(VoiceStates.INTERRUPTED)).toBe(true);
    expect(sm.transition(VoiceStates.LISTENING)).toBe(true);
    expect(sm.transition(VoiceStates.RECONNECTING)).toBe(true);
    expect(sm.transition(VoiceStates.ERROR)).toBe(true);

    sm.reset();
    expect(sm.getState()).toBe(VoiceStates.IDLE);
  });
});

describe('Audio Codec & Resampler (Section 03 & 05)', () => {
  it('resamples 48kHz to 24kHz and round-trips Float32 <-> PCM16 base64', () => {
    const input48k = new Float32Array(480);
    for (let i = 0; i < input48k.length; i++) {
      input48k[i] = Math.sin((2 * Math.PI * 440 * i) / 48000) * 0.5;
    }

    const resampled = resampleFloat32(input48k, 48000, 24000);
    expect(resampled.length).toBe(240);

    const encoded = float32ToPcm16Base64(resampled);
    const decoded = pcm16Base64ToFloat32(encoded);
    expect(decoded.length).toBe(resampled.length);

    let maxErr = 0;
    for (let i = 0; i < decoded.length; i++) {
      maxErr = Math.max(maxErr, Math.abs((decoded[i] ?? 0) - (resampled[i] ?? 0)));
    }
    expect(maxErr).toBeLessThan(0.001);
    expect(computeRmsLevel(new Float32Array(128))).toBe(0);
    expect(computeRmsLevel(decoded)).toBeGreaterThan(0.1);
  });
});

describe('Voice Instructions & Ephemeral Secret Client (Section 03 & 05)', () => {
  it('includes multilingual Bengali/English/Banglish handling and shared context turns', () => {
    const instructions = buildMjVoiceInstructions({
      languageMode: 'auto',
      contextTurns: [
        { role: 'user', content: 'Amar ekta TypeScript backend lagbe' },
        { role: 'assistant', content: 'Sure, let us structure your Fastify endpoints.' },
      ],
    });
    expect(instructions).toContain('MJ Assistant');
    expect(instructions).toContain('Banglish');
    expect(instructions).toContain('Amar ekta TypeScript backend lagbe');
  });

  it('requests ephemeral client secret via POST /v1/realtime/client_secrets', async () => {
    let capturedUrl = '';
    let capturedBody = '';

    const secret = await createRealtimeClientSecret({
      apiKey: 'xai-server-only-key',
      baseUrl: 'https://api.x.ai/v1',
      fetchImpl: async (input, init) => {
        capturedUrl = String(input);
        capturedBody = String(init?.body ?? '');
        return new Response(
          JSON.stringify({ value: 'eph_tok_123', expires_at: 1900000000 }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        );
      },
    });

    expect(capturedUrl).toBe('https://api.x.ai/v1/realtime/client_secrets');
    expect(JSON.parse(capturedBody)).toEqual({ expires_after: { seconds: 300 } });
    expect(secret).toEqual({ token: 'eph_tok_123', expiresAt: 1900000000 });
  });

  it('submits STT multipart form and maps upstream errors', async () => {
    const res = await transcribeSpeech(
      {
        apiKey: 'xai-server-only-key',
        baseUrl: 'https://api.x.ai/v1',
        fetchImpl: async () =>
          new Response(JSON.stringify({ text: 'হ্যালো MJ', language: 'bn' }), { status: 200 }),
      },
      {
        audioBytes: new Uint8Array([1, 2, 3, 4]),
        filename: 'clip.webm',
        mimeType: 'audio/webm',
        languageMode: 'auto',
      },
    );
    expect(res.text).toBe('হ্যালো MJ');
    expect(res.language).toBe('bn');

    await expect(
      createRealtimeClientSecret({
        apiKey: 'xai-bad-key',
        baseUrl: 'https://api.x.ai/v1',
        fetchImpl: async () =>
          new Response(JSON.stringify({ error: { message: 'Invalid API key' } }), {
            status: 401,
          }),
      }),
    ).rejects.toMatchObject({
      code: ErrorCodes.INVALID_API_KEY,
      message: 'API key invalid',
    });

    await expect(
      createRealtimeClientSecret({
        apiKey: 'xai-nocredits',
        baseUrl: 'https://api.x.ai/v1',
        fetchImpl: async () =>
          new Response(
            JSON.stringify({
              error: {
                code: 'permission-denied',
                message: 'Your team does not have any credits or licenses.',
              },
            }),
            { status: 403 },
          ),
      }),
    ).rejects.toMatchObject({
      code: ErrorCodes.INSUFFICIENT_CREDITS,
      message: 'xAI account e credit nai. console.x.ai te billing check koro.',
    });

    await expect(
      createRealtimeClientSecret({
        apiKey: 'xai-forbidden',
        baseUrl: 'https://api.x.ai/v1',
        fetchImpl: async () =>
          new Response(JSON.stringify({ error: 'Scope blocked' }), { status: 403 }),
      }),
    ).rejects.toMatchObject({
      code: ErrorCodes.UNAUTHORIZED,
      message: 'permission/credits nai',
    });

    await expect(
      createRealtimeClientSecret({
        apiKey: 'xai-down',
        baseUrl: 'https://api.x.ai/v1',
        fetchImpl: async () => {
          throw new TypeError('fetch failed');
        },
      }),
    ).rejects.toMatchObject({
      code: ErrorCodes.VOICE_SERVICE_UNAVAILABLE,
      message: 'service unavailable',
    });

    // Preserves ApiClientError structured payload (INSUFFICIENT_CREDITS / INVALID_API_KEY)
    // instead of masking it as generic "service unavailable" in VoiceStateBar
    const apiClientLikeErr = Object.assign(new Error('xAI account e credit nai.'), {
      payload: {
        code: ErrorCodes.INSUFFICIENT_CREDITS,
        category: 'api' as const,
        statusCode: 402,
        message: 'xAI account e credit nai. console.x.ai te billing check koro.',
        retryable: false,
      },
    });
    const preserved = toVoiceAppError(apiClientLikeErr);
    expect(preserved.code).toBe(ErrorCodes.INSUFFICIENT_CREDITS);
    expect(preserved.message).toBe('xAI account e credit nai. console.x.ai te billing check koro.');
  });
});
