import type { FastifyInstance, FastifyRequest } from 'fastify';
import {
  ConfirmToolActionSchema,
  ErrorCodes,
  ExecuteVoiceToolSchema,
  validateInput,
  type AuditSource,
} from '@mj/shared';
import {
  executeToolCallSafely,
  type ToolExecutionContext,
  type ToolRegistry,
} from '@mj/ai';
import type { MjDatabaseRepository } from '@mj/database';
import type { PermissionsStore } from '../permissionsStore.js';
import type { RuntimeSettingsStore } from '../settingsStore.js';
import { collectHostTelemetry } from '../systemTelemetry.js';
import type { ToolConfirmationManager } from '../toolConfirmations.js';

export interface ToolRouteDeps {
  repo: MjDatabaseRepository;
  permissionsStore: PermissionsStore;
  settingsStore: RuntimeSettingsStore;
  toolRegistry: ToolRegistry;
  confirmationManager: ToolConfirmationManager;
  requireSession: (request: FastifyRequest) => Promise<void>;
  launchApprovedApp?: (target: string) => Promise<{ executed: boolean; detail?: string }>;
}

export function buildServerToolExecutionContext(
  deps: ToolRouteDeps,
  options: {
    source?: AuditSource;
    channel: 'chat' | 'voice';
    conversationId?: string;
    confirmed?: boolean;
    requestConfirmation?: ToolExecutionContext['requestConfirmation'];
  },
): ToolExecutionContext {
  return {
    source: options.source ?? 'server',
    channel: options.channel,
    ...(options.conversationId ? { conversationId: options.conversationId } : {}),
    ...(options.confirmed !== undefined ? { confirmed: options.confirmed } : {}),
    getPermissions: () => deps.permissionsStore.getPermissions(),
    recordAuditLog: (entry) => deps.repo.recordAuditLog(entry),
    listAllowlist: (kind) => deps.repo.listAllowlist(kind),
    getUsageSummary: async () => {
      const settings = await deps.settingsStore.getPublicSettings();
      return deps.repo.getUsageSummary(settings.budget);
    },
    searchConversations: async (query, limit) => {
      const matches = await deps.repo.listConversations(query);
      return matches.slice(0, limit ?? 5);
    },
    getSystemTelemetry: () => collectHostTelemetry(),
    ...(options.requestConfirmation ? { requestConfirmation: options.requestConfirmation } : {}),
    ...(deps.launchApprovedApp ? { launchApprovedApp: deps.launchApprovedApp } : {}),
  };
}

export function registerToolRoutes(app: FastifyInstance, deps: ToolRouteDeps): void {
  app.get('/api/tools/list', { preHandler: deps.requireSession }, async () => {
    const permissions = await deps.permissionsStore.getPermissions();
    const permittedNames = new Set(
      deps.toolRegistry.listPermittedTools(permissions).map((t) => t.name),
    );
    return {
      toolCallingEnabled: permissions.toolCalling,
      tools: deps.toolRegistry.listCatalog(false).map((item) => ({
        ...item,
        currentlyPermitted: permittedNames.has(item.name),
      })),
    };
  });

  app.get('/api/tools/pending', { preHandler: deps.requireSession }, async () => {
    return {
      pending: deps.confirmationManager.listPending(),
    };
  });

  /**
   * Executes a tool call requested by Gemini Live voice session (or verifies permission & returns
   * a 20-second `confirmation_required` challenge for `confirm`-risk tools).
   */
  app.post('/api/voice/tools/execute', { preHandler: deps.requireSession }, async (request) => {
    const body = validateInput(ExecuteVoiceToolSchema, request.body ?? {});

    const ctx = buildServerToolExecutionContext(deps, {
      channel: 'voice',
      conversationId: body.conversationId,
      confirmed: body.confirmed === true,
    });

    const outcome = await executeToolCallSafely(
      deps.toolRegistry,
      { name: body.name, args: body.args },
      ctx,
    );

    if (outcome.status === 'confirmation_required') {
      const tool = deps.toolRegistry.get(body.name.trim());
      const argsObj = body.args ?? {};
      const summary = tool?.summarizeAction
        ? tool.summarizeAction(argsObj)
        : `Confirm execution of "${body.name}"`;
      const target = tool?.getTarget ? tool.getTarget(argsObj) : body.name;
      const requiredPermission = tool?.requiredPermission ?? 'toolCalling';

      const pendingConfirmation = deps.confirmationManager.createActionPending({
        toolName: tool?.name ?? body.name.trim(),
        args: argsObj,
        summary,
        requiredPermission,
        conversationId: body.conversationId,
        channel: 'voice',
        callId: body.callId,
        executeOnApprove: () =>
          executeToolCallSafely(
            deps.toolRegistry,
            { name: body.name, args: argsObj },
            buildServerToolExecutionContext(deps, {
              channel: 'voice',
              conversationId: body.conversationId,
              confirmed: true,
            }),
          ),
        onCancelAudit: async (timedOut) => {
          await deps.repo.recordAuditLog({
            capability: requiredPermission,
            action: timedOut
              ? `Timed out confirmation for AI tool "${tool?.name ?? body.name}"`
              : `Cancelled AI tool "${tool?.name ?? body.name}"`,
            target,
            outcome: 'cancelled',
            source: 'server',
            detail: timedOut
              ? `Confirmation timed out after ${Math.round(deps.confirmationManager.getTimeoutMs() / 1000)} seconds.`
              : 'User cancelled tool confirmation.',
          });
        },
      });

      return {
        ...outcome,
        pendingConfirmation,
      };
    }

    return outcome;
  });

  app.post('/api/tools/confirm', { preHandler: deps.requireSession }, async (request) => {
    const body = validateInput(ConfirmToolActionSchema, request.body ?? {});
    const resolved = await deps.confirmationManager.resolveConfirmation({
      confirmationId: body.confirmationId,
      decision: body.decision,
      spokenText: body.spokenText,
    });

    if (!resolved.resolved) {
      if (resolved.status === 'timed_out') {
        return {
          ok: false,
          status: 'timed_out' as const,
          errorCode: ErrorCodes.CONFIRMATION_REQUIRED,
          error: 'Confirmation timed out after 20 seconds.',
        };
      }
      if (resolved.status === 'unrecognized_voice_reply') {
        return {
          ok: false,
          status: 'confirmation_required' as const,
          pendingConfirmation: resolved.dto,
          error: 'Did not catch a clear confirmation ("yes/haan/করো/हाँ" or "no/na/না/नहीं").',
        };
      }
      return {
        ok: false,
        status: 'denied' as const,
        errorCode: ErrorCodes.NOT_FOUND,
        error: 'Pending confirmation not found or already resolved.',
      };
    }

    if (resolved.mode === 'action') {
      return resolved.execution;
    }

    return {
      ok: resolved.decision === 'approved',
      toolName: resolved.dto.toolName,
      status: resolved.decision === 'approved' ? ('approved' as const) : ('cancelled' as const),
    };
  });
}
