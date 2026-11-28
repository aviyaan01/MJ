import { AppError, ErrorCodes, type LanguageMode } from '@mj/shared';
import { mapUpstreamHttpError, normalizeToAppError } from './xaiClient.js';

export interface VoiceApiConfig {
  apiKey: string;
  baseUrl: string;
  fetchImpl?: typeof fetch;
}

export interface EphemeralSecretResult {
  token: string;
  expiresAt: number;
  protocol?: 'gemini-live' | 'xai-realtime' | 'free-browser';
  realtimeUrl?: string;
  model?: string;
  fallbackReason?: string;
}

export interface TtsSynthesisResult {
  audioBuffer: ArrayBuffer;
  contentType: string;
  modelUsed?: string;
  isFree?: boolean;
}

export interface SttTranscriptionResult {
  text: string;
  language?: string;
  modelUsed?: string;
  isFree?: boolean;
}

export const GEMINI_LIVE_DEFAULT_MODEL = 'gemini-2.5-flash-native-audio-preview-12-2025';
export const GEMINI_LIVE_WS_URL =
  'wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1alpha.GenerativeService.BidiGenerateContentConstrained';
export const GEMINI_TTS_DEFAULT_MODEL = 'gemini-2.5-flash-preview-tts';

function normalizeBaseUrl(baseUrl: string): string {
  return baseUrl.replace(/\/+$/, '');
}

function mapLanguageHint(mode: LanguageMode | undefined): string | undefined {
  if (mode === 'en') return 'en';
  if (mode === 'bn') return 'bn';
  // For 'auto' and 'banglish', let xAI auto-detect across Bengali/English
  return undefined;
}

/**
 * Requests a short-lived ephemeral token from `POST /v1/realtime/client_secrets`
 * using the server-side `XAI_API_KEY` so the permanent key never reaches the browser.
 */
export async function createRealtimeClientSecret(
  config: VoiceApiConfig,
  expiresAfterSeconds = 300,
): Promise<EphemeralSecretResult> {
  if (!config.apiKey.trim()) {
    throw new AppError({
      code: ErrorCodes.INVALID_API_KEY,
      category: 'api',
      statusCode: 502,
    });
  }

  const fetchImpl = config.fetchImpl ?? fetch;
  const url = `${normalizeBaseUrl(config.baseUrl)}/realtime/client_secrets`;

  let response: Response;
  try {
    response = await fetchImpl(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${config.apiKey}`,
      },
      body: JSON.stringify({
        expires_after: {
          seconds: Math.max(60, Math.min(expiresAfterSeconds, 600)),
        },
      }),
      signal: AbortSignal.timeout(15000),
    });
  } catch (err) {
    throw normalizeToAppError(err, {
      networkCode: ErrorCodes.VOICE_SERVICE_UNAVAILABLE,
      networkCategory: 'voice',
    });
  }

  if (!response.ok) {
    throw await mapUpstreamHttpError(response);
  }

  const json = (await response.json()) as Record<string, unknown>;
  const nested =
    json.client_secret && typeof json.client_secret === 'object'
      ? (json.client_secret as Record<string, unknown>)
      : json;

  const token = typeof nested.value === 'string' ? nested.value : '';
  const expiresAt =
    typeof nested.expires_at === 'number'
      ? nested.expires_at
      : Math.floor(Date.now() / 1000) + expiresAfterSeconds;

  if (!token) {
    throw new AppError({
      code: ErrorCodes.VOICE_SERVICE_UNAVAILABLE,
      category: 'voice',
      statusCode: 502,
      message: 'service unavailable',
      upstreamDiagnostic: 'xAI realtime/client_secrets returned empty secret value',
    });
  }

  return { token, expiresAt };
}

/**
 * Fallback Text-to-Speech proxy calling `POST /v1/tts`.
 */
export async function synthesizeSpeech(
  config: VoiceApiConfig,
  params: {
    text: string;
    voiceId?: string;
    languageMode?: LanguageMode;
  },
): Promise<TtsSynthesisResult> {
  if (!config.apiKey.trim()) {
    throw new AppError({
      code: ErrorCodes.INVALID_API_KEY,
      category: 'api',
      statusCode: 502,
    });
  }

  const fetchImpl = config.fetchImpl ?? fetch;
  const url = `${normalizeBaseUrl(config.baseUrl)}/tts`;
  const language = mapLanguageHint(params.languageMode);

  let response: Response;
  try {
    response = await fetchImpl(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${config.apiKey}`,
      },
      body: JSON.stringify({
        text: params.text,
        voice_id: params.voiceId || 'ara',
        ...(language ? { language } : {}),
      }),
      signal: AbortSignal.timeout(30000),
    });
  } catch (err) {
    throw normalizeToAppError(err, {
      networkCode: ErrorCodes.VOICE_SERVICE_UNAVAILABLE,
      networkCategory: 'voice',
    });
  }

  if (!response.ok) {
    throw await mapUpstreamHttpError(response);
  }

  const audioBuffer = await response.arrayBuffer();
  const contentType = response.headers.get('content-type') || 'audio/mpeg';
  return { audioBuffer, contentType };
}

