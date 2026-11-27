import type { FastifyInstance, FastifyRequest } from 'fastify';
import {
  AppError,
  CreateShortcutSchema,
  ErrorCodes,
  ValidateDesktopActionSchema,
  isApprovedHttpsUrl,
  isForbiddenShellTarget,
  isProtectedSystemPath,
  isValidApprovedExecutablePath,
  normalizeShortcutAccelerator,
  validateInput,
  type AuditSource,
  type OsCapabilityKey,
} from '@mj/shared';
import type { MjDatabaseRepository } from '@mj/database';
import type { PermissionsStore } from '../permissionsStore.js';
import type { ShortcutsStore } from '../shortcutsStore.js';
import { collectHostTelemetry } from '../systemTelemetry.js';

function normalizeWinPath(input: string): string {
  return input.trim().replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
}

export function registerDesktopRoutes(
  app: FastifyInstance,
  deps: {
    repo: MjDatabaseRepository;
    permissionsStore: PermissionsStore;
    shortcutsStore: ShortcutsStore;
    requireSession: (request: FastifyRequest) => Promise<void>;
  },
): void {
  async function assertCapabilityEnabled(params: {
    capability: OsCapabilityKey;
    action: string;
    target: string;
    source: AuditSource;
    requestId: string;
    detail?: string;
  }): Promise<void> {
    const permissions = await deps.permissionsStore.getPermissions();
    if (!permissions[params.capability]) {
      await deps.repo.recordAuditLog({
        capability: params.capability,
        action: params.action,
        target: params.target,
        outcome: 'denied',
        source: params.source,
        detail: params.detail ?? `Blocked because "${params.capability}" permission is OFF.`,
      });
      throw new AppError({
        code: ErrorCodes.PERMISSION_DENIED,
        category: 'desktop',
        statusCode: 403,
        requestId: params.requestId,
      });
    }
  }

  async function validateApprovedAppTarget(params: {
    capability: 'appOpening' | 'configurableShortcuts';
    action: string;
    target: string;
    source: AuditSource;
    requestId: string;
  }): Promise<void> {
    if (isForbiddenShellTarget(params.target)) {
      await deps.repo.recordAuditLog({
        capability: params.capability,
        action: params.action,
        target: params.target,
        outcome: 'denied',
        source: params.source,
        detail: 'Blocked arbitrary shell command or interpreter.',
      });
      throw new AppError({
        code: ErrorCodes.SHELL_EXECUTION_FORBIDDEN,
        category: 'desktop',
        statusCode: 403,
        requestId: params.requestId,
      });
    }

    const approvedApps = await deps.repo.listAllowlist('app');
    const normalizedTarget = normalizeWinPath(params.target);
    const match = approvedApps.find(
      (entry) =>
        normalizeWinPath(entry.target) === normalizedTarget ||
        entry.label.toLowerCase() === params.target.trim().toLowerCase(),
    );
    if (!match || !isValidApprovedExecutablePath(match.target)) {
      await deps.repo.recordAuditLog({
        capability: params.capability,
        action: params.action,
        target: params.target,
        outcome: 'denied',
        source: params.source,
        detail: match
          ? 'Approved entry failed strict .exe / LOLBin validation.'
          : 'Application not found on user allowlist.',
      });
      throw new AppError({
        code: ErrorCodes.UNAPPROVED_TARGET,
        category: 'desktop',
        statusCode: 403,
        requestId: params.requestId,
      });
    }
  }

  async function validateApprovedUrlTarget(params: {
    capability: 'webLaunch' | 'configurableShortcuts';
    action: string;
    target: string;
    source: AuditSource;
    requestId: string;
  }): Promise<string> {
    const approvedDomains = (await deps.repo.listAllowlist('web_domain')).map(
      (item) => item.target,
    );
    const safeUrl = isApprovedHttpsUrl(params.target, approvedDomains);
    if (!safeUrl) {
      await deps.repo.recordAuditLog({
        capability: params.capability,
        action: params.action,
        target: params.target,
        outcome: 'denied',
        source: params.source,
        detail: 'URL must be HTTPS (or localhost) and match an approved domain.',
      });
      throw new AppError({
        code: ErrorCodes.UNAPPROVED_TARGET,
        category: 'desktop',
        statusCode: 403,
        requestId: params.requestId,
      });
    }
    return safeUrl;
  }

  app.get('/api/desktop/system-status', { preHandler: deps.requireSession }, async (request) => {
    const permissions = await deps.permissionsStore.getPermissions();
    if (!permissions.systemMonitoring) {
      await deps.repo.recordAuditLog({
        capability: 'systemMonitoring',
        action: 'Blocked system status telemetry read',
        target: 'host_os_metrics',
        outcome: 'denied',
        source: 'server',
        detail: 'systemMonitoring capability is OFF.',
      });
      throw new AppError({
        code: ErrorCodes.PERMISSION_DENIED,
        category: 'desktop',
        statusCode: 403,
        requestId: request.id,
        message: 'System monitoring is disabled. Enable it individually in Privacy & Permissions.',
      });
    }

    const telemetry = await collectHostTelemetry();
    await deps.repo.recordAuditLog({
      capability: 'systemMonitoring',
      action: 'Read permitted local host telemetry',
      target: `${telemetry.platform}/${telemetry.arch}`,
      outcome: 'allowed',
      source: 'server',
      detail: 'CPU, memory, storage, and network status collected (asInvoker).',
    });

    return { telemetry };
  });

  app.post(
    '/api/desktop/validate-action',
    { preHandler: deps.requireSession },
    async (request) => {
      const body = validateInput(ValidateDesktopActionSchema, request.body ?? {});
      const source = body.source ?? 'web';

      await assertCapabilityEnabled({
        capability: body.capability,
        action: body.action,
        target: body.target,
        source,
        requestId: request.id,
      });

      if (body.capability === 'appOpening') {
        await validateApprovedAppTarget({
          capability: 'appOpening',
          action: body.action,
          target: body.target,
          source,
          requestId: request.id,
        });
      } else if (body.capability === 'fileRead' || body.capability === 'fileWrite') {
        if (isProtectedSystemPath(body.target)) {
          await deps.repo.recordAuditLog({
            capability: body.capability,
            action: body.action,
            target: body.target,
            outcome: 'denied',
            source,
            detail: 'Blocked protected OS path or traversal sequence.',
          });
          throw new AppError({
            code: ErrorCodes.UNAPPROVED_TARGET,
            category: 'desktop',
            statusCode: 403,
            requestId: request.id,
          });
        }

        const approvedFolders = await deps.repo.listAllowlist('folder');
        const targetNorm = normalizeWinPath(body.target);
        const insideApproved = approvedFolders.some((folder) => {
          const folderNorm = normalizeWinPath(folder.target);
          return targetNorm === folderNorm || targetNorm.startsWith(`${folderNorm}/`);
        });

        if (!insideApproved) {
          await deps.repo.recordAuditLog({
            capability: body.capability,
            action: body.action,
            target: body.target,
            outcome: 'denied',
            source,
            detail: 'Path is outside approved user folders.',
          });
          throw new AppError({
            code: ErrorCodes.UNAPPROVED_TARGET,
            category: 'desktop',
            statusCode: 403,
            requestId: request.id,
          });
        }

        if (body.capability === 'fileWrite' && body.confirmed !== true) {
          await deps.repo.recordAuditLog({
            capability: 'fileWrite',
            action: body.action,
            target: body.target,
            outcome: 'cancelled',
            source,
            detail: 'Awaiting explicit confirmation for file write/organization.',
          });
          throw new AppError({
            code: ErrorCodes.CONFIRMATION_REQUIRED,
            category: 'desktop',
            statusCode: 409,
            requestId: request.id,
          });
        }
      } else if (body.capability === 'webLaunch') {
        await validateApprovedUrlTarget({
          capability: 'webLaunch',
          action: body.action,
          target: body.target,
          source,
          requestId: request.id,
        });
      } else if (body.capability === 'configurableShortcuts') {
        const normalized = normalizeShortcutAccelerator(body.target);
        if (!normalized) {
          await deps.repo.recordAuditLog({
            capability: 'configurableShortcuts',
            action: body.action,
            target: body.target,
            outcome: 'denied',
            source,
            detail: 'Invalid shortcut key combination or unsafe characters.',
          });
          throw new AppError({
            code: ErrorCodes.VALIDATION_ERROR,
            category: 'validation',
            statusCode: 400,
            requestId: request.id,
            message: 'Shortcut must include Ctrl, Alt, or Meta plus a valid key.',
          });
        }
      }

      const auditEntry = await deps.repo.recordAuditLog({
        capability: body.capability,
        action: body.action,
        target: body.target,
        outcome: 'allowed',
        source,
      });

      return { approved: true, auditEntry };
    },
  );

  app.get('/api/desktop/shortcuts', { preHandler: deps.requireSession }, async () => {
    const [permissions, shortcuts] = await Promise.all([
      deps.permissionsStore.getPermissions(),
      deps.shortcutsStore.listShortcuts(),
    ]);
    return {
      enabled: permissions.configurableShortcuts,
      shortcuts,
    };
  });

  app.post('/api/desktop/shortcuts', { preHandler: deps.requireSession }, async (request, reply) => {
    const body = validateInput(CreateShortcutSchema, request.body ?? {});

    await assertCapabilityEnabled({
      capability: 'configurableShortcuts',
      action: 'Configure desktop shortcut',
      target: `${body.accelerator} -> ${body.action}`,
      source: 'web',
      requestId: request.id,
    });

    const normalizedAcc = normalizeShortcutAccelerator(body.accelerator);
    if (!normalizedAcc) {
      await deps.repo.recordAuditLog({
        capability: 'configurableShortcuts',
        action: 'Rejected unsafe or invalid shortcut accelerator',
        target: body.accelerator,
        outcome: 'denied',
        source: 'web',
        detail: 'Shortcuts require Ctrl, Alt, or Meta + a valid key and forbid shell characters.',
      });
      throw new AppError({
        code: ErrorCodes.VALIDATION_ERROR,
        category: 'validation',
        statusCode: 400,
        requestId: request.id,
        message: 'Provide a valid shortcut such as Ctrl+Shift+M or Alt+K (no plain single keys or shell symbols).',
      });
    }

    const existing = await deps.shortcutsStore.listShortcuts();
    if (existing.some((item) => item.accelerator === normalizedAcc)) {
      throw new AppError({
        code: ErrorCodes.VALIDATION_ERROR,
        category: 'validation',
        statusCode: 400,
        requestId: request.id,
        message: `Shortcut "${normalizedAcc}" is already bound to another action.`,
      });
    }

    let resolvedTarget: string | undefined;
    if (body.action === 'open_approved_app') {
      const target = body.target?.trim() ?? '';
      if (!target) {
        throw new AppError({
          code: ErrorCodes.VALIDATION_ERROR,
          category: 'validation',
          statusCode: 400,
          requestId: request.id,
          message: 'Select an allowlisted application target for this shortcut.',
        });
      }
      await validateApprovedAppTarget({
        capability: 'configurableShortcuts',
        action: 'Bind shortcut to approved application',
        target,
        source: 'web',
        requestId: request.id,
      });
      resolvedTarget = target;
    } else if (body.action === 'open_approved_url') {
      const target = body.target?.trim() ?? '';
      resolvedTarget = await validateApprovedUrlTarget({
        capability: 'configurableShortcuts',
        action: 'Bind shortcut to approved HTTPS URL',
        target,
        source: 'web',
        requestId: request.id,
      });
    }

    const shortcut = await deps.shortcutsStore.addShortcut(
      {
        label: body.label,
        accelerator: normalizedAcc,
        action: body.action,
        ...(resolvedTarget ? { target: resolvedTarget } : {}),
      },
      'web',
    );

    return reply.status(201).send({ shortcut });
  });

  app.delete('/api/desktop/shortcuts/:id', { preHandler: deps.requireSession }, async (request) => {
    const { id } = request.params as { id: string };
    await assertCapabilityEnabled({
      capability: 'configurableShortcuts',
      action: 'Remove desktop shortcut',
      target: id,
      source: 'web',
      requestId: request.id,
    });

    const removed = await deps.shortcutsStore.removeShortcut(id, 'web');
    if (!removed) {
      throw new AppError({
        code: ErrorCodes.NOT_FOUND,
        category: 'validation',
        statusCode: 404,
        requestId: request.id,
        message: 'Configured shortcut not found.',
      });
    }
    return { deleted: true, id };
  });

  app.post('/api/desktop/shortcuts/:id/trigger', { preHandler: deps.requireSession }, async (request) => {
    const { id } = request.params as { id: string };
    const body = (request.body ?? {}) as { source?: AuditSource };
    const source: AuditSource = body.source === 'desktop-tauri' ? 'desktop-tauri' : 'web';

    const shortcuts = await deps.shortcutsStore.listShortcuts();
    const shortcut = shortcuts.find((s) => s.id === id);
    if (!shortcut) {
      throw new AppError({
        code: ErrorCodes.NOT_FOUND,
        category: 'validation',
        statusCode: 404,
        requestId: request.id,
        message: 'Configured shortcut not found.',
      });
    }

    await assertCapabilityEnabled({
      capability: 'configurableShortcuts',
      action: `Blocked shortcut trigger (${shortcut.accelerator})`,
      target: `${shortcut.accelerator} -> ${shortcut.action}`,
      source,
      requestId: request.id,
    });

    if (shortcut.action === 'open_approved_app') {
      await assertCapabilityEnabled({
        capability: 'appOpening',
        action: `Shortcut "${shortcut.accelerator}" launch blocked`,
        target: shortcut.target ?? '(none)',
        source,
        requestId: request.id,
        detail: 'App-launch shortcut requires appOpening capability to be ON.',
      });
      await validateApprovedAppTarget({
        capability: 'configurableShortcuts',
        action: `Trigger shortcut "${shortcut.accelerator}" app launch`,
        target: shortcut.target ?? '',
        source,
        requestId: request.id,
      });
    } else if (shortcut.action === 'open_approved_url') {
      await assertCapabilityEnabled({
        capability: 'webLaunch',
        action: `Shortcut "${shortcut.accelerator}" URL blocked`,
        target: shortcut.target ?? '(none)',
        source,
        requestId: request.id,
        detail: 'URL-launch shortcut requires webLaunch capability to be ON.',
      });
      await validateApprovedUrlTarget({
        capability: 'configurableShortcuts',
        action: `Trigger shortcut "${shortcut.accelerator}" URL launch`,
        target: shortcut.target ?? '',
        source,
        requestId: request.id,
      });
    }

    const auditEntry = await deps.repo.recordAuditLog({
      capability: 'configurableShortcuts',
      action: `Triggered shortcut "${shortcut.label}" (${shortcut.accelerator})`,
      target: `${shortcut.action}${shortcut.target ? ` -> ${shortcut.target}` : ''}`,
      outcome: 'allowed',
      source,
    });

    return { executed: true, shortcut, auditEntry };
  });
}
