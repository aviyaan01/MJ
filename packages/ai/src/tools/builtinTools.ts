import { mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { basename, resolve } from 'node:path';
import {
  ErrorCodes,
  isApprovedHttpsUrl,
  isForbiddenShellTarget,
  isProtectedSystemPath,
  isValidApprovedExecutablePath,
  z,
} from '@mj/shared';
import { toGeminiLiveParametersSchema, zodToToolJsonSchema } from './schema.js';
import type { MjToolDefinition, ToolExecutionContext } from './types.js';

function normalizePath(input: string): string {
  return resolve(input).replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
}

async function validateFolderInsideAllowlist(
  targetPath: string,
  ctx: ToolExecutionContext,
): Promise<
  | { ok: true; resolvedPath: string }
  | { ok: false; errorCode: string; detail: string; target: string }
> {
  const cleaned = targetPath.trim();
  if (!cleaned) {
    return {
      ok: false,
      errorCode: ErrorCodes.VALIDATION_ERROR,
      detail: 'Target folder or file path is empty.',
      target: targetPath,
    };
  }
  if (isProtectedSystemPath(cleaned)) {
    return {
      ok: false,
      errorCode: ErrorCodes.UNAPPROVED_TARGET,
      detail: 'Blocked protected OS path or traversal sequence.',
      target: cleaned,
    };
  }

  const resolvedPath = resolve(cleaned);
  const resolvedNorm = normalizePath(resolvedPath);
  const approvedFolders = await ctx.listAllowlist('folder');
  const insideApproved = approvedFolders.some((entry) => {
    const allowedNorm = normalizePath(entry.target);
    return resolvedNorm === allowedNorm || resolvedNorm.startsWith(`${allowedNorm}/`);
  });

  if (!insideApproved) {
    return {
      ok: false,
      errorCode: ErrorCodes.UNAPPROVED_TARGET,
      detail: 'Path is outside approved folders in Privacy & Permissions allowlist.',
      target: cleaned,
    };
  }

  return { ok: true, resolvedPath };
}

function defineTool<
  TSchema extends z.ZodObject<Record<string, z.ZodTypeAny>>,
>(
  config: Omit<MjToolDefinition<TSchema>, 'jsonSchema' | 'geminiParameters'>,
): MjToolDefinition<TSchema> {
  const jsonSchema = zodToToolJsonSchema(config.schema);
  const geminiParameters = toGeminiLiveParametersSchema(jsonSchema);
  return {
    ...config,
    jsonSchema,
    ...(geminiParameters ? { geminiParameters } : {}),
  };
}

export function createBuiltinTools(): Array<MjToolDefinition<any>> {
  const getCurrentTimeTool = defineTool({
    name: 'get_current_time',
    description:
      'Returns the real current date, local time, weekday, and timezone from the host clock.',
    schema: z.object({
      timeZone: z
        .string()
        .max(64)
        .optional()
        .describe('Optional IANA timezone name such as Asia/Dhaka or UTC.'),
    }),
    risk: 'safe',
    requiredPermission: 'toolCalling',
    getTarget: (args) => args.timeZone?.trim() || 'host_clock',
    summarizeAction: () => 'Read current host date and time',
    execute: async (args) => {
      const now = new Date();
      const requestedTz = args.timeZone?.trim();
      let effectiveTz = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
      let timezoneWarning: string | undefined;

      if (requestedTz) {
        try {
          new Intl.DateTimeFormat('en-US', { timeZone: requestedTz }).format(now);
          effectiveTz = requestedTz;
        } catch {
          timezoneWarning = `Unknown timezone "${requestedTz}"; used "${effectiveTz}".`;
        }
      }

      const formatted = new Intl.DateTimeFormat('en-US', {
        timeZone: effectiveTz,
        dateStyle: 'full',
        timeStyle: 'long',
      }).format(now);

      return {
        iso: now.toISOString(),
        timeZone: effectiveTz,
        formatted,
        ...(timezoneWarning ? { warning: timezoneWarning } : {}),
      };
    },
  });

  const getUsageSummaryTool = defineTool({
    name: 'get_usage_summary',
    description:
      'Returns today and monthly AI usage metrics, token totals, estimated spend, and budget status from SQLite.',
    schema: z.object({
      period: z
        .enum(['today', 'month', 'all'])
        .optional()
        .describe('Which summary period to emphasize.'),
    }),
    risk: 'safe',
    requiredPermission: 'toolCalling',
    getTarget: (args) => args.period ?? 'all',
    summarizeAction: () => 'Read MJ usage and budget summary',
    execute: async (args, ctx) => {
      const summary = await ctx.getUsageSummary();
      const period = args.period ?? 'all';
      return {
        period,
        ...(period === 'today' ? { today: summary.today } : {}),
        ...(period === 'month' ? { month: summary.month } : {}),
        ...(period === 'all' ? { today: summary.today, month: summary.month } : {}),
        budgetStatus: summary.budgetStatus,
      };
    },
  });

  const searchConversationsTool = defineTool({
    name: 'search_conversations',
    description:
      'Searches saved conversations in the local MJ SQLite database by title or message content.',
    schema: z.object({
      query: z.string().min(1).max(120).describe('Keywords to search across saved conversations.'),
      limit: z.number().int().min(1).max(10).optional().describe('Maximum matches to return (1-10).'),
    }),
    risk: 'safe',
    requiredPermission: 'toolCalling',
    getTarget: (args) => args.query,
    summarizeAction: (args) => `Search conversations for "${args.query}"`,
    execute: async (args, ctx) => {
      const matches = await ctx.searchConversations(args.query, args.limit ?? 5);
      return {
        count: matches.length,
        conversations: matches.slice(0, args.limit ?? 5).map((c) => ({
          id: c.id,
          title: c.title,
          messageCount: c.messageCount,
          updatedAt: c.updatedAt,
          preview: c.lastMessagePreview ?? '',
        })),
      };
    },
  });

  const getSystemStatusTool = defineTool({
    name: 'get_system_status',
    description:
      'Reads real local host telemetry (CPU usage, memory usage, OS, storage, and network connectivity). Requires systemMonitoring permission.',
    schema: z.object({}),
    risk: 'safe',
    requiredPermission: 'systemMonitoring',
    getTarget: () => 'host_os_telemetry',
    summarizeAction: () => 'Read local host CPU, memory, and disk telemetry',
    execute: async (_args, ctx) => {
      const telemetry = await ctx.getSystemTelemetry();
      return { telemetry };
    },
  });

  const listAllowlistTool = defineTool({
    name: 'list_allowlist_entries',
    description:
      'Lists approved apps, folders, and web domains configured in Privacy & Permissions.',
    schema: z.object({
      kind: z.enum(['app', 'folder', 'web_domain']).optional(),
    }),
    risk: 'safe',
    requiredPermission: 'toolCalling',
    getTarget: (args) => args.kind ?? 'all_allowlist',
    summarizeAction: () => 'Read configured allowlist targets',
    execute: async (args, ctx) => {
      const entries = await ctx.listAllowlist(args.kind);
      return {
        count: entries.length,
        entries: entries.map((e) => ({
          kind: e.kind,
          label: e.label,
          target: e.target,
        })),
      };
    },
  });

  const readApprovedFolderTool = defineTool({
    name: 'read_approved_folder',
    description:
      'Lists files and subfolders inside a folder approved in Privacy & Permissions allowlist. Requires fileRead permission.',
    schema: z.object({
      path: z.string().min(1).max(300).describe('Absolute path inside an allowlisted folder.'),
    }),
    risk: 'safe',
    requiredPermission: 'fileRead',
    getTarget: (args) => args.path,
    summarizeAction: (args) => `List files in approved folder "${args.path}"`,
    validatePreflight: async (args, ctx) => validateFolderInsideAllowlist(args.path, ctx),
    execute: async (args) => {
      const target = resolve(args.path.trim());
      const dirents = readdirSync(target, { withFileTypes: true });
      const items = dirents.slice(0, 50).map((d) => ({
        name: d.name,
        kind: d.isDirectory() ? 'directory' : 'file',
      }));
      return {
        path: target,
        totalCount: dirents.length,
        entries: items,
      };
    },
  });

  const readApprovedFileTool = defineTool({
    name: 'read_approved_file',
    description:
      'Reads UTF-8 text from a file inside a folder approved in Privacy & Permissions allowlist. Requires fileRead permission.',
    schema: z.object({
      path: z.string().min(1).max(360).describe('Absolute path of the file inside an allowlisted folder.'),
      maxChars: z.number().int().min(100).max(16000).optional(),
    }),
    risk: 'safe',
    requiredPermission: 'fileRead',
    getTarget: (args) => args.path,
    summarizeAction: (args) => `Read file "${args.path}"`,
    validatePreflight: async (args, ctx) => validateFolderInsideAllowlist(args.path, ctx),
    execute: async (args) => {
      const target = resolve(args.path.trim());
      const stats = statSync(target);
      if (!stats.isFile()) {
        throw new Error('Target path is not a regular file.');
      }
      const limit = args.maxChars ?? 4000;
      const raw = readFileSync(target, 'utf8');
      return {
        path: target,
        truncated: raw.length > limit,
        sizeBytes: stats.size,
        content: raw.slice(0, limit),
      };
    },
  });

  const writeApprovedNoteTool = defineTool({
    name: 'write_approved_note',
    description:
      'Creates or updates a .txt or .md note file inside an allowlisted folder. Requires fileWrite permission and explicit user confirmation.',
    schema: z.object({
      folderPath: z.string().min(1).max(300).describe('Approved parent folder path.'),
      fileName: z
        .string()
        .min(1)
        .max(80)
        .describe('Note filename ending in .txt or .md (no path separators).'),
      content: z.string().min(1).max(20000).describe('UTF-8 text or Markdown content to write.'),
    }),
    risk: 'confirm',
    requiredPermission: 'fileWrite',
    getTarget: (args) => `${args.folderPath.trim()}/${args.fileName.trim()}`,
    summarizeAction: (args) =>
      `Write note "${args.fileName.trim()}" inside "${args.folderPath.trim()}" (${args.content.length} chars)`,
    validatePreflight: async (args, ctx) => {
      const cleanName = basename(args.fileName.trim());
      if (
        cleanName !== args.fileName.trim() ||
        cleanName.includes('..') ||
        cleanName.includes('/') ||
        cleanName.includes('\\') ||
        !/\.(txt|md)$/i.test(cleanName)
      ) {
        return {
          ok: false,
          errorCode: ErrorCodes.VALIDATION_ERROR,
          detail: 'fileName must be a plain .txt or .md filename without path separators.',
          target: args.fileName,
        };
      }
      const combined = resolve(args.folderPath.trim(), cleanName);
      return validateFolderInsideAllowlist(combined, ctx);
    },
    execute: async (args) => {
      const cleanName = basename(args.fileName.trim());
      const targetFolder = resolve(args.folderPath.trim());
      mkdirSync(targetFolder, { recursive: true });
      const targetFile = resolve(targetFolder, cleanName);
      writeFileSync(targetFile, args.content, 'utf8');
      return {
        written: true,
        path: targetFile,
        bytesWritten: Buffer.byteLength(args.content, 'utf8'),
      };
    },
  });

  const openApprovedUrlTool = defineTool({
    name: 'open_approved_url',
    description:
      'Opens an allowlisted HTTPS website in the user browser or desktop companion. Requires webLaunch permission and explicit user confirmation.',
    schema: z.object({
      url: z.string().min(8).max(500).describe('Full https:// URL matching an approved web domain.'),
    }),
    risk: 'confirm',
    requiredPermission: 'webLaunch',
    getTarget: (args) => args.url,
    summarizeAction: (args) => `Open approved website: ${args.url.trim()}`,
    validatePreflight: async (args, ctx) => {
      const approvedDomains = (await ctx.listAllowlist('web_domain')).map((d) => d.target);
      const safeUrl = isApprovedHttpsUrl(args.url, approvedDomains);
      if (!safeUrl) {
        return {
          ok: false,
          errorCode: ErrorCodes.UNAPPROVED_TARGET,
          detail: 'URL must be HTTPS (or localhost) and match an approved domain in Privacy & Permissions.',
          target: args.url,
        };
      }
      return { ok: true };
    },
    execute: async (args, ctx) => {
      const approvedDomains = (await ctx.listAllowlist('web_domain')).map((d) => d.target);
      const safeUrl = isApprovedHttpsUrl(args.url, approvedDomains);
      if (!safeUrl) {
        throw new Error('URL failed allowlist verification.');
      }
      ctx.onClientAction?.({ kind: 'open_approved_url', target: safeUrl });
      return {
        approved: true,
        url: safeUrl,
        action: 'open_approved_url',
      };
    },
  });

  const openApprovedAppTool = defineTool({
    name: 'open_approved_app',
    description:
      'Launches an application on the user allowlist (no shell interpreters allowed). Requires appOpening permission and explicit user confirmation.',
    schema: z.object({
      target: z
        .string()
        .min(1)
        .max(300)
        .describe('Label or executable path matching an allowlisted desktop application.'),
    }),
    risk: 'confirm',
    requiredPermission: 'appOpening',
    getTarget: (args) => args.target,
    summarizeAction: (args) => `Open approved application: ${args.target.trim()}`,
    validatePreflight: async (args, ctx) => {
      const rawTarget = args.target.trim();
      if (isForbiddenShellTarget(rawTarget)) {
        return {
          ok: false,
          errorCode: ErrorCodes.SHELL_EXECUTION_FORBIDDEN,
          detail: 'Blocked arbitrary shell command or script interpreter.',
          target: rawTarget,
        };
      }
      const apps = await ctx.listAllowlist('app');
      const normalized = rawTarget.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
      const match = apps.find(
        (entry) =>
          entry.target.trim().replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase() === normalized ||
          entry.label.trim().toLowerCase() === normalized,
      );
      if (!match || !isValidApprovedExecutablePath(match.target)) {
        return {
          ok: false,
          errorCode: ErrorCodes.UNAPPROVED_TARGET,
          detail: match
            ? 'Approved entry failed strict .exe validation.'
            : 'Application is not in the Privacy & Permissions allowlist.',
          target: rawTarget,
        };
      }
      return { ok: true };
    },
    execute: async (args, ctx) => {
      const rawTarget = args.target.trim();
      const apps = await ctx.listAllowlist('app');
      const normalized = rawTarget.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
      const match = apps.find(
        (entry) =>
          entry.target.trim().replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase() === normalized ||
          entry.label.trim().toLowerCase() === normalized,
      );
      if (!match || !isValidApprovedExecutablePath(match.target)) {
        throw new Error('Application failed allowlist verification.');
      }
      const launchRes = ctx.launchApprovedApp
        ? await ctx.launchApprovedApp(match.target)
        : { executed: false };
      ctx.onClientAction?.({ kind: 'open_approved_app', target: match.target });
      return {
        approved: true,
        label: match.label,
        target: match.target,
        executedOnHost: launchRes.executed,
        ...(launchRes.detail ? { detail: launchRes.detail } : {}),
      };
    },
  });

  // Explicitly registered blocked tool: never advertised to models, always denied if invoked.
  const runShellCommandTool = defineTool({
    name: 'run_shell_command',
    description: 'Arbitrary shell execution is permanently disabled by security policy.',
    schema: z.object({
      command: z.string().min(1).max(500),
    }),
    risk: 'blocked',
    requiredPermission: 'appOpening',
    getTarget: (args) => args.command,
    summarizeAction: (args) => `Blocked shell command: ${args.command}`,
    execute: async () => {
      throw new Error('Arbitrary shell execution is permanently blocked.');
    },
  });

  return [
    getCurrentTimeTool,
    getUsageSummaryTool,
    searchConversationsTool,
    getSystemStatusTool,
    listAllowlistTool,
    readApprovedFolderTool,
    readApprovedFileTool,
    writeApprovedNoteTool,
    openApprovedUrlTool,
    openApprovedAppTool,
    runShellCommandTool,
  ];
}