/**
 * Fetches available voices from `GET /v1/tts/voices`.
 */
export async function fetchAvailableVoices(
  config: VoiceApiConfig,
): Promise<Array<{ id: string; label: string; description: string }>> {
  const defaultVoices = [
    { id: 'ara', label: 'Ara', description: 'Warm and conversational' },
    { id: 'sal', label: 'Sal', description: 'Smooth and balanced' },
    { id: 'rex', label: 'Rex', description: 'Clear and professional' },
    { id: 'eve', label: 'Eve', description: 'Energetic and expressive' },
    { id: 'leo', label: 'Leo', description: 'Calm and authoritative' },
  ];

  if (!config.apiKey.trim()) return defaultVoices;

  const fetchImpl = config.fetchImpl ?? fetch;
  const url = `${normalizeBaseUrl(config.baseUrl)}/tts/voices`;

  try {
    const response = await fetchImpl(url, {
      method: 'GET',
      headers: { Authorization: `Bearer ${config.apiKey}` },
      signal: AbortSignal.timeout(8000),
    });
    if (!response.ok) return defaultVoices;

    const json = (await response.json()) as Record<string, unknown>;
    const rawList = Array.isArray(json.voices)
      ? json.voices
      : Array.isArray(json)
        ? json
        : [];
    const parsed: Array<{ id: string; label: string; description: string }> = [];

    for (const item of rawList) {
      if (!item || typeof item !== 'object') continue;
      const rec = item as Record<string, unknown>;
      const id = String(rec.voice_id ?? rec.id ?? rec.name ?? '').trim();
      if (!id) continue;
      const label = String(rec.name ?? id).trim();
      const description = String(rec.description ?? 'Grok Voice').trim();
      parsed.push({ id, label, description });
    }

    return parsed.length > 0 ? parsed : defaultVoices;
  } catch {
    return defaultVoices;
  }
}

/**
 * Alternative Speech-to-Text proxy calling `POST /v1/stt` (multipart/form-data).
 */
