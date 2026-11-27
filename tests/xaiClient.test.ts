import { describe, expect, it } from 'vitest';
import { ErrorCodes } from '@mj/shared';
import { XaiResponsesClient, buildMjSystemPrompt } from '@mj/ai';

function sseStreamFromChunks(chunks: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) {
        controller.enqueue(encoder.encode(chunk));
      }
      controller.close();
    },
  });
}

describe('MJ System Prompt (Section 01 & Stage 4 Boundaries)', () => {
  it('enforces MJ Assistant identity and Stage 4 scope boundaries', () => {
    const prompt = buildMjSystemPrompt({ responseStyle: 'concise' });
    expect(prompt).toContain('MJ Assistant');
    expect(prompt).toContain('Never call yourself ChatGPT, JARVIS, Grok');
    expect(prompt).toContain('Stage 4 Scope Boundaries (Important):');
    expect(prompt).toContain('Cross-session long-term memory, AI function calling/tools');
    expect(prompt).toContain('Never execute or suggest arbitrary shell commands');
  });
});

describe('XaiResponsesClient (Section 02 & Section 07)', () => {
  it('calls POST /v1/responses and parses split SSE delta chunks + usage', async () => {
    let capturedUrl = '';
    let capturedHeaders: Record<string, string> = {};
    let capturedBody: Record<string, unknown> = {};

    const mockFetch: typeof fetch = async (input, init) => {
      capturedUrl = String(input);
      capturedHeaders = (init?.headers ?? {}) as Record<string, string>;
      capturedBody = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>;

      const stream = sseStreamFromChunks([
        'event: response.created\ndata: {"type":"response.created","response":{"id":"resp_123"}}\n\n',
        'event: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":"Hello "}\n\n',
        'event: response.output_text.de',
        'lta\ndata: {"type":"response.output_text.delta","delta":"MJ!"}\n\n',
        'event: response.completed\ndata: {"type":"response.completed","response":{"id":"resp_123","usage":{"input_tokens":20,"output_tokens":10,"output_tokens_details":{"reasoning_tokens":3},"input_tokens_details":{"cached_tokens":5},"total_tokens":30}}}\n\n',
      ]);

      return new Response(stream, {
        status: 200,
        headers: { 'Content-Type': 'text/event-stream' },
      });
    };

    const client = new XaiResponsesClient({
      apiKey: 'xai-test-secret-key-123456',
      baseUrl: 'https://api.x.ai/v1',
      defaultModel: 'grok-4.7',
      timeoutMs: 10000,
      fetchImpl: mockFetch,
    });

    const deltas: string[] = [];
    const result = await client.createResponse({
      instructions: 'You are MJ Assistant.',
      input: [{ role: 'user', content: 'Hi MJ' }],
      reasoningEffort: 'medium',
      maxOutputTokens: 1024,
      stream: true,
      onDelta: (d) => deltas.push(d),
    });

    expect(capturedUrl).toBe('https://api.x.ai/v1/responses');
    expect(capturedHeaders.Authorization).toBe('Bearer xai-test-secret-key-123456');
    expect(capturedBody.model).toBe('grok-4.7');
    expect(capturedBody.store).toBe(false);
    expect(capturedBody.reasoning).toEqual({ effort: 'medium' });
    expect(deltas).toEqual(['Hello ', 'MJ!']);
    expect(result.text).toBe('Hello MJ!');
    expect(result.responseId).toBe('resp_123');
    expect(result.usage).toEqual({
      inputTokens: 20,
      outputTokens: 10,
      reasoningTokens: 3,
      cachedTokens: 5,
      totalTokens: 30,
    });
  });

  it('supports non-streaming Responses JSON payloads', async () => {
    const client = new XaiResponsesClient({
      apiKey: 'xai-test-secret-key-123456',
      baseUrl: 'https://api.x.ai/v1',
      defaultModel: 'grok-4.7',
      timeoutMs: 10000,
      fetchImpl: async () =>
        new Response(
          JSON.stringify({
            id: 'resp_nonstream',
            model: 'grok-4.7',
            output: [
              {
                type: 'message',
                role: 'assistant',
                content: [{ type: 'output_text', text: 'Direct reply' }],
              },
            ],
            usage: { input_tokens: 12, output_tokens: 4, total_tokens: 16 },
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        ),
    });

    const result = await client.createResponse({
      instructions: 'System',
      input: [{ role: 'user', content: 'Test' }],
      stream: false,
    });

    expect(result.text).toBe('Direct reply');
    expect(result.usage.totalTokens).toBe(16);
  });

  it('maps API errors cleanly and never retries non-retryable 401/402/404 errors', async () => {
    let calls = 0;
    const client401 = new XaiResponsesClient({
      apiKey: 'xai-bad',
      baseUrl: 'https://api.x.ai/v1',
      defaultModel: 'grok-4.7',
      timeoutMs: 5000,
      maxRetries: 2,
      fetchImpl: async () => {
        calls += 1;
        return new Response(JSON.stringify({ error: { message: 'Invalid API key' } }), {
          status: 401,
        });
      },
    });

    await expect(
      client401.createResponse({
        instructions: 'Sys',
        input: [{ role: 'user', content: 'hi' }],
        stream: true,
      }),
    ).rejects.toMatchObject({ code: ErrorCodes.INVALID_API_KEY, retryable: false });
    expect(calls).toBe(1);

    const client402 = new XaiResponsesClient({
      apiKey: 'xai-key',
      baseUrl: 'https://api.x.ai/v1',
      defaultModel: 'grok-4.7',
      timeoutMs: 5000,
      fetchImpl: async () =>
        new Response(JSON.stringify({ error: { message: 'Insufficient credits' } }), {
          status: 402,
        }),
    });

    await expect(
      client402.createResponse({
        instructions: 'Sys',
        input: [{ role: 'user', content: 'hi' }],
        stream: true,
      }),
    ).rejects.toMatchObject({ code: ErrorCodes.INSUFFICIENT_CREDITS, retryable: false });
  });

  it('retries transient 503/429 failures up to maxRetries and recovers cleanly', async () => {
    let attempts = 0;
    const client = new XaiResponsesClient({
      apiKey: 'xai-key',
      baseUrl: 'https://api.x.ai/v1',
      defaultModel: 'grok-4.7',
      timeoutMs: 5000,
      maxRetries: 2,
      fetchImpl: async () => {
        attempts += 1;
        if (attempts < 3) {
          return new Response(JSON.stringify({ error: { message: 'Temporarily busy' } }), {
            status: 503,
          });
        }
        return new Response(
          sseStreamFromChunks([
            'event: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":"Recovered"}\n\n',
            'event: response.completed\ndata: {"type":"response.completed","response":{"id":"resp_ok","usage":{"input_tokens":5,"output_tokens":2,"total_tokens":7}}}\n\n',
          ]),
          { status: 200 },
        );
      },
    });

    const result = await client.createResponse({
      instructions: 'Sys',
      input: [{ role: 'user', content: 'hi' }],
      stream: true,
    });

    expect(attempts).toBe(3);
    expect(result.text).toBe('Recovered');
  });

  it('maps network failures to NETWORK_DISCONNECTED', async () => {
    const client = new XaiResponsesClient({
      apiKey: 'xai-key',
      baseUrl: 'https://api.x.ai/v1',
      defaultModel: 'grok-4.7',
      timeoutMs: 5000,
      maxRetries: 0,
      fetchImpl: async () => {
        throw new TypeError('fetch failed');
      },
    });

    await expect(
      client.createResponse({
        instructions: 'Sys',
        input: [{ role: 'user', content: 'hi' }],
        stream: true,
      }),
    ).rejects.toMatchObject({
      code: ErrorCodes.NETWORK_DISCONNECTED,
      message: 'service unavailable',
      retryable: true,
    });
  });

  it('maps 401, 403 permission/credits, permission-denied + credits or licenses, and 5xx cleanly without leaking raw upstream errors to UI', async () => {
    const makeClient = (status: number, payload: unknown) =>
      new XaiResponsesClient({
        apiKey: 'xai-key-secret-never-shown',
        baseUrl: 'https://api.x.ai/v1',
        defaultModel: 'grok-4.7',
        timeoutMs: 5000,
        maxRetries: 0,
        fetchImpl: async () =>
          new Response(typeof payload === 'string' ? payload : JSON.stringify(payload), { status }),
      });

    // 403 with permission-denied + "credits or licenses" (xAI string error format)
    await expect(
      makeClient(403, {
        code: 'permission-denied',
        error:
          'Your newly created team does not have any credits or licenses yet using key xai-leakMeNot123456.',
      }).createResponse({
        instructions: 'Sys',
        input: [{ role: 'user', content: 'hi' }],
        stream: false,
      }),
    ).rejects.toMatchObject({
      code: ErrorCodes.INSUFFICIENT_CREDITS,
      message: 'xAI account e credit nai. console.x.ai te billing check koro.',
    });

    // Verify raw diagnostic is sanitized (key scrubbed) for server logging while UI payload stays friendly
    try {
      await makeClient(403, {
        code: 'permission-denied',
        error: 'Team lacks credits or licenses (key xai-leakMeNot123456)',
      }).createResponse({
        instructions: 'Sys',
        input: [{ role: 'user', content: 'hi' }],
        stream: false,
      });
    } catch (err) {
      const appErr = err as import('@mj/shared').AppError;
      expect(appErr.upstreamDiagnostic).toContain('permission-denied');
      expect(appErr.upstreamDiagnostic).toContain('credits or licenses');
      expect(appErr.upstreamDiagnostic).not.toContain('xai-leakMeNot123456');
      expect(appErr.toPayload().message).toBe(
        'xAI account e credit nai. console.x.ai te billing check koro.',
      );
      expect(JSON.stringify(appErr.toPayload())).not.toContain('xai-leakMeNot123456');
      expect(JSON.stringify(appErr.toPayload())).not.toContain('upstreamDiagnostic');
    }

    // 401 -> "API key invalid"
    await expect(
      makeClient(401, { error: { message: 'Incorrect API key provided' } }).createResponse({
        instructions: 'Sys',
        input: [{ role: 'user', content: 'hi' }],
        stream: false,
      }),
    ).rejects.toMatchObject({
      code: ErrorCodes.INVALID_API_KEY,
      message: 'API key invalid',
    });

    // Generic 403 -> "permission/credits nai"
    await expect(
      makeClient(403, { error: { message: 'Forbidden resource scope' } }).createResponse({
        instructions: 'Sys',
        input: [{ role: 'user', content: 'hi' }],
        stream: false,
      }),
    ).rejects.toMatchObject({
      code: ErrorCodes.UNAUTHORIZED,
      message: 'permission/credits nai',
    });

    // 5xx -> "service unavailable"
    await expect(
      makeClient(503, { error: { message: 'Internal backend meltdown' } }).createResponse({
        instructions: 'Sys',
        input: [{ role: 'user', content: 'hi' }],
        stream: false,
      }),
    ).rejects.toMatchObject({
      code: ErrorCodes.UPSTREAM_ERROR,
      message: 'service unavailable',
    });
  });
});
