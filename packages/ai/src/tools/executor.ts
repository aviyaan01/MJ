import { AppError, ErrorCodes } from '@mj/shared';
import type { ToolRegistry } from './registry.js';
import type { ToolExecutionContext, ToolExecutionResult } from './types.js';

export interface ExecuteToolCallInput {
  name: string;
  args: unknown;
}

/**
 * Executes a requested AI tool call strictly through permission checks, risk gating,
 * target/allowlist preflight, user confirmation (when `risk === 'confirm'`), and audit logging.
 * Unknown or `blocked` tool names are always denied and logged.
 */
export async function executeToolCallSafely(
  registry: ToolRegistry,
  call: ExecuteToolCallInput,
  ctx: ToolExecutionContext,
): Promise<ToolExecutionResult> {
  const toolName = typeof call.name === 'string' ? call.name.trim() : '';
  const tool = registry.get(toolName);

  if (!tool) {
    const detail = `Unknown or unregistered tool "${toolName || '(empty)'}" requested.`;
    await ctx.recordAuditLog({
      capability: 'toolCalling',
      action: 'Blocked unknown AI tool call',
      target: toolName || '(empty)',
      outcome: 'denied',
      source: ctx.source,
      detail,
    });
    return {
      ok: false,
      toolName,
      status: 'denied',
      errorCode: ErrorCodes.PERMISSION_DENIED,
      error: detail,
    };
  }

  const rawArgs =
    call.args && typeof call.args === 'object' && !Array.isArray(call.args)
      ? (call.args as Record<string, unknown>)
      : {};

  if (tool.risk === 'blocked') {
    const detail = `Tool "${tool.name}" is permanently blocked by security policy.`;
    await ctx.recordAuditLog({
      capability: tool.requiredPermission,
      action: `Blocked forbidden AI tool "${tool.name}"`,
      target: String(rawArgs.command ?? rawArgs.target ?? tool.name),
      outcome: 'denied',
      source: ctx.source,
      detail,
    });
    return {
      ok: false,
      toolName: tool.name,
      status: 'denied',
      errorCode: ErrorCodes.SHELL_EXECUTION_FORBIDDEN,
      error: detail,
    };
  }

  const parsed = tool.schema.safeParse(rawArgs);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const detail = issue
      ? `Invalid arguments for "${tool.name}": ${issue.path.join('.') || 'args'} ${issue.message}`
      : `Invalid arguments for "${tool.name}".`;
    await ctx.recordAuditLog({
      capability: tool.requiredPermission,
      action: `Rejected invalid arguments for tool "${tool.name}"`,
      target: tool.name,
      outcome: 'error',
      source: ctx.source,
      detail,
    });
    return {
      ok: false,
      toolName: tool.name,
      status: 'error',
      errorCode: ErrorCodes.VALIDATION_ERROR,
      error: detail,
    };
  }

  const args = parsed.data;
  const target = tool.getTarget ? tool.getTarget(args) : tool.name;
  const summary = tool.summarizeAction ? tool.summarizeAction(args) : `Execute tool ${tool.name}`;

  const permissions = await ctx.getPermissions();
  if (!permissions.toolCalling) {
    const detail = `Tool "${tool.name}" blocked because AI Tool Calling ("toolCalling") is OFF in Privacy & Permissions.`;
    await ctx.recordAuditLog({
      capability: 'toolCalling',
      action: `Blocked AI tool "${tool.name}" (toolCalling OFF)`,
      target,
      outcome: 'denied',
      source: ctx.source,
      detail,
    });
    return {
      ok: false,
      toolName: tool.name,
      status: 'denied',
      errorCode: ErrorCodes.PERMISSION_DENIED,
      error: detail,
    };
  }

  if (!permissions[tool.requiredPermission]) {
    const detail = `Tool "${tool.name}" blocked because "${tool.requiredPermission}" permission is OFF in Privacy & Permissions.`;
    await ctx.recordAuditLog({
      capability: tool.requiredPermission,
      action: `Blocked AI tool "${tool.name}" (${tool.requiredPermission} OFF)`,
      target,
      outcome: 'denied',
      source: ctx.source,
      detail,
    });
    return {
      ok: false,
      toolName: tool.name,
      status: 'denied',
      errorCode: ErrorCodes.PERMISSION_DENIED,
      error: detail,
    };
  }

  if (tool.validatePreflight) {
    const preflight = await tool.validatePreflight(args, ctx);
    if (!preflight.ok) {
      await ctx.recordAuditLog({
        capability: tool.requiredPermission,
        action: `Blocked AI tool "${tool.name}" preflight check`,
        target: preflight.target ?? target,
        outcome: 'denied',
        source: ctx.source,
        detail: preflight.detail,
      });
      return {
        ok: false,
        toolName: tool.name,
        status: 'denied',
        errorCode: preflight.errorCode,
        error: preflight.detail,
      };
    }
  }

  if (tool.risk === 'confirm' && ctx.confirmed !== true) {
    if (!ctx.requestConfirmation) {
      const detail = `Explicit user confirmation is required before running "${tool.name}".`;
      await ctx.recordAuditLog({
        capability: tool.requiredPermission,
        action: `Confirmation required for AI tool "${tool.name}"`,
        target,
        outcome: 'cancelled',
        source: ctx.source,
        detail,
      });
      return {
        ok: false,
        toolName: tool.name,
        status: 'confirmation_required',
        errorCode: ErrorCodes.CONFIRMATION_REQUIRED,
        error: detail,
      };
    }

    const decision = await ctx.requestConfirmation({
      toolName: tool.name,
      args,
      summary,
      requiredPermission: tool.requiredPermission,
      target,
    });

    if (decision !== 'approved') {
      const status = decision === 'timed_out' ? 'timed_out' : 'cancelled';
      const detail =
        decision === 'timed_out'
          ? `Confirmation timed out after 20 seconds for "${tool.name}".`
          : `User cancelled confirmation for "${tool.name}".`;
      await ctx.recordAuditLog({
        capability: tool.requiredPermission,
        action:
          decision === 'timed_out'
            ? `Timed out confirmation for AI tool "${tool.name}"`
            : `Cancelled AI tool "${tool.name}"`,
        target,
        outcome: 'cancelled',
        source: ctx.source,
        detail,
      });
      return {
        ok: false,
        toolName: tool.name,
        status,
        errorCode: ErrorCodes.CONFIRMATION_REQUIRED,
        error: detail,
      };
    }
  }

  let capturedClientAction: ToolExecutionResult['clientAction'];
  const scopedCtx: ToolExecutionContext = {
    ...ctx,
    onClientAction: (action) => {
      capturedClientAction = action;
      ctx.onClientAction?.(action);
    },
  };

  try {
    const result = await tool.execute(args, scopedCtx);
    await ctx.recordAuditLog({
      capability: tool.requiredPermission,
      action: `Executed AI tool "${tool.name}"`,
      target,
      outcome: 'allowed',
      source: ctx.source,
      detail: summary,
    });
    return {
      ok: true,
      toolName: tool.name,
      status: 'executed',
      result,
      ...(capturedClientAction ? { clientAction: capturedClientAction } : {}),
    };
  } catch (err) {
    const errMsg =
      err instanceof AppError
        ? err.message
        : err instanceof Error
          ? err.message
          : String(err);
    await ctx.recordAuditLog({
      capability: tool.requiredPermission,
      action: `AI tool "${tool.name}" execution error`,
      target,
      outcome: 'error',
      source: ctx.source,
      detail: errMsg,
    });
    return {
      ok: false,
      toolName: tool.name,
      status: 'error',
      errorCode: err instanceof AppError ? err.code : ErrorCodes.INTERNAL_ERROR,
      error: errMsg,
    };
  }
}