export async function transcribeSpeech(
  config: VoiceApiConfig,
  params: {
    audioBytes: Uint8Array;
    filename: string;
    mimeType: string;
    languageMode?: LanguageMode;
  },
): Promise<SttTranscriptionResult> {
  if (!config.apiKey.trim()) {
    throw new AppError({
      code: ErrorCodes.INVALID_API_KEY,
      category: 'api',
      statusCode: 502,
    });
  }

  const fetchImpl = config.fetchImpl ?? fetch;
  const url = `${normalizeBaseUrl(config.baseUrl)}/stt`;

  const form = new FormData();
  form.append('model', 'grok-voice-transcribe-2.0');
  const language = mapLanguageHint(params.languageMode);
  if (language) {
    form.append('language', language);
  }
  form.append('format', 'true');
  const blobCopy = new Uint8Array(params.audioBytes.byteLength);
  blobCopy.set(params.audioBytes);
  form.append(
    'file',
    new Blob([blobCopy], { type: params.mimeType || 'audio/webm' }),
    params.filename || 'recording.webm',
  );

  let response: Response;
  try {
    response = await fetchImpl(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${config.apiKey}`,
      },
      body: form,
      signal: AbortSignal.timeout(30000),
    });
  } catch (err) {
    throw normalizeToAppError(err, {
      networkCode: ErrorCodes.VOICE_SERVICE_UNAVAILABLE,
      networkCategory: 'voice',
    });
  }

  if (!response.ok) {
    throw await mapUpstreamHttpError(response);
  }

  const json = (await response.json()) as Record<string, unknown>;
  const text = typeof json.text === 'string' ? json.text : '';
  const detectedLang = typeof json.language === 'string' ? json.language : undefined;
  return { text, ...(detectedLang ? { language: detectedLang } : {}) };
}

/**
 * Free-tier Speech-to-Text via Groq's OpenAI-compatible `whisper-large-v3-turbo` endpoint.
 */
export async function transcribeSpeechWithGroqFree(
  config: { apiKey: string; baseUrl?: string; fetchImpl?: typeof fetch },
  params: {
    audioBytes: Uint8Array;
    filename: string;
    mimeType: string;
    languageMode?: LanguageMode;
  },
): Promise<SttTranscriptionResult> {
  if (!config.apiKey.trim()) {
    throw new AppError({
      code: ErrorCodes.INVALID_API_KEY,
      category: 'api',
      statusCode: 502,
    });
  }

  const fetchImpl = config.fetchImpl ?? fetch;
  const base = normalizeBaseUrl(config.baseUrl ?? 'https://api.groq.com/openai/v1');
  const form = new FormData();
  form.append('model', 'whisper-large-v3-turbo');
  const language = mapLanguageHint(params.languageMode);
  if (language) {
    form.append('language', language);
  }
  const blobCopy = new Uint8Array(params.audioBytes.byteLength);
  blobCopy.set(params.audioBytes);
  form.append(
    'file',
    new Blob([blobCopy], { type: params.mimeType || 'audio/webm' }),
    params.filename || 'recording.webm',
  );

  let response: Response;
  try {
    response = await fetchImpl(`${base}/audio/transcriptions`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${config.apiKey}` },
      body: form,
      signal: AbortSignal.timeout(30000),
    });
  } catch (err) {
    throw normalizeToAppError(err, {
      networkCode: ErrorCodes.VOICE_SERVICE_UNAVAILABLE,
      networkCategory: 'voice',
    });
  }

  if (!response.ok) {
    throw await mapUpstreamHttpError(response);
  }

  const json = (await response.json()) as Record<string, unknown>;
  return {
    text: typeof json.text === 'string' ? json.text : '',
    ...(typeof json.language === 'string' ? { language: json.language } : {}),
    modelUsed: 'whisper-large-v3-turbo',
    isFree: true,
  };
}

function resolveGeminiOrigin(baseUrl?: string): string {
  if (!baseUrl) return 'https://generativelanguage.googleapis.com';
  try {
    const u = new URL(baseUrl);
    return `${u.protocol}//${u.host}`;
  } catch {
    return 'https://generativelanguage.googleapis.com';
  }
}

function mapGeminiVoiceName(voiceId: string | undefined): string {
  switch ((voiceId ?? '').trim().toLowerCase()) {
    case 'sal':
      return 'Charon';
    case 'rex':
      return 'Fenrir';
    case 'eve':
      return 'Kore';
    case 'leo':
      return 'Puck';
    case 'aoede':
    case 'charon':
    case 'fenrir':
    case 'kore':
    case 'puck':
    case 'zephyr':
      return voiceId!.trim().charAt(0).toUpperCase() + voiceId!.trim().slice(1).toLowerCase();
    case 'ara':
    default:
      return 'Aoede';
  }
}

function encodePcm16MonoToWav(pcmBytes: Uint8Array, sampleRate = 24000): ArrayBuffer {
  const headerSize = 44;
  const out = new ArrayBuffer(headerSize + pcmBytes.byteLength);
  const view = new DataView(out);
  const writeStr = (offset: number, str: string) => {
    for (let i = 0; i < str.length; i++) {
      view.setUint8(offset + i, str.charCodeAt(i));
    }
  };
  writeStr(0, 'RIFF');
  view.setUint32(4, 36 + pcmBytes.byteLength, true);
  writeStr(8, 'WAVE');
  writeStr(12, 'fmt ');
  view.setUint32(16, 16, true); // PCM fmt chunk size
  view.setUint16(20, 1, true); // PCM format
  view.setUint16(22, 1, true); // mono
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true); // byte rate
  view.setUint16(32, 2, true); // block align
  view.setUint16(34, 16, true); // bits per sample
  writeStr(36, 'data');
  view.setUint32(40, pcmBytes.byteLength, true);
  new Uint8Array(out, headerSize).set(pcmBytes);
  return out;
}

/**
 * Mints a single-use short-lived Gemini Live ephemeral token server-side via
 * `POST /v1alpha/auth_tokens` so `GEMINI_API_KEY` never reaches the browser.
 */
