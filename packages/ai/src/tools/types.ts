import type {
  AllowlistEntryDTO,
  AllowlistKind,
  AuditLogEntryDTO,
  AuditOutcome,
  AuditSource,
  ControllablePermissionKey,
  ConversationDTO,
  HostTelemetryDTO,
  PermissionsStateDTO,
  ToolRiskLevel,
  UsageSummaryDTO,
  z,
} from '@mj/shared';

export type ToolConfirmDecision = 'approved' | 'cancelled' | 'timed_out';

export interface ToolAuditInput {
  capability: string;
  action: string;
  target: string;
  outcome: AuditOutcome;
  source: AuditSource;
  detail?: string;
}

export interface ToolConfirmationRequest {
  toolName: string;
  args: Record<string, unknown>;
  summary: string;
  requiredPermission: ControllablePermissionKey;
  target: string;
}

export interface ToolExecutionContext {
  source: AuditSource;
  channel: 'chat' | 'voice';
  conversationId?: string;
  confirmed?: boolean;
  getPermissions: () => Promise<PermissionsStateDTO>;
  recordAuditLog: (entry: ToolAuditInput) => Promise<AuditLogEntryDTO | void>;
  listAllowlist: (kind?: AllowlistKind) => Promise<AllowlistEntryDTO[]>;
  getUsageSummary: () => Promise<UsageSummaryDTO>;
  searchConversations: (query: string, limit?: number) => Promise<ConversationDTO[]>;
  getSystemTelemetry: () => Promise<HostTelemetryDTO>;
  requestConfirmation?: (req: ToolConfirmationRequest) => Promise<ToolConfirmDecision>;
  launchApprovedApp?: (target: string) => Promise<{ executed: boolean; detail?: string }>;
  onClientAction?: (action: { kind: 'open_approved_url' | 'open_approved_app'; target: string }) => void;
}

export interface MjToolDefinition<
  TSchema extends z.ZodObject<Record<string, z.ZodTypeAny>> = z.ZodObject<Record<string, z.ZodTypeAny>>,
> {
  name: string;
  description: string;
  schema: TSchema;
  jsonSchema: Record<string, unknown>;
  geminiParameters?: Record<string, unknown>;
  risk: ToolRiskLevel;
  requiredPermission: ControllablePermissionKey;
  getTarget?: (args: z.infer<TSchema>) => string;
  summarizeAction?: (args: z.infer<TSchema>) => string;
  validatePreflight?: (
    args: z.infer<TSchema>,
    ctx: ToolExecutionContext,
  ) => Promise<{ ok: true } | { ok: false; errorCode: string; detail: string; target?: string }>;
  execute: (
    args: z.infer<TSchema>,
    ctx: ToolExecutionContext,
  ) => Promise<Record<string, unknown>>;
}

export interface ToolExecutionResult {
  ok: boolean;
  toolName: string;
  status: 'executed' | 'denied' | 'cancelled' | 'timed_out' | 'confirmation_required' | 'error';
  result?: Record<string, unknown>;
  errorCode?: string;
  error?: string;
  clientAction?: {
    kind: 'open_approved_url' | 'open_approved_app';
    target: string;
  };
}
