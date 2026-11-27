import {
  ErrorCodes,
  type AuthSessionDTO,
  type ChatStreamEvent,
  type ConversationDTO,
  type ConversationDetailDTO,
  type LanguageMode,
  type MessageDTO,
  type PublicSettingsDTO,
  type StructuredErrorPayload,
  type SystemHealthDTO,
  type UsageSummaryDTO,
  type VoiceClientSecretDTO,
} from '@mj/shared';

export class ApiClientError extends Error {
  public readonly payload: StructuredErrorPayload;

  constructor(payload: StructuredErrorPayload) {
    super(payload.message);
    this.name = 'ApiClientError';
    this.payload = payload;
  }
}

async function requestJson<T>(url: string, init: RequestInit = {}): Promise<T> {
  let response: Response;
  try {
    response = await fetch(url, {
      ...init,
      credentials: 'include',
      headers: {
        ...(init.body ? { 'Content-Type': 'application/json' } : {}),
        ...(init.headers ?? {}),
      },
    });
  } catch {
    throw new ApiClientError({
      code: ErrorCodes.NETWORK_DISCONNECTED,
      category: 'network',
      statusCode: 503,
      message:
        'Could not reach the MJ backend server. Check that the backend is running and your connection is active.',
      retryable: true,
    });
  }

  let json: unknown = null;
  const contentType = response.headers.get('content-type') ?? '';
  if (contentType.includes('application/json')) {
    try {
      json = await response.json();
    } catch {
      json = null;
    }
  }

  if (!response.ok) {
    const errObj =
      json && typeof json === 'object' && 'error' in json
        ? (json as { error: StructuredErrorPayload }).error
        : undefined;

    if (errObj && errObj.code && errObj.message) {
      throw new ApiClientError(errObj);
    }

    throw new ApiClientError({
      code: response.status === 401 ? ErrorCodes.UNAUTHORIZED : ErrorCodes.INTERNAL_ERROR,
      category: response.status === 401 ? 'auth' : 'internal',
      statusCode: response.status,
      message: `Request failed with status ${response.status}.`,
      retryable: response.status >= 500,
    });
  }

  return json as T;
}

export const mjApi = {
  getHealth: () => requestJson<SystemHealthDTO>('/api/health'),

  getSession: () => requestJson<AuthSessionDTO>('/api/auth/session'),

  login: (passcode?: string) =>
    requestJson<AuthSessionDTO>('/api/auth/login', {
      method: 'POST',
      body: JSON.stringify(passcode !== undefined ? { passcode } : {}),
    }),

  logout: () =>
    requestJson<AuthSessionDTO>('/api/auth/logout', {
      method: 'POST',
      body: JSON.stringify({}),
    }),

  listConversations: (query?: string) => {
    const qs = query?.trim() ? `?q=${encodeURIComponent(query.trim())}` : '';
    return requestJson<{ conversations: ConversationDTO[] }>(`/api/conversations${qs}`);
  },

  createConversation: (input?: { title?: string; model?: string }) =>
    requestJson<{ conversation: ConversationDTO }>('/api/conversations', {
      method: 'POST',
      body: JSON.stringify(input ?? {}),
    }),

  getConversation: (id: string) =>
    requestJson<ConversationDetailDTO>(`/api/conversations/${encodeURIComponent(id)}`),

  renameConversation: (id: string, title: string) =>
    requestJson<{ conversation: ConversationDTO }>(
      `/api/conversations/${encodeURIComponent(id)}`,
      {
        method: 'PATCH',
        body: JSON.stringify({ title }),
      },
    ),

  deleteConversation: (id: string) =>
    requestJson<{ deleted: boolean; id: string }>(
      `/api/conversations/${encodeURIComponent(id)}`,
      {
        method: 'DELETE',
      },
    ),

  saveVoiceTurn: (
    conversationId: string,
    turn: {
      role: 'user' | 'assistant';
      content: string;
      status?: 'completed' | 'aborted' | 'error';
      model?: string;
    },
  ) =>
    requestJson<{ message: MessageDTO; conversation: ConversationDTO }>(
      `/api/conversations/${encodeURIComponent(conversationId)}/voice-turns`,
      {
        method: 'POST',
        body: JSON.stringify(turn),
      },
    ),

  getSettings: () => requestJson<PublicSettingsDTO>('/api/settings'),

  updateSettings: (patch: Record<string, unknown>) =>
    requestJson<PublicSettingsDTO>('/api/settings', {
      method: 'PATCH',
      body: JSON.stringify(patch),
    }),

  getUsage: () => requestJson<UsageSummaryDTO>('/api/usage'),

  requestVoiceClientSecret: (input?: {
    conversationId?: string;
    voice?: string;
    languageMode?: LanguageMode;
  }) =>
    requestJson<VoiceClientSecretDTO>('/api/voice/client-secret', {
      method: 'POST',
      body: JSON.stringify(input ?? {}),
    }),

  getAvailableVoices: () =>
    requestJson<{ voices: Array<{ id: string; label: string; description: string }> }>(
      '/api/voice/voices',
    ),

  recordVoiceUsage: (input: {
    conversationId?: string;
    model: string;
    durationSeconds: number;
    status: 'success' | 'error' | 'aborted';
    errorCode?: string;
  }) =>
    requestJson<{ recorded: boolean; estimatedCostUsd: number }>('/api/voice/usage', {
      method: 'POST',
      body: JSON.stringify(input),
    }),

  fetchTtsAudio: async (
    text: string,
    options: { voiceId?: string; languageMode?: LanguageMode },
    signal: AbortSignal,
  ): Promise<ArrayBuffer> => {
    let response: Response;
    try {
      response = await fetch('/api/voice/tts', {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          text,
          ...(options.voiceId ? { voiceId: options.voiceId } : {}),
          ...(options.languageMode ? { languageMode: options.languageMode } : {}),
        }),
        signal,
      });
    } catch {
      throw new ApiClientError({
        code: ErrorCodes.VOICE_SERVICE_UNAVAILABLE,
        category: 'voice',
        statusCode: 503,
        message: 'Could not reach TTS endpoint.',
        retryable: true,
      });
    }

    if (!response.ok) {
      let payload: StructuredErrorPayload | undefined;
      try {
        const json = (await response.json()) as { error?: StructuredErrorPayload };
        payload = json?.error;
      } catch {
        payload = undefined;
      }
      throw new ApiClientError(
        payload ?? {
          code: ErrorCodes.VOICE_SERVICE_UNAVAILABLE,
          category: 'voice',
          statusCode: response.status,
          message: `TTS request failed with status ${response.status}.`,
          retryable: response.status >= 500,
        },
      );
    }

    return response.arrayBuffer();
  },

  streamChat: (
    conversationId: string,
    payload: { content: string; model?: string; stream?: boolean },
    handlers: StreamHandlers,
    signal: AbortSignal,
  ) =>
    streamSseEndpoint(
      `/api/conversations/${encodeURIComponent(conversationId)}/messages`,
      payload,
      handlers,
      signal,
    ),

  regenerateLastTurn: (
    conversationId: string,
    payload: { model?: string; stream?: boolean },
    handlers: StreamHandlers,
    signal: AbortSignal,
  ) =>
    streamSseEndpoint(
      `/api/conversations/${encodeURIComponent(conversationId)}/regenerate`,
      payload,
      handlers,
      signal,
    ),
};

