export const XAI_REALTIME_SAMPLE_RATE = 24000;
export const GEMINI_LIVE_INPUT_SAMPLE_RATE = 16000;
export const GEMINI_LIVE_OUTPUT_SAMPLE_RATE = 24000;

/**
 * Linear-interpolation resampler converting browser microphone Float32 PCM
 * (typically 44.1 kHz or 48 kHz) into target rate (24 kHz for Grok Voice).
 */
export function resampleFloat32(
  input: Float32Array,
  fromRate: number,
  toRate: number,
): Float32Array {
  if (fromRate === toRate || input.length === 0) {
    return input;
  }

  const ratio = fromRate / toRate;
  const outputLength = Math.max(1, Math.round(input.length / ratio));
  const output = new Float32Array(outputLength);

  for (let i = 0; i < outputLength; i++) {
    const srcIndex = i * ratio;
    const low = Math.floor(srcIndex);
    const high = Math.min(low + 1, input.length - 1);
    const frac = srcIndex - low;
    const s0 = input[low] ?? 0;
    const s1 = input[high] ?? s0;
    output[i] = s0 + (s1 - s0) * frac;
  }

  return output;
}

/**
 * Encodes Float32 PCM [-1, 1] into little-endian 16-bit PCM base64.
 */
export function float32ToPcm16Base64(samples: Float32Array): string {
  const bytes = new Uint8Array(samples.length * 2);
  const view = new DataView(bytes.buffer);

  for (let i = 0; i < samples.length; i++) {
    const clamped = Math.max(-1, Math.min(1, samples[i] ?? 0));
    const int16 = clamped < 0 ? Math.round(clamped * 0x8000) : Math.round(clamped * 0x7fff);
    view.setInt16(i * 2, int16, true);
  }

  return uint8ToBase64(bytes);
}

/**
 * Decodes little-endian 16-bit PCM base64 into Float32 PCM [-1, 1].
 */
export function pcm16Base64ToFloat32(base64: string): Float32Array<ArrayBuffer> {
  const bytes = base64ToUint8(base64);
  const sampleCount = Math.floor(bytes.byteLength / 2);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const out = new Float32Array(new ArrayBuffer(sampleCount * 4));

  for (let i = 0; i < sampleCount; i++) {
    const int16 = view.getInt16(i * 2, true);
    out[i] = int16 / 32768;
  }

  return out;
}

/**
 * Computes normalized RMS audio amplitude in [0, 1] for honest visualizer feedback.
 */
export function computeRmsLevel(samples: Float32Array): number {
  if (samples.length === 0) return 0;
  let sumSq = 0;
  for (let i = 0; i < samples.length; i++) {
    const v = samples[i] ?? 0;
    sumSq += v * v;
  }
  const rms = Math.sqrt(sumSq / samples.length);
  return Math.min(1, Number((rms * 3.5).toFixed(3)));
}

function uint8ToBase64(bytes: Uint8Array): string {
  let binary = '';
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    const slice = bytes.subarray(i, i + chunkSize);
    binary += String.fromCharCode(...slice);
  }
  return btoa(binary);
}

function base64ToUint8(base64: string): Uint8Array {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}
