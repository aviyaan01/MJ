import {
  AppError,
  ErrorCodes,
  sanitizeDiagnosticText,
  type ReasoningEffort,
  type TokenUsage,
} from '@mj/shared';
import {
  SseFrameParser,
  extractOutputTextFromResponse,
  extractUsageFromResponse,
  parseXaiResponsesStreamFrame,
} from './streamParser.js';

export interface XaiTurnInput {
  role: 'user' | 'assistant';
  content: string;
}

export interface XaiClientConfig {
  apiKey: string;
  baseUrl: string;
  defaultModel: string;
  timeoutMs: number;
  maxRetries?: number;
  fetchImpl?: typeof fetch;
}

export interface CreateResponseParams {
  model?: string;
  instructions: string;
  input: XaiTurnInput[];
  reasoningEffort?: ReasoningEffort;
  maxOutputTokens?: number;
  stream: boolean;
  timeoutMs?: number;
  signal?: AbortSignal;
  onStatus?: (phase: 'connecting' | 'reasoning' | 'streaming', detail: string) => void;
  onDelta?: (delta: string) => void;
}

export interface CreateResponseResult {
  responseId?: string;
  text: string;
  model: string;
  usage: TokenUsage;
  latencyMs: number;
}

/**
 * xAI Responses API (`POST /v1/responses`) client with centralized error mapping,
 * bounded exponential-backoff-with-jitter retries, and SSE streaming support.
 */
export class XaiResponsesClient {
  private readonly apiKey: string;
  private readonly responsesUrl: string;
  private readonly defaultModel: string;
  private readonly defaultTimeoutMs: number;
  private readonly maxRetries: number;
  private readonly fetchImpl: typeof fetch;

  constructor(config: XaiClientConfig) {
    this.apiKey = config.apiKey;
    const normalizedBase = config.baseUrl.replace(/\/+$/, '');
    this.responsesUrl = normalizedBase.endsWith('/responses')
      ? normalizedBase
      : `${normalizedBase}/responses`;
    this.defaultModel = config.defaultModel;
    this.defaultTimeoutMs = config.timeoutMs;
    this.maxRetries = Math.max(0, Math.min(config.maxRetries ?? 2, 4));
    this.fetchImpl = config.fetchImpl ?? fetch;
  }

  public async createResponse(params: CreateResponseParams): Promise<CreateResponseResult> {
    if (!this.apiKey || this.apiKey.trim().length === 0) {
      throw new AppError({
        code: ErrorCodes.INVALID_API_KEY,
        category: 'api',
        statusCode: 502,
      });
    }

    const model = params.model?.trim() || this.defaultModel;
    const timeoutMs = params.timeoutMs ?? this.defaultTimeoutMs;
    const startedAt = Date.now();

    const bodyPayload: Record<string, unknown> = {
      model,
      instructions: params.instructions,
      input: params.input.map((turn) => ({
        role: turn.role,
        content: turn.content,
      })),
      stream: params.stream,
      store: false,
    };

    if (params.maxOutputTokens) {
      bodyPayload.max_output_tokens = params.maxOutputTokens;
    }

    if (params.reasoningEffort) {
      bodyPayload.reasoning = { effort: params.reasoningEffort };
    }

    let lastError: AppError | undefined;

    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      if (params.signal?.aborted) {
        throw new AppError({
          code: ErrorCodes.ABORTED,
          category: 'internal',
          statusCode: 499,
          retryable: false,
        });
      }

      if (attempt > 0 && lastError) {
        const delayMs = computeBackoffDelayMs(attempt - 1, lastError.retryAfterMs);
        params.onStatus?.(
          'connecting',
          `Connection interrupted. Retrying (${attempt}/${this.maxRetries})…`,
        );
        await sleepWithAbort(delayMs, params.signal);
      }

      try {
        return await this.executeAttempt(
          bodyPayload,
          model,
          timeoutMs,
          startedAt,
          params,
        );
      } catch (err) {
        const appErr = normalizeToAppError(err);

        // If the selected model does not accept the optional `reasoning` field,
        // retry once cleanly without `reasoning` before failing.
        if (
          appErr.code === ErrorCodes.INVALID_REQUEST &&
          bodyPayload.reasoning !== undefined &&
          appErr.message.toLowerCase().includes('reasoning')
        ) {
          delete bodyPayload.reasoning;
          continue;
        }

        lastError = appErr;
        if (!appErr.retryable || attempt >= this.maxRetries) {
          throw appErr;
        }
      }
    }