export interface StreamHandlers {
  onEvent: (event: ChatStreamEvent) => void;
}

async function streamSseEndpoint(
  url: string,
  bodyPayload: Record<string, unknown>,
  handlers: StreamHandlers,
  signal: AbortSignal,
): Promise<void> {
  let response: Response;
  try {
    response = await fetch(url, {
      method: 'POST',
      credentials: 'include',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'text/event-stream',
      },
      body: JSON.stringify(bodyPayload),
      signal,
    });
  } catch (err) {
    if (signal.aborted || (err instanceof Error && err.name === 'AbortError')) {
      return;
    }
    throw new ApiClientError({
      code: ErrorCodes.NETWORK_DISCONNECTED,
      category: 'network',
      statusCode: 503,
      message:
        'Network error while connecting to MJ Assistant. Please verify your connection and retry.',
      retryable: true,
    });
  }

  if (!response.ok) {
    let payload: StructuredErrorPayload | undefined;
    try {
      const json = (await response.json()) as { error?: StructuredErrorPayload };
      payload = json?.error;
    } catch {
      payload = undefined;
    }

    throw new ApiClientError(
      payload ?? {
        code: response.status === 401 ? ErrorCodes.UNAUTHORIZED : ErrorCodes.UPSTREAM_ERROR,
        category: response.status === 401 ? 'auth' : 'api',
        statusCode: response.status,
        message: `Server returned status ${response.status}.`,
        retryable: response.status >= 500,
      },
    );
  }

  if (!response.body) {
    throw new ApiClientError({
      code: ErrorCodes.UPSTREAM_ERROR,
      category: 'api',
      statusCode: 502,
      message: 'Empty stream returned by server.',
      retryable: true,
    });
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder('utf-8');
  let buffer = '';

  const dispatchBuffer = (flush: boolean) => {
    const normalized = buffer.replace(/\r\n/g, '\n');
    const blocks = normalized.split('\n\n');
    buffer = flush ? '' : (blocks.pop() ?? '');

    for (const block of blocks) {
      if (!block.trim()) continue;
      const dataLines: string[] = [];
      for (const line of block.split('\n')) {
        if (line.startsWith('data:')) {
          dataLines.push(line.slice(5).trimStart());
        }
      }
      if (dataLines.length === 0) continue;
      try {
        const parsed = JSON.parse(dataLines.join('\n')) as ChatStreamEvent;
        handlers.onEvent(parsed);
      } catch {
        // ignore malformed keepalive frames
      }
    }
  };

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) {
        buffer += decoder.decode(value, { stream: true });
        dispatchBuffer(false);
      }
    }
    buffer += decoder.decode();
    dispatchBuffer(true);
  } catch (err) {
    if (signal.aborted || (err instanceof Error && err.name === 'AbortError')) {
      return;
    }
    throw new ApiClientError({
      code: ErrorCodes.NETWORK_DISCONNECTED,
      category: 'network',
      statusCode: 503,
      message: 'Stream connection interrupted. You can retry your message.',
      retryable: true,
    });
  } finally {
    reader.releaseLock();
  }
}
