import {
  ErrorCodes,
  type ADMIN_PRIVILEGE_POLICY,
  type AiProviderId,
  type AllowlistEntryDTO,
  type AllowlistKind,
  type AuditLogEntryDTO,
  type AuditOutcome,
  type AuditSource,
  type AuthSessionDTO,
  type ChatStreamEvent,
  type ConfigurableShortcutDTO,
  type ConnectivityCheckDTO,
  type ControllablePermissionKey,
  type ShortcutActionKind,
  type ConversationDTO,
  type ConversationDetailDTO,
  type HostTelemetryDTO,
  type LanguageMode,
  type MessageDTO,
  type PermissionsStateDTO,
  type PublicSettingsDTO,
  type StructuredErrorPayload,
  type SystemHealthDTO,
  type UsageSummaryDTO,
  type VoiceClientSecretDTO,
} from '@mj/shared';

const RAW_API_BASE =
  (import.meta as { env?: Record<string, string | undefined> }).env?.VITE_API_BASE_URL?.trim() ??
  '';

export const API_BASE_URL = RAW_API_BASE.replace(/\/+$/, '');

export function resolveApiUrl(path: string): string {
  if (!path.startsWith('/')) return path;
  return API_BASE_URL ? `${API_BASE_URL}${path}` : path;
}

export interface SttTranscribeRequest {
  audioBase64: string;
  filename?: string;
  mimeType?: string;
  languageMode?: LanguageMode;
  durationSeconds?: number;
}

export interface SttTranscribeResponse {
  text: string;
  language?: string;
  modelUsed?: string;
  isFree?: boolean;
}