    throw (
      lastError ??
      new AppError({
        code: ErrorCodes.UPSTREAM_ERROR,
        category: 'api',
      })
    );
  }

  private async executeAttempt(
    bodyPayload: Record<string, unknown>,
    model: string,
    timeoutMs: number,
    startedAt: number,
    params: CreateResponseParams,
  ): Promise<CreateResponseResult> {
    const attemptController = new AbortController();
    let timedOut = false;

    const timeoutTimer = setTimeout(() => {
      timedOut = true;
      attemptController.abort(new Error('Request timed out'));
    }, timeoutMs);

    const onExternalAbort = () => {
      attemptController.abort(params.signal?.reason);
    };

    if (params.signal) {
      if (params.signal.aborted) {
        clearTimeout(timeoutTimer);
        throw new AppError({
          code: ErrorCodes.ABORTED,
          category: 'internal',
          statusCode: 499,
          retryable: false,
        });
      }
      params.signal.addEventListener('abort', onExternalAbort, { once: true });
    }

    try {
      params.onStatus?.('connecting', 'Connecting to Grok…');

      const response = await this.fetchImpl(this.responsesUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: params.stream ? 'text/event-stream' : 'application/json',
          Authorization: `Bearer ${this.apiKey}`,
        },
        body: JSON.stringify(bodyPayload),
        signal: attemptController.signal,
      });

      if (!response.ok) {
        throw await mapUpstreamHttpError(response);
      }

      if (!params.stream) {
        const json = (await response.json()) as Record<string, unknown>;
        const text = extractOutputTextFromResponse(json);
        const usage = extractUsageFromResponse(json.usage) ?? emptyUsage();
        const responseId = typeof json.id === 'string' ? json.id : undefined;

        if (text) {
          params.onDelta?.(text);
        }

        return {
          ...(responseId ? { responseId } : {}),
          text,
          model: typeof json.model === 'string' ? json.model : model,
          usage,
          latencyMs: Date.now() - startedAt,
        };
      }

      if (!response.body) {
        throw new AppError({
          code: ErrorCodes.UPSTREAM_ERROR,
          category: 'api',
          message: 'Grok returned an empty response stream.',
          retryable: true,
        });
      }

      const reader = response.body.getReader();
      const parser = new SseFrameParser();
      let accumulatedText = '';
      let responseId: string | undefined;
      let usage: TokenUsage | undefined;
      let streamedAnyDelta = false;

      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          if (!value) continue;

          const frames = parser.push(value);
          for (const frame of frames) {
            const events = parseXaiResponsesStreamFrame(frame);
            for (const ev of events) {
              if (ev.type === 'meta' && ev.responseId) {
                responseId = ev.responseId;
              } else if (ev.type === 'status') {
                params.onStatus?.(ev.phase, ev.detail);
              } else if (ev.type === 'delta') {
                if (!streamedAnyDelta) {
                  params.onStatus?.('streaming', 'Receiving response…');
                }
                streamedAnyDelta = true;
                accumulatedText += ev.text;
                params.onDelta?.(ev.text);
              } else if (ev.type === 'completed') {
                if (ev.responseId) responseId = ev.responseId;
                if (ev.usage) usage = ev.usage;
                if (!streamedAnyDelta && ev.fullText) {
                  accumulatedText = ev.fullText;
                  params.onDelta?.(ev.fullText);
                }
              }
            }
          }
        }

        const trailingFrames = parser.finish();
        for (const frame of trailingFrames) {
          const events = parseXaiResponsesStreamFrame(frame);
          for (const ev of events) {
            if (ev.type === 'delta') {
              streamedAnyDelta = true;
              accumulatedText += ev.text;
              params.onDelta?.(ev.text);
            } else if (ev.type === 'completed') {
              if (ev.responseId) responseId = ev.responseId;
              if (ev.usage) usage = ev.usage;
              if (!streamedAnyDelta && ev.fullText) {
                accumulatedText = ev.fullText;
                params.onDelta?.(ev.fullText);
              }
            }
          }
        }
      } catch (streamErr) {
        const mapped = normalizeToAppError(streamErr, {
          timedOut,
          externalAborted: params.signal?.aborted ?? false,
        });
        // Never retry once partial text has already been streamed to the client
        if (streamedAnyDelta && mapped.retryable) {
          throw new AppError({
            code: mapped.code,
            category: mapped.category,
            statusCode: mapped.statusCode,
            message: mapped.message,
            retryable: false,
            cause: mapped,
          });
        }
        throw mapped;
      } finally {
        reader.releaseLock();
      }

      return {
        ...(responseId ? { responseId } : {}),
        text: accumulatedText,
        model,
        usage: usage ?? emptyUsage(),
        latencyMs: Date.now() - startedAt,
      };
    } catch (err) {
      throw normalizeToAppError(err, {
        timedOut,
        externalAborted: params.signal?.aborted ?? false,
      });
    } finally {
      clearTimeout(timeoutTimer);
      params.signal?.removeEventListener('abort', onExternalAbort);
    }
  }
}

