export const ErrorCodes = {
  INVALID_API_KEY: 'INVALID_API_KEY',
  UNAUTHORIZED: 'UNAUTHORIZED',
  RATE_LIMITED: 'RATE_LIMITED',
  INSUFFICIENT_CREDITS: 'INSUFFICIENT_CREDITS',
  INVALID_REQUEST: 'INVALID_REQUEST',
  MODEL_UNAVAILABLE: 'MODEL_UNAVAILABLE',
  UPSTREAM_ERROR: 'UPSTREAM_ERROR',
  TIMEOUT: 'TIMEOUT',
  NETWORK_DISCONNECTED: 'NETWORK_DISCONNECTED',
  BUDGET_EXCEEDED: 'BUDGET_EXCEEDED',
  DATABASE_UNAVAILABLE: 'DATABASE_UNAVAILABLE',
  DATABASE_TIMEOUT: 'DATABASE_TIMEOUT',
  DATABASE_QUERY_ERROR: 'DATABASE_QUERY_ERROR',
  DATABASE_MIGRATION_ERROR: 'DATABASE_MIGRATION_ERROR',
  VALIDATION_ERROR: 'VALIDATION_ERROR',
  NOT_FOUND: 'NOT_FOUND',
  ABORTED: 'ABORTED',
  INTERNAL_ERROR: 'INTERNAL_ERROR',

  // Stage 2 Voice Errors (Section 07)
  MIC_PERMISSION_DENIED: 'MIC_PERMISSION_DENIED',
  NO_MICROPHONE_DETECTED: 'NO_MICROPHONE_DETECTED',
  WEBSOCKET_CONNECTION_FAILED: 'WEBSOCKET_CONNECTION_FAILED',
  UNSUPPORTED_AUDIO_FORMAT: 'UNSUPPORTED_AUDIO_FORMAT',
  AUDIO_PLAYBACK_FAILED: 'AUDIO_PLAYBACK_FAILED',
  VOICE_SERVICE_UNAVAILABLE: 'VOICE_SERVICE_UNAVAILABLE',
  VOICE_CONNECTION_INTERRUPTED: 'VOICE_CONNECTION_INTERRUPTED',

  // Stage 4 Desktop & Privacy Errors (Sections 14 & 15)
  PERMISSION_DENIED: 'PERMISSION_DENIED',
  CONFIRMATION_REQUIRED: 'CONFIRMATION_REQUIRED',
  SHELL_EXECUTION_FORBIDDEN: 'SHELL_EXECUTION_FORBIDDEN',
  UNAPPROVED_TARGET: 'UNAPPROVED_TARGET',
  DESKTOP_HOST_REQUIRED: 'DESKTOP_HOST_REQUIRED',
} as const;

export type ErrorCode = (typeof ErrorCodes)[keyof typeof ErrorCodes];

export type ErrorCategory =
  | 'api'
  | 'voice'
  | 'desktop'
  | 'privacy'
  | 'network'
  | 'database'
  | 'auth'
  | 'validation'
  | 'budget'
  | 'internal';

export interface StructuredErrorPayload {
  code: ErrorCode;
  category: ErrorCategory;
  message: string;
  statusCode: number;
  retryable: boolean;
  retryAfterMs?: number;
  requestId?: string;
}

