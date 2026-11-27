import { AppError, ErrorCodes, type TokenUsage } from '@mj/shared';

export type ParsedSseEvent =
  | { type: 'meta'; responseId?: string; status?: string }
  | { type: 'status'; phase: 'connecting' | 'reasoning' | 'streaming'; detail: string }
  | { type: 'delta'; text: string }
  | { type: 'completed'; responseId?: string; fullText?: string; usage?: TokenUsage };

export interface RawSseFrame {
  event?: string;
  data: string;
}

/**
 * Incremental Server-Sent Events (SSE) parser supporting arbitrary byte chunk
 * boundaries and both LF and CRLF line endings.
 */
export class SseFrameParser {
  private buffer = '';
  private readonly decoder = new TextDecoder('utf-8');

  public push(chunk: Uint8Array): RawSseFrame[] {
    this.buffer += this.decoder.decode(chunk, { stream: true });
    return this.drainFrames(false);
  }

  public finish(): RawSseFrame[] {
    this.buffer += this.decoder.decode();
    return this.drainFrames(true);
  }

  private drainFrames(flushTrailing: boolean): RawSseFrame[] {
    const frames: RawSseFrame[] = [];
    const normalized = this.buffer.replace(/\r\n/g, '\n');
    const parts = normalized.split('\n\n');

    if (flushTrailing) {
      this.buffer = '';
    } else {
      this.buffer = parts.pop() ?? '';
    }

    for (const rawBlock of parts) {
      const trimmedBlock = rawBlock.trim();
      if (!trimmedBlock) continue;

      let eventName: string | undefined;
      const dataLines: string[] = [];

      for (const line of rawBlock.split('\n')) {
        if (line.startsWith(':')) continue;
        if (line.startsWith('event:')) {
          eventName = line.slice(6).trim();
        } else if (line.startsWith('data:')) {
          dataLines.push(line.slice(5).trimStart());
        }
      }

      if (dataLines.length > 0) {
        frames.push({
          ...(eventName ? { event: eventName } : {}),
          data: dataLines.join('\n'),
        });
      }
    }

    return frames;
  }
}

export function extractUsageFromResponse(rawUsage: unknown): TokenUsage | undefined {
  if (!rawUsage || typeof rawUsage !== 'object') return undefined;
  const u = rawUsage as Record<string, unknown>;

  const inputTokens = toNumber(u.input_tokens ?? u.prompt_tokens);
  const outputTokens = toNumber(u.output_tokens ?? u.completion_tokens);

  const outputDetails =
    u.output_tokens_details && typeof u.output_tokens_details === 'object'
      ? (u.output_tokens_details as Record<string, unknown>)
      : undefined;
  const inputDetails =
    u.input_tokens_details && typeof u.input_tokens_details === 'object'
      ? (u.input_tokens_details as Record<string, unknown>)
      : undefined;

  const reasoningTokens = toNumber(outputDetails?.reasoning_tokens ?? u.reasoning_tokens);
  const cachedTokens = toNumber(inputDetails?.cached_tokens ?? u.cached_tokens);
  const totalTokens = toNumber(u.total_tokens) || inputTokens + outputTokens;

  return {
    inputTokens,
    outputTokens,
    reasoningTokens,
    cachedTokens,
    totalTokens,
  };
}

export function extractOutputTextFromResponse(responseObj: unknown): string {
  if (!responseObj || typeof responseObj !== 'object') return '';
  const obj = responseObj as Record<string, unknown>;

  if (typeof obj.output_text === 'string' && obj.output_text.length > 0) {
    return obj.output_text;
  }

  if (!Array.isArray(obj.output)) return '';
  const chunks: string[] = [];

  for (const item of obj.output) {
    if (!item || typeof item !== 'object') continue;
    const itemRec = item as Record<string, unknown>;
    if (itemRec.type !== 'message' || !Array.isArray(itemRec.content)) continue;

    for (const part of itemRec.content) {
      if (!part || typeof part !== 'object') continue;
      const partRec = part as Record<string, unknown>;
      if (
        (partRec.type === 'output_text' || partRec.type === 'text') &&
        typeof partRec.text === 'string'
      ) {
        chunks.push(partRec.text);
      }
    }
  }

  return chunks.join('');
}

/**
 * Translates an xAI `/v1/responses` SSE JSON event into normalized stream events.
 */
export function parseXaiResponsesStreamFrame(frame: RawSseFrame): ParsedSseEvent[] {
  if (frame.data === '[DONE]') {
    return [];
  }

  let payload: Record<string, unknown>;
  try {
    payload = JSON.parse(frame.data) as Record<string, unknown>;
  } catch {
    return [];
  }

  const eventType =
    (typeof payload.type === 'string' ? payload.type : undefined) ?? frame.event ?? '';

  if (eventType === 'response.created' || eventType === 'response.in_progress') {
    const resp = isRecord(payload.response) ? payload.response : payload;
    const responseId = typeof resp.id === 'string' ? resp.id : undefined;
    return [
      { type: 'meta', ...(responseId ? { responseId } : {}), status: eventType },
      {
        type: 'status',
        phase: 'connecting',
        detail: 'Connected to Grok. Preparing response…',
      },
    ];
  }

  if (
    eventType === 'response.reasoning_summary_text.delta' ||
    eventType === 'response.reasoning.delta'
  ) {
    return [
      {
        type: 'status',
        phase: 'reasoning',
        detail: 'Analyzing request…',
      },
    ];
  }

  if (eventType === 'response.output_text.delta') {
    const delta = typeof payload.delta === 'string' ? payload.delta : '';
    if (!delta) return [];
    return [{ type: 'delta', text: delta }];
  }

  if (eventType === 'response.completed' || eventType === 'response.done') {
    const resp = isRecord(payload.response) ? payload.response : payload;
    const responseId = typeof resp.id === 'string' ? resp.id : undefined;
    const fullText = extractOutputTextFromResponse(resp);
    const usage = extractUsageFromResponse(resp.usage);
    return [
      {
        type: 'completed',
        ...(responseId ? { responseId } : {}),
        ...(fullText ? { fullText } : {}),
        ...(usage ? { usage } : {}),
      },
    ];
  }

  if (eventType === 'response.failed' || eventType === 'error') {
    const errObj = isRecord(payload.error)
      ? payload.error
      : isRecord(payload.response) && isRecord(payload.response.error)
        ? payload.response.error
        : payload;
    const errMessage =
      typeof errObj.message === 'string'
        ? errObj.message
        : 'Grok stream ended with an upstream error.';
    const rawCode = typeof errObj.code === 'string' ? errObj.code.toLowerCase() : '';

    if (rawCode.includes('rate_limit')) {
      throw new AppError({
        code: ErrorCodes.RATE_LIMITED,
        category: 'api',
        statusCode: 429,
      });
    }
    if (rawCode.includes('insufficient') || errMessage.toLowerCase().includes('credit')) {
      throw new AppError({
        code: ErrorCodes.INSUFFICIENT_CREDITS,
        category: 'api',
        statusCode: 402,
      });
    }

    throw new AppError({
      code: ErrorCodes.UPSTREAM_ERROR,
      category: 'api',
      statusCode: 502,
      message: `Grok is temporarily unavailable. (${errMessage})`,
    });
  }

  return [];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function toNumber(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}