export async function mapUpstreamHttpError(response: Response): Promise<AppError> {
  let rawBodyText = '';
  try {
    rawBodyText = await response.text();
  } catch {
    rawBodyText = '';
  }

  let upstreamMsg = '';
  let upstreamCode = '';

  try {
    const parsed = JSON.parse(rawBodyText) as Record<string, unknown>;
    const errObj =
      parsed.error && typeof parsed.error === 'object'
        ? (parsed.error as Record<string, unknown>)
        : parsed;
    if (typeof errObj.message === 'string') {
      upstreamMsg = errObj.message;
    }
    if (typeof errObj.code === 'string') {
      upstreamCode = errObj.code;
    }
  } catch {
    upstreamMsg = rawBodyText.slice(0, 300);
  }

  const lowerMsg = `${upstreamCode} ${upstreamMsg}`.toLowerCase();
  const retryAfterHeader = response.headers.get('retry-after');
  const retryAfterMs = parseRetryAfterMs(retryAfterHeader);

  if (response.status === 401 || lowerMsg.includes('invalid api key') || lowerMsg.includes('incorrect api key')) {
    return new AppError({
      code: ErrorCodes.INVALID_API_KEY,
      category: 'api',
      statusCode: 502,
      retryable: false,
    });
  }

  if (
    response.status === 402 ||
    lowerMsg.includes('credit') ||
    lowerMsg.includes('quota') ||
    lowerMsg.includes('billing') ||
    lowerMsg.includes('insufficient')
  ) {
    return new AppError({
      code: ErrorCodes.INSUFFICIENT_CREDITS,
      category: 'api',
      statusCode: 402,
      retryable: false,
    });
  }

  if (response.status === 403) {
    return new AppError({
      code: ErrorCodes.UNAUTHORIZED,
      category: 'api',
      statusCode: 403,
      retryable: false,
      message: 'xAI rejected this request as unauthorized. Verify account permissions and key scope.',
    });
  }

  if (response.status === 429) {
    return new AppError({
      code: ErrorCodes.RATE_LIMITED,
      category: 'api',
      statusCode: 429,
      retryable: true,
      retryAfterMs,
    });
  }

  if (
    response.status === 404 ||
    (lowerMsg.includes('model') &&
      (lowerMsg.includes('not found') ||
        lowerMsg.includes('does not exist') ||
        lowerMsg.includes('unavailable')))
  ) {
    return new AppError({
      code: ErrorCodes.MODEL_UNAVAILABLE,
      category: 'api',
      statusCode: 404,
      retryable: false,
      message: upstreamMsg ? `Model unavailable: ${sanitizeDiagnosticText(upstreamMsg)}` : undefined,
    });
  }

  if (response.status === 400 || response.status === 422) {
    return new AppError({
      code: ErrorCodes.INVALID_REQUEST,
      category: 'api',
      statusCode: 400,
      retryable: false,
      message: upstreamMsg ? sanitizeDiagnosticText(upstreamMsg) : undefined,
    });
  }

  if (response.status >= 500) {
    return new AppError({
      code: ErrorCodes.UPSTREAM_ERROR,
      category: 'api',
      statusCode: 502,
      retryable: true,
    });
  }

  return new AppError({
    code: ErrorCodes.UPSTREAM_ERROR,
    category: 'api',
    statusCode: 502,
    retryable: false,
    message: upstreamMsg ? sanitizeDiagnosticText(upstreamMsg) : undefined,
  });
}