const DEFAULT_USER_MESSAGES: Record<ErrorCode, string> = {
  INVALID_API_KEY:
    'Your xAI API key is invalid or not configured on the server. Update XAI_API_KEY in your .env file and restart the server.',
  UNAUTHORIZED:
    'Authorization failed. Please unlock your session or verify server credentials.',
  RATE_LIMITED:
    'xAI rate limit reached. Please wait a moment and try again.',
  INSUFFICIENT_CREDITS:
    'Insufficient xAI API credits. Check your billing balance at console.x.ai.',
  INVALID_REQUEST:
    'The request parameters were rejected by the AI service. Adjust your model or settings and try again.',
  MODEL_UNAVAILABLE:
    'The configured Grok model is unavailable or unsupported. Choose another model in Settings.',
  UPSTREAM_ERROR:
    'Grok is temporarily unavailable. Please try again.',
  TIMEOUT:
    'The request to Grok timed out. You can retry your message.',
  NETWORK_DISCONNECTED:
    'Network connection failed while contacting the AI service. Check your internet connection and retry.',
  BUDGET_EXCEEDED:
    'Your configured hard spend budget cap has been reached. Raise or disable the cap in Settings -> Usage to continue.',
  DATABASE_UNAVAILABLE:
    'Local conversation storage is currently unavailable.',
  DATABASE_TIMEOUT:
    'Database operation timed out. Please try again.',
  DATABASE_QUERY_ERROR:
    'A database error occurred while saving or loading conversation data.',
  DATABASE_MIGRATION_ERROR:
    'Database initialization failed. Check file permissions and DATABASE_URL.',
  VALIDATION_ERROR:
    'The submitted input is invalid. Please check your message or configuration.',
  NOT_FOUND:
    'The requested conversation or resource could not be found.',
  ABORTED:
    'Generation was stopped.',
  INTERNAL_ERROR:
    'An unexpected server error occurred. Please try again.',
  MIC_PERMISSION_DENIED:
    'Your microphone permission is currently disabled. Allow microphone access in your browser to use voice.',
  NO_MICROPHONE_DETECTED:
    'No microphone was detected on this device. You can continue using text mode.',
  WEBSOCKET_CONNECTION_FAILED:
    'Could not connect to the Grok realtime voice service. Please check your connection and try again.',
  UNSUPPORTED_AUDIO_FORMAT:
    'Your browser audio pipeline could not initialize the required PCM audio format.',
  AUDIO_PLAYBACK_FAILED:
    'Audio playback failed in this browser. Check your speakers or audio permissions.',
  VOICE_SERVICE_UNAVAILABLE:
    'Grok voice service is temporarily unavailable. Please try again or switch to text mode.',
  VOICE_CONNECTION_INTERRUPTED:
    'Voice connection interrupted. Reconnecting...',
  PERMISSION_DENIED:
    'This capability is currently turned OFF in the Privacy & Permissions Center. Enable it individually before continuing.',
  CONFIRMATION_REQUIRED:
    'Explicit user confirmation is required before modifying or organizing local files.',
  SHELL_EXECUTION_FORBIDDEN:
    'Arbitrary shell commands and script interpreters are strictly blocked by MJ Assistant security policy.',
  UNAPPROVED_TARGET:
    'This target is not in your explicit allowlist. Approve it in Privacy & Permissions first.',
  DESKTOP_HOST_REQUIRED:
    'This OS-level action requires running inside the MJ Assistant Windows Tauri Desktop Companion.',
};

const RETRYABLE_CODES = new Set<ErrorCode>([
  ErrorCodes.RATE_LIMITED,
  ErrorCodes.UPSTREAM_ERROR,
  ErrorCodes.TIMEOUT,
  ErrorCodes.NETWORK_DISCONNECTED,
  ErrorCodes.DATABASE_TIMEOUT,
  ErrorCodes.WEBSOCKET_CONNECTION_FAILED,
  ErrorCodes.VOICE_SERVICE_UNAVAILABLE,
  ErrorCodes.VOICE_CONNECTION_INTERRUPTED,
]);

export function isRetryableErrorCode(code: ErrorCode): boolean {
  return RETRYABLE_CODES.has(code);
}

export function toUserFriendlyMessage(code: ErrorCode, customMessage?: string): string {
  if (customMessage && customMessage.trim().length > 0) {
    return customMessage;
  }
  return DEFAULT_USER_MESSAGES[code];
}

export interface AppErrorOptions {
  code: ErrorCode;
  category: ErrorCategory;
  statusCode?: number;
  message?: string;
  retryable?: boolean;
  retryAfterMs?: number;
  requestId?: string;
  cause?: unknown;
}

