import type { FastifyInstance, FastifyRequest } from 'fastify';
import {
  ADMIN_PRIVILEGE_POLICY,
  AppError,
  CreateAllowlistEntrySchema,
  CreateAuditLogSchema,
  ErrorCodes,
  UpdateSinglePermissionSchema,
  isForbiddenShellTarget,
  isProtectedSystemPath,
  normalizeWebDomainTarget,
  validateInput,
  type AuditOutcome,
} from '@mj/shared';
import type { MjDatabaseRepository } from '@mj/database';
import type { PermissionsStore } from '../permissionsStore.js';
import type { RuntimeSettingsStore } from '../settingsStore.js';

export function registerPrivacyRoutes(
  app: FastifyInstance,
  deps: {
    repo: MjDatabaseRepository;
    permissionsStore: PermissionsStore;
    settingsStore: RuntimeSettingsStore;
    requireSession: (request: FastifyRequest) => Promise<void>;
  },
): void {
  app.get('/api/privacy/permissions', { preHandler: deps.requireSession }, async () => {
    const permissions = await deps.permissionsStore.getPermissions();
    return {
      permissions,
      adminPolicy: ADMIN_PRIVILEGE_POLICY,
    };
  });

  app.patch('/api/privacy/permissions', { preHandler: deps.requireSession }, async (request) => {
    const body = validateInput(UpdateSinglePermissionSchema, request.body ?? {});
    const permissions = await deps.permissionsStore.setSinglePermission(
      body.key,
      body.enabled,
      'web',
    );
    return {
      permissions,
      adminPolicy: ADMIN_PRIVILEGE_POLICY,
    };
  });

  app.post('/api/privacy/revoke-desktop', { preHandler: deps.requireSession }, async () => {
    const permissions = await deps.permissionsStore.revokeAllDesktopPermissions('web');
    return {
      permissions,
      adminPolicy: ADMIN_PRIVILEGE_POLICY,
    };
  });

  app.get('/api/privacy/audit-log', { preHandler: deps.requireSession }, async (request) => {
    const query = request.query as {
      capability?: string;
      outcome?: string;
      limit?: string;
    };
    const validOutcome: AuditOutcome | undefined =
      query.outcome === 'allowed' ||
      query.outcome === 'denied' ||
      query.outcome === 'cancelled' ||
      query.outcome === 'error'
        ? query.outcome
        : undefined;
    const parsedLimit = query.limit ? Number(query.limit) : undefined;

    const entries = await deps.repo.listAuditLogs({
      capability: query.capability?.trim() || undefined,
      outcome: validOutcome,
      limit: Number.isFinite(parsedLimit) ? parsedLimit : undefined,
    });
    return { entries };
  });

  app.post('/api/privacy/audit-log', { preHandler: deps.requireSession }, async (request, reply) => {
    const body = validateInput(CreateAuditLogSchema, request.body ?? {});
    const entry = await deps.repo.recordAuditLog(body);
    return reply.status(201).send({ entry });
  });

  app.get('/api/privacy/allowlist', { preHandler: deps.requireSession }, async () => {
    const entries = await deps.repo.listAllowlist();
    return { entries };
  });

  app.post('/api/privacy/allowlist', { preHandler: deps.requireSession }, async (request, reply) => {
    const body = validateInput(CreateAllowlistEntrySchema, request.body ?? {});
    let normalizedTarget = body.target.trim();

    if (body.kind === 'app') {
      if (isForbiddenShellTarget(normalizedTarget)) {
        await deps.repo.recordAuditLog({
          capability: 'appOpening',
          action: 'Blocked shell interpreter in app allowlist',
          target: normalizedTarget,
          outcome: 'denied',
          source: 'server',
          detail: 'Shell interpreters and shell metacharacters are forbidden.',
        });
        throw new AppError({
          code: ErrorCodes.SHELL_EXECUTION_FORBIDDEN,
          category: 'privacy',
          statusCode: 403,
        });
      }
    } else if (body.kind === 'folder') {
      if (isProtectedSystemPath(normalizedTarget)) {
        await deps.repo.recordAuditLog({
          capability: 'fileRead',
          action: 'Blocked protected system folder in allowlist',
          target: normalizedTarget,
          outcome: 'denied',
          source: 'server',
          detail: 'System directories and path traversal sequences cannot be added.',
        });
        throw new AppError({
          code: ErrorCodes.UNAPPROVED_TARGET,
          category: 'privacy',
          statusCode: 403,
          message: 'Protected OS directories or relative parent paths cannot be added to the folder allowlist.',
        });
      }
    } else if (body.kind === 'web_domain') {
      const domain = normalizeWebDomainTarget(normalizedTarget);
      if (!domain) {
        throw new AppError({
          code: ErrorCodes.VALIDATION_ERROR,
          category: 'validation',
          statusCode: 400,
          message: 'Provide a valid HTTPS domain (or localhost) without shell characters.',
        });
      }
      normalizedTarget = domain;
    }

    const entry = await deps.repo.addAllowlistEntry({
      kind: body.kind,
      label: body.label,
      target: normalizedTarget,
    });

    await deps.repo.recordAuditLog({
      capability:
        body.kind === 'app'
          ? 'appOpening'
          : body.kind === 'folder'
            ? 'fileRead'
            : 'webLaunch',
      action: `Added ${body.kind} allowlist entry`,
      target: normalizedTarget,
      outcome: 'allowed',
      source: 'web',
      detail: `Label: ${body.label}`,
    });

    return reply.status(201).send({ entry });
  });

  app.delete(
    '/api/privacy/allowlist/:id',
    { preHandler: deps.requireSession },
    async (request) => {
      const { id } = request.params as { id: string };
      const existing = (await deps.repo.listAllowlist()).find((item) => item.id === id);
      if (!existing) {
        throw new AppError({
          code: ErrorCodes.NOT_FOUND,
          category: 'validation',
          statusCode: 404,
          message: 'Allowlist entry not found.',
        });
      }

      await deps.repo.deleteAllowlistEntry(id);
      await deps.repo.recordAuditLog({
        capability:
          existing.kind === 'app'
            ? 'appOpening'
            : existing.kind === 'folder'
              ? 'fileRead'
              : 'webLaunch',
        action: `Removed ${existing.kind} allowlist entry`,
        target: existing.target,
        outcome: 'allowed',
        source: 'web',
        detail: `Label: ${existing.label}`,
      });

      return { deleted: true, id };
    },
  );

  app.get('/api/privacy/export', { preHandler: deps.requireSession }, async (_request, reply) => {
    const [permissions, settings, personal] = await Promise.all([
      deps.permissionsStore.getPermissions(),
      deps.settingsStore.getPublicSettings(),
      deps.repo.exportPersonalData(),
    ]);

    await deps.repo.recordAuditLog({
      capability: 'privacy_export',
      action: 'Exported personal data archive',
      target: 'local_sqlite_export',
      outcome: 'allowed',
      source: 'web',
      detail: `Exported ${personal.conversations.length} conversations and ${personal.auditLogs.length} audit entries (secrets excluded).`,
    });

    const bundle = {
      exportedAt: new Date().toISOString(),
      stage: 'Stage 4 · Windows Companion & Privacy Hardening',
      note: 'Secrets (XAI_API_KEY, AUTH_SECRET, passcodes) are strictly excluded.',
      permissions,
      settings,
      ...personal,
    };

    return reply
      .header('Content-Disposition', 'attachment; filename="mj-assistant-export.json"')
      .header('Cache-Control', 'no-store')
      .send(bundle);
  });

  app.delete('/api/privacy/conversations', { preHandler: deps.requireSession }, async () => {
    const deletedCount = await deps.repo.clearAllConversations();
    await deps.repo.recordAuditLog({
      capability: 'conversation_history',
      action: 'Cleared all conversation history',
      target: 'conversations_table',
      outcome: 'allowed',
      source: 'web',
      detail: `Deleted ${deletedCount} saved conversations.`,
    });
    return { cleared: true, deletedCount };
  });
}
