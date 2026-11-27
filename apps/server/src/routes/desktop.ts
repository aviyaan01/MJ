import type { FastifyInstance, FastifyRequest } from 'fastify';
import {
  AppError,
  ErrorCodes,
  ValidateDesktopActionSchema,
  isApprovedHttpsUrl,
  isForbiddenShellTarget,
  isProtectedSystemPath,
  validateInput,
} from '@mj/shared';
import type { MjDatabaseRepository } from '@mj/database';
import type { PermissionsStore } from '../permissionsStore.js';
import { collectHostTelemetry } from '../systemTelemetry.js';

function normalizeWinPath(input: string): string {
  return input.trim().replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
}

export function registerDesktopRoutes(
  app: FastifyInstance,
  deps: {
    repo: MjDatabaseRepository;
    permissionsStore: PermissionsStore;
    requireSession: (request: FastifyRequest) => Promise<void>;
  },
): void {
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
      const permissions = await deps.permissionsStore.getPermissions();
      const source = body.source ?? 'web';

      if (!permissions[body.capability]) {
        await deps.repo.recordAuditLog({
          capability: body.capability,
          action: body.action,
          target: body.target,
          outcome: 'denied',
          source,
          detail: `Blocked because "${body.capability}" permission is OFF.`,
        });
        throw new AppError({
          code: ErrorCodes.PERMISSION_DENIED,
          category: 'desktop',
          statusCode: 403,
          requestId: request.id,
        });
      }

      if (body.capability === 'appOpening') {
        if (isForbiddenShellTarget(body.target)) {
          await deps.repo.recordAuditLog({
            capability: 'appOpening',
            action: body.action,
            target: body.target,
            outcome: 'denied',
            source,
            detail: 'Blocked arbitrary shell command or interpreter.',
          });
          throw new AppError({
            code: ErrorCodes.SHELL_EXECUTION_FORBIDDEN,
            category: 'desktop',
            statusCode: 403,
            requestId: request.id,
          });
        }

        const approvedApps = await deps.repo.listAllowlist('app');
        const normalizedTarget = normalizeWinPath(body.target);
        const match = approvedApps.find(
          (entry) =>
            normalizeWinPath(entry.target) === normalizedTarget ||
            entry.label.toLowerCase() === body.target.trim().toLowerCase(),
        );
        if (!match) {
          await deps.repo.recordAuditLog({
            capability: 'appOpening',
            action: body.action,
            target: body.target,
            outcome: 'denied',
            source,
            detail: 'Application not found on user allowlist.',
          });
          throw new AppError({
            code: ErrorCodes.UNAPPROVED_TARGET,
            category: 'desktop',
            statusCode: 403,
            requestId: request.id,
          });
        }
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
        const approvedDomains = (await deps.repo.listAllowlist('web_domain')).map(
          (item) => item.target,
        );
        const safeUrl = isApprovedHttpsUrl(body.target, approvedDomains);
        if (!safeUrl) {
          await deps.repo.recordAuditLog({
            capability: 'webLaunch',
            action: body.action,
            target: body.target,
            outcome: 'denied',
            source,
            detail: 'URL must be HTTPS (or localhost) and match an approved domain.',
          });
          throw new AppError({
            code: ErrorCodes.UNAPPROVED_TARGET,
            category: 'desktop',
            statusCode: 403,
            requestId: request.id,
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
}