/**
 * Centralized structured error used across server, AI, voice, and database layers.
 * Never exposes secrets, authorization headers, or raw stack traces to clients.
 */
export class AppError extends Error {
  public readonly code: ErrorCode;
  public readonly category: ErrorCategory;
  public readonly statusCode: number;
  public readonly retryable: boolean;
  public readonly retryAfterMs?: number;
  public requestId?: string;

  constructor(options: AppErrorOptions) {
    const safeMessage = toUserFriendlyMessage(options.code, options.message);
    super(safeMessage, options.cause !== undefined ? { cause: options.cause } : undefined);
    this.name = 'AppError';
    this.code = options.code;
    this.category = options.category;
    this.statusCode = options.statusCode ?? inferHttpStatus(options.code);
    this.retryable = options.retryable ?? isRetryableErrorCode(options.code);
    this.retryAfterMs = options.retryAfterMs;
    this.requestId = options.requestId;
  }

  public toPayload(): StructuredErrorPayload {
    return {
      code: this.code,
      category: this.category,
      message: this.message,
      statusCode: this.statusCode,
      retryable: this.retryable,
      ...(this.retryAfterMs !== undefined ? { retryAfterMs: this.retryAfterMs } : {}),
      ...(this.requestId !== undefined ? { requestId: this.requestId } : {}),
    };
  }
}

export function inferHttpStatus(code: ErrorCode): number {
  switch (code) {
    case ErrorCodes.INVALID_API_KEY:
    case ErrorCodes.UPSTREAM_ERROR:
    case ErrorCodes.WEBSOCKET_CONNECTION_FAILED:
      return 502;
    case ErrorCodes.UNAUTHORIZED:
      return 401;
    case ErrorCodes.MIC_PERMISSION_DENIED:
    case ErrorCodes.PERMISSION_DENIED:
    case ErrorCodes.SHELL_EXECUTION_FORBIDDEN:
    case ErrorCodes.UNAPPROVED_TARGET:
      return 403;
    case ErrorCodes.CONFIRMATION_REQUIRED:
      return 409;
    case ErrorCodes.DESKTOP_HOST_REQUIRED:
      return 501;
    case ErrorCodes.INSUFFICIENT_CREDITS:
      return 402;
    case ErrorCodes.RATE_LIMITED:
    case ErrorCodes.BUDGET_EXCEEDED:
      return 429;
    case ErrorCodes.INVALID_REQUEST:
    case ErrorCodes.VALIDATION_ERROR:
    case ErrorCodes.UNSUPPORTED_AUDIO_FORMAT:
      return 400;
    case ErrorCodes.MODEL_UNAVAILABLE:
    case ErrorCodes.NOT_FOUND:
    case ErrorCodes.NO_MICROPHONE_DETECTED:
      return 404;
    case ErrorCodes.TIMEOUT:
    case ErrorCodes.DATABASE_TIMEOUT:
      return 504;
    case ErrorCodes.NETWORK_DISCONNECTED:
    case ErrorCodes.DATABASE_UNAVAILABLE:
    case ErrorCodes.VOICE_SERVICE_UNAVAILABLE:
    case ErrorCodes.VOICE_CONNECTION_INTERRUPTED:
      return 503;
    case ErrorCodes.ABORTED:
      return 499;
    case ErrorCodes.AUDIO_PLAYBACK_FAILED:
    case ErrorCodes.DATABASE_QUERY_ERROR:
    case ErrorCodes.DATABASE_MIGRATION_ERROR:
    case ErrorCodes.INTERNAL_ERROR:
    default:
      return 500;
  }
}

export function sanitizeDiagnosticText(input: string): string {
  return input
    .replace(/Bearer\s+[A-Za-z0-9._-]+/gi, 'Bearer [REDACTED]')
    .replace(/xai-[A-Za-z0-9_-]{8,}/g, 'xai-[REDACTED]')
    .replace(/(api[_-]?key|secret|token|password)\s*[:=]\s*[^\s,;]+/gi, '$1=[REDACTED]');
}