export async function createGeminiLiveEphemeralToken(
  config: { apiKey: string; baseUrl?: string; model?: string; paidTier?: boolean; fetchImpl?: typeof fetch },
  ttlSeconds = 1800,
): Promise<EphemeralSecretResult> {
  if (!config.apiKey.trim()) {
    throw new AppError({
      code: ErrorCodes.INVALID_API_KEY,
      category: 'api',
      statusCode: 502,
    });
  }

  const fetchImpl = config.fetchImpl ?? fetch;
  const origin = resolveGeminiOrigin(config.baseUrl);
  const liveModel = (config.model ?? '').trim() || GEMINI_LIVE_DEFAULT_MODEL;
  const normalizedModel = liveModel.startsWith('models/') ? liveModel : `models/${liveModel}`;
  const nowMs = Date.now();
  const clampedTtl = Math.max(60, Math.min(ttlSeconds, 1800));
  const expireTime = new Date(nowMs + clampedTtl * 1000).toISOString();
  const newSessionExpireTime = new Date(nowMs + 120 * 1000).toISOString();

  let response: Response;
  try {
    response = await fetchImpl(`${origin}/v1alpha/auth_tokens`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-goog-api-key': config.apiKey,
      },
      body: JSON.stringify({
        uses: 1,
        expireTime,
        newSessionExpireTime,
        liveConnectConstraints: {
          model: normalizedModel,
          config: {
            responseModalities: ['AUDIO'],
          },
        },
      }),
      signal: AbortSignal.timeout(15000),
    });
  } catch (err) {
    throw normalizeToAppError(err, {
      networkCode: ErrorCodes.VOICE_SERVICE_UNAVAILABLE,
      networkCategory: 'voice',
    });
  }

  if (!response.ok) {
    throw await mapUpstreamHttpError(response, 'gemini');
  }

  const json = (await response.json()) as Record<string, unknown>;
  const token =
    typeof json.name === 'string' && json.name.trim()
      ? json.name.trim()
      : typeof json.token === 'string' && json.token.trim()
        ? json.token.trim()
        : '';

  if (!token) {
    throw new AppError({
      code: ErrorCodes.VOICE_SERVICE_UNAVAILABLE,
      category: 'voice',
      statusCode: 502,
      message: 'service unavailable',
      upstreamDiagnostic: 'Gemini v1alpha/auth_tokens returned empty token name',
    });
  }

  return {
    token,
    expiresAt: Math.floor((nowMs + clampedTtl * 1000) / 1000),
    protocol: 'gemini-live',
    realtimeUrl: GEMINI_LIVE_WS_URL,
    model: liveModel,
  };
}

/**
 * Generates spoken audio using Gemini TTS (`gemini-2.5-flash-preview-tts`) on the server.
 */
