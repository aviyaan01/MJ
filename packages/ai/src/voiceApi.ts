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
}

export interface TtsSynthesisResult {
  audioBuffer: ArrayBuffer;
  contentType: string;
}

export interface SttTranscriptionResult {
  text: string;
  language?: string;
}

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
  };
}