const MAX_STT_BASE64_CHARS = 12_000_000;
const MAX_STT_JSON_BODY_BYTES = 12 * 1024 * 1024;

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
    response = await fetch(resolveApiUrl(url), {
      ...init,
      credentials: 'include',
      headers: {
        ...(init.body ? { 'Content-Type': 'application/json' } : {}),
        ...(init.headers ?? {}),
      },
    });
  } catch (err) {
    if (init.signal?.aborted || (err instanceof Error && err.name === 'AbortError')) {
      throw err;
    }
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

  checkUsageConnectivity: () =>
    requestJson<ConnectivityCheckDTO>('/api/usage/connectivity', {
      method: 'POST',
      body: JSON.stringify({}),
    }),

  getPrivacyPermissions: () =>
    requestJson<{
      permissions: PermissionsStateDTO;
      adminPolicy: typeof ADMIN_PRIVILEGE_POLICY;
    }>('/api/privacy/permissions'),

  setSinglePermission: (key: ControllablePermissionKey, enabled: boolean) =>
    requestJson<{
      permissions: PermissionsStateDTO;
      adminPolicy: typeof ADMIN_PRIVILEGE_POLICY;
    }>('/api/privacy/permissions', {
      method: 'PATCH',
      body: JSON.stringify({ key, enabled }),
    }),

  revokeDesktopPermissions: () =>
    requestJson<{
      permissions: PermissionsStateDTO;
      adminPolicy: typeof ADMIN_PRIVILEGE_POLICY;
    }>('/api/privacy/revoke-desktop', {
      method: 'POST',
      body: JSON.stringify({}),
    }),

  listAuditLogs: (filters?: { capability?: string; outcome?: string; limit?: number }) => {
    const params = new URLSearchParams();
    if (filters?.capability) params.set('capability', filters.capability);
    if (filters?.outcome) params.set('outcome', filters.outcome);
    if (filters?.limit) params.set('limit', String(filters.limit));
    const qs = params.toString() ? `?${params.toString()}` : '';
    return requestJson<{ entries: AuditLogEntryDTO[] }>(`/api/privacy/audit-log${qs}`);
  },

  recordAuditLog: (entry: {
    capability: string;
    action: string;
    target: string;
    outcome: AuditOutcome;
    source: AuditSource;
    detail?: string;
  }) =>
    requestJson<{ entry: AuditLogEntryDTO }>('/api/privacy/audit-log', {
      method: 'POST',
      body: JSON.stringify(entry),
    }),

  listAllowlist: () => requestJson<{ entries: AllowlistEntryDTO[] }>('/api/privacy/allowlist'),

  addAllowlistEntry: (entry: { kind: AllowlistKind; label: string; target: string }) =>
    requestJson<{ entry: AllowlistEntryDTO }>('/api/privacy/allowlist', {
      method: 'POST',
      body: JSON.stringify(entry),
    }),

  deleteAllowlistEntry: (id: string) =>
    requestJson<{ deleted: boolean; id: string }>(
      `/api/privacy/allowlist/${encodeURIComponent(id)}`,
      { method: 'DELETE' },
    ),

  exportPersonalData: () => requestJson<Record<string, unknown>>('/api/privacy/export'),

  clearAllConversations: () =>
    requestJson<{ cleared: boolean; deletedCount: number }>('/api/privacy/conversations', {
      method: 'DELETE',
    }),

  getDesktopSystemStatus: () =>
    requestJson<{ telemetry: HostTelemetryDTO }>('/api/desktop/system-status'),

  validateDesktopAction: (payload: {
    capability:
      | 'appOpening'
      | 'fileRead'
      | 'fileWrite'
      | 'systemMonitoring'
      | 'notifications'
      | 'clipboardWrite'
      | 'webLaunch'
      | 'configurableShortcuts';
    action: string;
    target: string;
    confirmed?: boolean;
    source?: 'web' | 'desktop-tauri';
  }) =>
    requestJson<{ approved: boolean; auditEntry: AuditLogEntryDTO }>(
      '/api/desktop/validate-action',
      {
        method: 'POST',
        body: JSON.stringify(payload),
      },
    ),

  listDesktopShortcuts: () =>
    requestJson<{ enabled: boolean; shortcuts: ConfigurableShortcutDTO[] }>(
      '/api/desktop/shortcuts',
    ),

  createDesktopShortcut: (payload: {
    label: string;
    accelerator: string;
    action: ShortcutActionKind;
    target?: string;
  }) =>
    requestJson<{ shortcut: ConfigurableShortcutDTO }>('/api/desktop/shortcuts', {
      method: 'POST',
      body: JSON.stringify(payload),
    }),

  deleteDesktopShortcut: (id: string) =>
    requestJson<{ deleted: boolean; id: string }>(
      `/api/desktop/shortcuts/${encodeURIComponent(id)}`,
      { method: 'DELETE' },
    ),

  triggerDesktopShortcut: (id: string, source: 'web' | 'desktop-tauri' = 'web') =>
    requestJson<{
      executed: boolean;
      shortcut: ConfigurableShortcutDTO;
      auditEntry: AuditLogEntryDTO;
    }>(`/api/desktop/shortcuts/${encodeURIComponent(id)}/trigger`, {
      method: 'POST',
      body: JSON.stringify({ source }),
    }),

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
      response = await fetch(resolveApiUrl('/api/voice/tts'), {
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

  transcribeSpeech: async (
    input: SttTranscribeRequest,
    signal?: AbortSignal,
  ): Promise<SttTranscribeResponse> => {
    if (!input.audioBase64 || input.audioBase64.length < 4) {
      throw new ApiClientError({
        code: ErrorCodes.VALIDATION_ERROR,
        category: 'validation',
        statusCode: 400,
        message: 'Recorded audio is empty.',
        retryable: true,
      });
    }
    if (input.audioBase64.length > MAX_STT_BASE64_CHARS) {
      throw new ApiClientError({
        code: ErrorCodes.VALIDATION_ERROR,
        category: 'validation',
        statusCode: 413,
        message: 'Recorded audio exceeds the 12 MB transcription limit.',
        retryable: true,
      });
    }
    const serialized = JSON.stringify(input);
    if (new TextEncoder().encode(serialized).byteLength > MAX_STT_JSON_BODY_BYTES) {
      throw new ApiClientError({
        code: ErrorCodes.VALIDATION_ERROR,
        category: 'validation',
        statusCode: 413,
        message: 'Transcription request exceeds the 12 MB server limit.',
        retryable: true,
      });
    }
    return requestJson<SttTranscribeResponse>('/api/voice/stt', {
      method: 'POST',
      body: serialized,
      ...(signal ? { signal } : {}),
    });
  },

  streamChat: (
    conversationId: string,
    payload: { content: string; model?: string; provider?: AiProviderId; stream?: boolean },
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
    payload: { model?: string; provider?: AiProviderId; stream?: boolean },
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
    response = await fetch(resolveApiUrl(url), {
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