export async function synthesizeSpeechWithGemini(
  config: { apiKey: string; baseUrl?: string; model?: string; paidTier?: boolean; fetchImpl?: typeof fetch },
  params: {
    text: string;
    voiceId?: string;
    languageMode?: LanguageMode;
  },
): Promise<TtsSynthesisResult> {
  if (!config.apiKey.trim()) {
    throw new AppError({
      code: ErrorCodes.INVALID_API_KEY,
      category: 'api',
      statusCode: 502,
    });
  }

  const fetchImpl = config.fetchImpl ?? fetch;
  const origin = resolveGeminiOrigin(config.baseUrl);
  const ttsModel = (config.model ?? '').trim() || GEMINI_TTS_DEFAULT_MODEL;
  const voiceName = mapGeminiVoiceName(params.voiceId);

  let response: Response;
  try {
    response = await fetchImpl(
      `${origin}/v1beta/models/${encodeURIComponent(ttsModel)}:generateContent`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-goog-api-key': config.apiKey,
        },
        body: JSON.stringify({
          contents: [{ parts: [{ text: params.text }] }],
          generationConfig: {
            responseModalities: ['AUDIO'],
            speechConfig: {
              voiceConfig: {
                prebuiltVoiceConfig: { voiceName },
              },
            },
          },
        }),
        signal: AbortSignal.timeout(30000),
      },
    );
  } catch (err) {
    throw normalizeToAppError(err, {
      networkCode: ErrorCodes.VOICE_SERVICE_UNAVAILABLE,
      networkCategory: 'voice',
    });
  }

  if (!response.ok) {
    throw await mapUpstreamHttpError(response, 'gemini');
  }

  const json = (await response.json()) as {
    candidates?: Array<{
      content?: {
        parts?: Array<{ inlineData?: { mimeType?: string; data?: string } }>;
      };
    }>;
  };
  const parts = json.candidates?.[0]?.content?.parts ?? [];
  const audioPart = parts.find((p) => typeof p.inlineData?.data === 'string' && p.inlineData.data.length > 0);
  const rawB64 = audioPart?.inlineData?.data;
  if (!rawB64) {
    throw new AppError({
      code: ErrorCodes.VOICE_SERVICE_UNAVAILABLE,
      category: 'voice',
      statusCode: 502,
      message: 'service unavailable',
      upstreamDiagnostic: 'Gemini TTS returned no inline audio data',
    });
  }

  const rawBytes = new Uint8Array(Buffer.from(rawB64, 'base64'));
  const mime = (audioPart?.inlineData?.mimeType ?? 'audio/L16;rate=24000').toLowerCase();
  const rateMatch = /rate=(\d+)/.exec(mime);
  const sampleRate = rateMatch?.[1] ? Number(rateMatch[1]) : 24000;

  if (mime.includes('wav') || mime.includes('mpeg') || mime.includes('mp3') || mime.includes('ogg')) {
    const copy = new Uint8Array(rawBytes.byteLength);
    copy.set(rawBytes);
    return {
      audioBuffer: copy.buffer,
      contentType: mime,
      modelUsed: ttsModel,
      isFree: !(config.paidTier ?? false),
    };
  }

  return {
    audioBuffer: encodePcm16MonoToWav(rawBytes, Number.isFinite(sampleRate) ? sampleRate : 24000),
    contentType: 'audio/wav',
    modelUsed: ttsModel,
    isFree: !(config.paidTier ?? false),
  };
}

/**
 * Speech-to-Text transcription via Gemini multimodal `generateContent` (free tier).
 */
export async function transcribeSpeechWithGemini(
  config: { apiKey: string; baseUrl?: string; model?: string; paidTier?: boolean; fetchImpl?: typeof fetch },
  params: {
    audioBytes: Uint8Array;
    mimeType: string;
    languageMode?: LanguageMode;
  },
): Promise<SttTranscriptionResult> {
  if (!config.apiKey.trim()) {
    throw new AppError({
      code: ErrorCodes.INVALID_API_KEY,
      category: 'api',
      statusCode: 502,
    });
  }

  const fetchImpl = config.fetchImpl ?? fetch;
  const origin = resolveGeminiOrigin(config.baseUrl);
  const sttModel = (config.model ?? '').trim() || 'gemini-2.5-flash';
  const langHint =
    params.languageMode === 'bn'
      ? 'Bengali (বাংলা)'
      : params.languageMode === 'en'
        ? 'English'
        : 'English, Bengali, or Banglish';
  const audioBase64 = Buffer.from(params.audioBytes).toString('base64');

  let response: Response;
  try {
    response = await fetchImpl(
      `${origin}/v1beta/models/${encodeURIComponent(sttModel)}:generateContent`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-goog-api-key': config.apiKey,
        },
        body: JSON.stringify({
          contents: [
            {
              parts: [
                {
                  inlineData: {
                    mimeType: params.mimeType || 'audio/webm',
                    data: audioBase64,
                  },
                },
                {
                  text: `Transcribe the spoken audio accurately in ${langHint}. Return only the exact transcript text without quotes or commentary.`,
                },
              ],
            },
          ],
        }),
        signal: AbortSignal.timeout(30000),
      },
    );
  } catch (err) {
    throw normalizeToAppError(err, {
      networkCode: ErrorCodes.VOICE_SERVICE_UNAVAILABLE,
      networkCategory: 'voice',
    });
  }

  if (!response.ok) {
    throw await mapUpstreamHttpError(response, 'gemini');
  }

  const json = (await response.json()) as {
    candidates?: Array<{
      content?: { parts?: Array<{ text?: string }> };
    }>;
  };
  const text = (json.candidates?.[0]?.content?.parts ?? [])
    .map((p) => (typeof p.text === 'string' ? p.text : ''))
    .join('')
    .trim();

  return {
    text,
    ...(params.languageMode === 'bn' || params.languageMode === 'en'
      ? { language: params.languageMode }
      : {}),
    modelUsed: sttModel,
    isFree: !(config.paidTier ?? false),
  };
}