function normalizeToAppError(
  err: unknown,
  context: { timedOut?: boolean; externalAborted?: boolean } = {},
): AppError {
  if (err instanceof AppError) {
    return err;
  }

  if (context.externalAborted) {
    return new AppError({
      code: ErrorCodes.ABORTED,
      category: 'internal',
      statusCode: 499,
      retryable: false,
      cause: err,
    });
  }

  if (context.timedOut) {
    return new AppError({
      code: ErrorCodes.TIMEOUT,
      category: 'network',
      statusCode: 504,
      retryable: true,
      cause: err,
    });
  }

  if (err instanceof Error) {
    if (err.name === 'AbortError') {
      return new AppError({
        code: ErrorCodes.ABORTED,
        category: 'internal',
        statusCode: 499,
        retryable: false,
        cause: err,
      });
    }
    if (err.name === 'TimeoutError') {
      return new AppError({
        code: ErrorCodes.TIMEOUT,
        category: 'network',
        statusCode: 504,
        retryable: true,
        cause: err,
      });
    }

    const msg = `${err.message} ${extractNestedErrorCode(err)}`.toLowerCase();
    if (
      msg.includes('fetch failed') ||
      msg.includes('econnrefused') ||
      msg.includes('enotfound') ||
      msg.includes('eai_again') ||
      msg.includes('etimedout') ||
      msg.includes('econnreset') ||
      msg.includes('network') ||
      msg.includes('socket') ||
      msg.includes('und_err')
    ) {
      return new AppError({
        code: ErrorCodes.NETWORK_DISCONNECTED,
        category: 'network',
        statusCode: 503,
        retryable: true,
        cause: err,
      });
    }
  }

  return new AppError({
    code: ErrorCodes.INTERNAL_ERROR,
    category: 'internal',
    statusCode: 500,
    retryable: false,
    cause: err,
  });
}

function extractNestedErrorCode(err: Error): string {
  const cause = (err as Error & { cause?: unknown }).cause;
  if (cause && typeof cause === 'object') {
    const rec = cause as Record<string, unknown>;
    return `${String(rec.code ?? '')} ${String(rec.message ?? '')}`;
  }
  return '';
}

function parseRetryAfterMs(headerValue: string | null): number | undefined {
  if (!headerValue) return undefined;
  const seconds = Number(headerValue);
  if (Number.isFinite(seconds) && seconds >= 0) {
    return Math.min(Math.round(seconds * 1000), 10_000);
  }
  const dateMs = Date.parse(headerValue);
  if (!Number.isNaN(dateMs)) {
    return Math.min(Math.max(0, dateMs - Date.now()), 10_000);
  }
  return undefined;
}

export function computeBackoffDelayMs(attemptIndex: number, retryAfterMs?: number): number {
  if (retryAfterMs !== undefined && retryAfterMs > 0) {
    const jitter = Math.round(Math.random() * 250);
    return Math.min(retryAfterMs + jitter, 10_000);
  }
  const baseMs = 450;
  const maxMs = 4500;
  const exp = Math.min(maxMs, baseMs * Math.pow(2, attemptIndex));
  return Math.round(exp * (0.5 + Math.random() * 0.5));
}

function sleepWithAbort(ms: number, signal?: AbortSignal): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(
        new AppError({
          code: ErrorCodes.ABORTED,
          category: 'internal',
          statusCode: 499,
          retryable: false,
        }),
      );
      return;
    }

    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);

    const onAbort = () => {
      clearTimeout(timer);
      reject(
        new AppError({
          code: ErrorCodes.ABORTED,
          category: 'internal',
          statusCode: 499,
          retryable: false,
        }),
      );
    };

    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

function emptyUsage(): TokenUsage {
  return {
    inputTokens: 0,
    outputTokens: 0,
    reasoningTokens: 0,
    cachedTokens: 0,
    totalTokens: 0,
  };
}
