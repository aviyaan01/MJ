import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import {
  ALLOWLISTED_DESKTOP_SHORTCUTS,
  ErrorCodes,
  isApprovedHttpsUrl,
  isForbiddenShellTarget,
  isProtectedSystemPath,
  isValidApprovedExecutablePath,
  z,
  type AllowlistEntryDTO,
  type ControllablePermissionKey,
  type DesktopPowerActionKind,
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

function buildOpenUrlValidator() {
  return async (
    rawUrl: string,
    ctx: ToolExecutionContext,
  ): Promise<{ ok: true; safeUrl: string } | { ok: false; errorCode: string; detail: string; target: string }> => {
    const approvedDomains = (await ctx.listAllowlist('web_domain')).map((d) => d.target);
    const safeUrl = isApprovedHttpsUrl(rawUrl, approvedDomains);
    if (!safeUrl) {
      return {
        ok: false,
        errorCode: ErrorCodes.UNAPPROVED_TARGET,
        detail:
          'URL must be HTTPS (or localhost) and its domain must be approved in Privacy & Permissions allowlist.',
        target: rawUrl,
      };
    }
    return { ok: true, safeUrl };
  };
}

function buildYouTubeTargetUrl(queryOrVideoId: string, mode: 'search' | 'play'): string {
  const trimmed = queryOrVideoId.trim();
  if (mode === 'play') {
    if (/^[A-Za-z0-9_-]{11}$/.test(trimmed)) {
      return `https://www.youtube.com/watch?v=${encodeURIComponent(trimmed)}`;
    }
    try {
      const parsed = new URL(trimmed);
      const host = parsed.hostname.toLowerCase();
      if (
        parsed.protocol === 'https:' &&
        (host === 'youtube.com' || host === 'www.youtube.com' || host === 'm.youtube.com' || host === 'youtu.be')
      ) {
        return parsed.toString();
      }
    } catch {
      // Not a full URL — turn search text into safe HTTPS YouTube search results URL
    }
  }
  return `https://www.youtube.com/results?search_query=${encodeURIComponent(trimmed)}`;
}

interface BoundedFileMatch {
  name: string;
  path: string;
  sizeBytes: number;
}

function collectFilesBounded(
  dir: string,
  needle: string,
  depth: number,
  out: BoundedFileMatch[],
): void {
  if (depth > 4 || out.length >= 100) return;
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (out.length >= 100) break;
    const fullPath = join(dir, entry.name);
    if (entry.isDirectory()) {
      collectFilesBounded(fullPath, needle, depth + 1, out);
    } else if (entry.isFile()) {
      if (!needle || entry.name.toLowerCase().includes(needle)) {
        let sizeBytes = 0;
        try {
          sizeBytes = statSync(fullPath).size;
        } catch {
          sizeBytes = 0;
        }
        out.push({
          name: entry.name,
          path: fullPath,
          sizeBytes,
        });
      }
    }
  }
}

  const validateUrl = buildOpenUrlValidator();

  const openApprovedUrlTool = defineTool({
    name: 'open_approved_url',
    description:
      'Opens an allowlisted HTTPS website in the user browser or desktop companion. Requires webLaunch and externalWebServices permissions plus explicit user confirmation.',
    schema: z.object({
      url: z.string().min(8).max(500).describe('Full https:// URL matching an approved web domain.'),
    }),
    risk: 'confirm',
    requiredPermission: 'webLaunch',
    requiredPermissions: ['externalWebServices'],
    getTarget: (args) => args.url,
    summarizeAction: (args) => `Open approved website: ${args.url.trim()}`,
    validatePreflight: async (args, ctx) => validateUrl(args.url, ctx),
    execute: async (args, ctx) => {
      const check = await validateUrl(args.url, ctx);
      if (!check.ok) {
        throw new Error(check.detail);
      }
      ctx.onClientAction?.({ kind: 'open_approved_url', target: check.safeUrl });
      return {
        approved: true,
        url: check.safeUrl,
        action: 'open_approved_url',
        spokenBrief: `Opening ${check.safeUrl}.`,
      };
    },
  });

  const openUrlTool = defineTool({
    name: 'open_url',
    description:
      'Opens an HTTPS URL whose domain is on the user allowlist via the allowlisted opener. Requires webLaunch and externalWebServices plus explicit confirmation.',
    schema: z.object({
      url: z.string().min(8).max(500).describe('Full https:// URL matching an approved domain.'),
    }),
    risk: 'confirm',
    requiredPermission: 'webLaunch',
    requiredPermissions: ['externalWebServices'],
    getTarget: (args) => args.url,
    summarizeAction: (args) => `Open approved URL: ${args.url.trim()}`,
    validatePreflight: async (args, ctx) => validateUrl(args.url, ctx),
    execute: async (args, ctx) => {
      const check = await validateUrl(args.url, ctx);
      if (!check.ok) {
        throw new Error(check.detail);
      }
      ctx.onClientAction?.({ kind: 'open_approved_url', target: check.safeUrl });
      return {
        approved: true,
        url: check.safeUrl,
        action: 'open_approved_url',
        spokenBrief: `Opening ${check.safeUrl}.`,
      };
    },
  });

  const youtubeSearchTool = defineTool({
    name: 'youtube_search',
    description:
      'Opens YouTube search results over HTTPS via the allowlisted URL opener (requires youtube.com in approved web domains, webLaunch, and externalWebServices).',
    schema: z.object({
      query: z.string().min(1).max(200).describe('Search query for YouTube videos.'),
    }),
    risk: 'safe',
    requiredPermission: 'webLaunch',
    requiredPermissions: ['externalWebServices'],
    getTarget: (args) => buildYouTubeTargetUrl(args.query, 'search'),
    summarizeAction: (args) => `Search YouTube for "${args.query.trim()}"`,
    validatePreflight: async (args, ctx) =>
      validateUrl(buildYouTubeTargetUrl(args.query, 'search'), ctx),
    execute: async (args, ctx) => {
      const targetUrl = buildYouTubeTargetUrl(args.query, 'search');
      const check = await validateUrl(targetUrl, ctx);
      if (!check.ok) {
        throw new Error(check.detail);
      }
      ctx.onClientAction?.({ kind: 'open_approved_url', target: check.safeUrl });
      return {
        approved: true,
        query: args.query.trim(),
        url: check.safeUrl,
        spokenBrief: `Opened YouTube search for ${args.query.trim()}.`,
      };
    },
  });

  const youtubePlayTool = defineTool({
    name: 'youtube_play',
    description:
      'Opens a YouTube video URL, video ID, or playback search over HTTPS via the allowlisted URL opener (requires youtube.com allowlisted, webLaunch, and externalWebServices).',
    schema: z.object({
      queryOrVideoId: z
        .string()
        .min(1)
        .max(240)
        .describe('11-character YouTube video ID, https://www.youtube.com/watch URL, or video title.'),
    }),
    risk: 'safe',
    requiredPermission: 'webLaunch',
    requiredPermissions: ['externalWebServices'],
    getTarget: (args) => buildYouTubeTargetUrl(args.queryOrVideoId, 'play'),
    summarizeAction: (args) => `Open YouTube playback for "${args.queryOrVideoId.trim()}"`,
    validatePreflight: async (args, ctx) =>
      validateUrl(buildYouTubeTargetUrl(args.queryOrVideoId, 'play'), ctx),
    execute: async (args, ctx) => {
      const targetUrl = buildYouTubeTargetUrl(args.queryOrVideoId, 'play');
      const check = await validateUrl(targetUrl, ctx);
      if (!check.ok) {
        throw new Error(check.detail);
      }
      ctx.onClientAction?.({ kind: 'open_approved_url', target: check.safeUrl });
      return {
        approved: true,
        url: check.safeUrl,
        spokenBrief: `Opening YouTube for ${args.queryOrVideoId.trim()}.`,
      };
    },
  });

  const webSearchTool = defineTool({
    name: 'web_search',
    description:
      'Searches the live web via server-side Gemini Google Search grounding or configured search API and returns a brief summary with verifiable sources. Requires externalWebServices.',
    schema: z.object({
      query: z.string().min(1).max(300).describe('Clean search query string.'),
      maxResults: z.number().int().min(1).max(8).optional(),
    }),
    risk: 'safe',
    requiredPermission: 'toolCalling',
    requiredPermissions: ['externalWebServices'],
    getTarget: (args) => args.query.trim(),
    summarizeAction: (args) => `Search web for "${args.query.trim()}"`,
    execute: async (args, ctx) => {
      if (!ctx.webSearch) {
        throw new Error('Server web search adapter is not configured.');
      }
      const res = await ctx.webSearch({
        query: args.query.trim(),
        maxResults: args.maxResults ?? 5,
      });
      return {
        query: args.query.trim(),
        provider: res.provider,
        summary: res.summary,
        sources: res.sources,
        queriesUsed: res.queriesUsed ?? [args.query.trim()],
        spokenBrief: res.summary,
      };
    },
  });

  const weatherReportTool = defineTool({
    name: 'weather_report',
    description:
      'Fetches live current weather for a city using the server-side OpenWeather key. Requires externalWebServices.',
    schema: z.object({
      location: z.string().min(1).max(120).describe('City name (e.g. Dhaka, London, Tokyo).'),
      units: z.enum(['metric', 'imperial']).optional(),
    }),
    risk: 'safe',
    requiredPermission: 'toolCalling',
    requiredPermissions: ['externalWebServices'],
    getTarget: (args) => args.location.trim(),
    summarizeAction: (args) => `Check live weather for "${args.location.trim()}"`,
    execute: async (args, ctx) => {
      if (!ctx.getWeatherReport) {
        throw new Error('Server OpenWeather adapter is not configured.');
      }
      return ctx.getWeatherReport({
        location: args.location.trim(),
        units: args.units ?? 'metric',
      });
    },
  });

  const fileSearchTool = defineTool({
    name: 'file_search',
    description:
      'Searches filenames inside a folder approved in Privacy & Permissions allowlist (bounded depth). Requires fileRead permission.',
    schema: z.object({
      folderPath: z.string().min(1).max(300).describe('Absolute path inside an allowlisted folder.'),
      query: z.string().max(120).optional().default('').describe('Substring to match filenames.'),
    }),
    risk: 'safe',
    requiredPermission: 'fileRead',
    getTarget: (args) => args.folderPath,
    summarizeAction: (args) => `Search files in "${args.folderPath.trim()}" matching "${args.query}"`,
    validatePreflight: async (args, ctx) => validateFolderInsideAllowlist(args.folderPath, ctx),
    execute: async (args) => {
      const target = resolve(args.folderPath.trim());
      const needle = (args.query ?? '').trim().toLowerCase();
      const matches: BoundedFileMatch[] = [];
      collectFilesBounded(target, needle, 0, matches);
      return {
        folderPath: target,
        query: needle,
        matchCount: matches.length,
        matches: matches.slice(0, 25),
        spokenBrief:
          matches.length === 0
            ? `No files matched "${needle}" in that approved folder.`
            : `Found ${matches.length} matching file${matches.length === 1 ? '' : 's'}, starting with ${matches[0]!.name}.`,
      };
    },
  });

  const openFolderTool = defineTool({
    name: 'open_folder',
    description:
      'Opens an approved folder in Explorer via the Tauri Desktop Companion (requires fileRead permission and folder allowlist).',
    schema: z.object({
      folderPath: z.string().min(1).max(300).describe('Absolute path inside an allowlisted folder.'),
    }),
    risk: 'safe',
    requiredPermission: 'fileRead',
    getTarget: (args) => args.folderPath,
    summarizeAction: (args) => `Open approved folder "${args.folderPath.trim()}"`,
    validatePreflight: async (args, ctx) => validateFolderInsideAllowlist(args.folderPath, ctx),
    execute: async (args, ctx) => {
      const target = resolve(args.folderPath.trim());
      if (!existsSync(target) || !statSync(target).isDirectory()) {
        throw new Error('Target approved folder does not exist.');
      }
      ctx.onClientAction?.({ kind: 'open_approved_folder', target });
      return {
        approved: true,
        folderPath: target,
        requiresDesktopCompanion: true,
        spokenBrief: `Opening approved folder ${basename(target) || target}.`,
      };
    },
  });

  const organizeFilesTool = defineTool({
    name: 'organize_files',
    description:
      'Organizes files inside an approved folder into Documents, Images, Data, and Other subfolders. Requires fileWrite permission and explicit confirmation.',
    schema: z.object({
      folderPath: z.string().min(1).max(300).describe('Absolute path inside an allowlisted folder.'),
    }),
    risk: 'confirm',
    requiredPermission: 'fileWrite',
    getTarget: (args) => args.folderPath,
    summarizeAction: (args) => `Organize files inside approved folder "${args.folderPath.trim()}"`,
    validatePreflight: async (args, ctx) => validateFolderInsideAllowlist(args.folderPath, ctx),
    execute: async (args) => {
      const root = resolve(args.folderPath.trim());
      const entries = readdirSync(root, { withFileTypes: true });
      let movedCount = 0;
      let skippedCount = 0;
      const details: string[] = [];

      for (const entry of entries) {
        if (!entry.isFile()) continue;
        const src = join(root, entry.name);
        const ext = (entry.name.split('.').pop() ?? '').toLowerCase();
        const category =
          ext === 'pdf' || ext === 'docx' || ext === 'txt' || ext === 'md'
            ? 'Documents'
            : ext === 'png' || ext === 'jpg' || ext === 'jpeg' || ext === 'webp'
              ? 'Images'
              : ext === 'csv' || ext === 'xlsx' || ext === 'json'
                ? 'Data'
                : 'Other';

        const destDir = join(root, category);
        mkdirSync(destDir, { recursive: true });
        const dest = join(destDir, entry.name);
        if (existsSync(dest)) {
          skippedCount += 1;
          continue;
        }
        try {
          renameSync(src, dest);
          movedCount += 1;
          if (details.length < 20) {
            details.push(`${entry.name} -> ${category}/${entry.name}`);
          }
        } catch {
          skippedCount += 1;
        }
      }

      return {
        folderPath: root,
        movedCount,
        skippedCount,
        details,
        spokenBrief: `Organized ${movedCount} file${movedCount === 1 ? '' : 's'} (${skippedCount} skipped) into subfolders.`,
      };
    },
  });

  const clipboardCopyTool = defineTool({
    name: 'clipboard_copy',
    description:
      'Copies text to MJ Assistant in-app clipboard (and writes OS clipboard when permitted). Requires clipboardWrite permission.',
    schema: z.object({
      text: z.string().min(1).max(10000).describe('Text snippet to copy.'),
      label: z.string().max(80).optional().describe('Optional short label for the snippet.'),
    }),
    risk: 'safe',
    requiredPermission: 'clipboardWrite',
    getTarget: (args) => args.label?.trim() || `${args.text.length} chars`,
    summarizeAction: (args) => `Copy ${args.text.length} chars to in-app clipboard`,
    execute: async (args, ctx) => {
      await ctx.setAppClipboard?.({ text: args.text, label: args.label });
      ctx.onClientAction?.({
        kind: 'clipboard_copy',
        text: args.text,
        ...(args.label?.trim() ? { label: args.label.trim() } : {}),
      });
      return {
        copied: true,
        charCount: args.text.length,
        preview: args.text.slice(0, 120),
        spokenBrief: `Copied ${args.text.length} characters cleanly.`,
      };
    },
  });

  const clipboardPasteSummaryTool = defineTool({
    name: 'clipboard_paste_summary',
    description:
      'Summarizes text pasted or copied inside the MJ app (uses provided text or the in-app clipboard buffer, never snooping background OS clipboard).',
    schema: z.object({
      text: z.string().max(12000).optional().describe('Optional explicit pasted text to summarize.'),
      maxBullets: z.number().int().min(1).max(7).optional(),
    }),
    risk: 'safe',
    requiredPermission: 'toolCalling',
    getTarget: () => 'in_app_clipboard',
    summarizeAction: () => 'Summarize text in MJ in-app clipboard',
    execute: async (args, ctx) => {
      const stored = args.text?.trim() ? null : await ctx.getAppClipboard?.();
      const rawText = args.text?.trim() || stored?.text?.trim() || '';
      if (!rawText) {
        return {
          hasContent: false,
          charCount: 0,
          summaryPoints: [],
          spokenBrief:
            'Nothing is in the app clipboard yet. Paste or copy text inside MJ first.',
        };
      }

      const maxBullets = args.maxBullets ?? 4;
      const lines = rawText
        .split(/\r?\n+/)
        .map((l) => l.trim())
        .filter(Boolean);
      const sentences = rawText
        .split(/(?<=[.!?।])\s+|\r?\n+/)
        .map((s) => s.trim())
        .filter((s) => s.length > 0);
      const summaryPoints = sentences.slice(0, maxBullets).map((s) => s.slice(0, 220));
      const wordCount = rawText.split(/\s+/).filter(Boolean).length;
      const spokenBrief =
        summaryPoints.length > 0
          ? `Clipboard has ${wordCount} words across ${lines.length} line${lines.length === 1 ? '' : 's'}. Key point: ${summaryPoints[0]}`
          : `Clipboard has ${wordCount} words.`;

      return {
        hasContent: true,
        ...(stored?.label ? { label: stored.label } : {}),
        charCount: rawText.length,
        wordCount,
        lineCount: lines.length,
        summaryPoints,
        contentPreview: rawText.slice(0, 400),
        spokenBrief,
      };
    },
  });

function findMatchingApprovedApp(
  rawTarget: string,
  apps: AllowlistEntryDTO[],
): AllowlistEntryDTO | undefined {
  const normalized = rawTarget.trim().replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
  return apps.find(
    (entry) =>
      entry.target.trim().replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase() === normalized ||
      entry.label.trim().toLowerCase() === normalized,
  );
}

async function validateApprovedAppEntry(
  rawTargetInput: string,
  ctx: ToolExecutionContext,
): Promise<
  | { ok: true; match: AllowlistEntryDTO }
  | { ok: false; errorCode: string; detail: string; target: string }
> {
  const rawTarget = rawTargetInput.trim();
  if (isForbiddenShellTarget(rawTarget)) {
    return {
      ok: false,
      errorCode: ErrorCodes.SHELL_EXECUTION_FORBIDDEN,
      detail: 'Blocked arbitrary shell command or script interpreter.',
      target: rawTarget,
    };
  }
  const apps = await ctx.listAllowlist('app');
  const match = findMatchingApprovedApp(rawTarget, apps);
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
  return { ok: true, match };
}

function hasControlChars(text: string): boolean {
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (code < 0x20 || code === 0x7f) return true;
  }
  return false;
}

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
      const check = await validateApprovedAppEntry(args.target, ctx);
      return check.ok ? { ok: true } : check;
    },
    execute: async (args, ctx) => {
      const check = await validateApprovedAppEntry(args.target, ctx);
      if (!check.ok) {
        throw new Error(check.detail);
      }
      const { match } = check;
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

  const closeApprovedAppTool = defineTool({
    name: 'close_approved_app',
    description:
      'Closes running processes matching an allowlisted desktop application (no shell or taskkill strings). Requires appClosing permission.',
    schema: z.object({
      target: z
        .string()
        .min(1)
        .max(300)
        .describe('Label or executable path matching an allowlisted desktop application.'),
    }),
    risk: 'safe',
    requiredPermission: 'appClosing',
    getTarget: (args) => args.target,
    summarizeAction: (args) => `Close approved application: ${args.target.trim()}`,
    validatePreflight: async (args, ctx) => {
      const check = await validateApprovedAppEntry(args.target, ctx);
      return check.ok ? { ok: true } : check;
    },
    execute: async (args, ctx) => {
      const check = await validateApprovedAppEntry(args.target, ctx);
      if (!check.ok) {
        throw new Error(check.detail);
      }
      const { match } = check;
      ctx.onClientAction?.({ kind: 'close_approved_app', target: match.target });
      return {
        approved: true,
        label: match.label,
        target: match.target,
        action: 'close_approved_app',
      };
    },
  });

  const getBatteryCpuRamTool = defineTool({
    name: 'get_battery_cpu_ram_status',
    description:
      'Reads real CPU, RAM, and Windows battery metrics (when available via Desktop Companion). Requires systemMonitoring permission.',
    schema: z.object({}),
    risk: 'safe',
    requiredPermission: 'systemMonitoring',
    getTarget: () => 'battery_cpu_ram',
    summarizeAction: () => 'Read local CPU, RAM, and battery status',
    execute: async (_args, ctx) => {
      const t = await ctx.getSystemTelemetry();
      return {
        source: t.source,
        cpu: {
          model: t.cpuModel,
          cores: t.cpuCores,
          usagePercent: t.cpuUsagePercent,
        },
        ram: {
          totalBytes: t.memoryTotalBytes,
          usedBytes: t.memoryUsedBytes,
          availableBytes: t.memoryAvailableBytes ?? Math.max(0, t.memoryTotalBytes - t.memoryUsedBytes),
          usagePercent: t.memoryUsagePercent,
        },
        battery: t.battery,
        collectedAt: t.collectedAt,
      };
    },
  });

  const volumeSetTool = defineTool({
    name: 'volume_set',
    description:
      'Sets Windows system master volume percentage (0-100) via Tauri Desktop Companion. Requires volumeControl permission.',
    schema: z.object({
      level: z.number().int().min(0).max(100).describe('Target system volume percentage from 0 to 100.'),
    }),
    risk: 'safe',
    requiredPermission: 'volumeControl',
    getTarget: (args) => `${args.level}%`,
    summarizeAction: (args) => `Set system volume to ${args.level}%`,
    execute: async (args, ctx) => {
      ctx.onClientAction?.({ kind: 'volume_set', level: args.level });
      return {
        approved: true,
        action: 'volume_set',
        level: args.level,
        requiresDesktopCompanion: true,
      };
    },
  });

  const volumeMuteTool = defineTool({
    name: 'volume_mute',
    description:
      'Mutes or toggles Windows system audio via Tauri Desktop Companion. Requires volumeControl permission.',
    schema: z.object({
      muted: z.boolean().optional().describe('Optional desired mute state hint.'),
    }),
    risk: 'safe',
    requiredPermission: 'volumeControl',
    getTarget: (args) => (args.muted === undefined ? 'toggle_mute' : args.muted ? 'mute' : 'unmute'),
    summarizeAction: () => 'Mute/toggle Windows system volume',
    execute: async (args, ctx) => {
      ctx.onClientAction?.({
        kind: 'volume_mute',
        ...(args.muted !== undefined ? { muted: args.muted } : {}),
      });
      return {
        approved: true,
        action: 'volume_mute',
        ...(args.muted !== undefined ? { muted: args.muted } : {}),
        requiresDesktopCompanion: true,
      };
    },
  });

  const brightnessSetTool = defineTool({
    name: 'brightness_set',
    description:
      'Sets display brightness percentage (0-100) via Tauri Desktop Companion. Requires brightnessControl permission.',
    schema: z.object({
      level: z.number().int().min(0).max(100).describe('Target display brightness percentage from 0 to 100.'),
    }),
    risk: 'safe',
    requiredPermission: 'brightnessControl',
    getTarget: (args) => `${args.level}%`,
    summarizeAction: (args) => `Set display brightness to ${args.level}%`,
    execute: async (args, ctx) => {
      ctx.onClientAction?.({ kind: 'brightness_set', level: args.level });
      return {
        approved: true,
        action: 'brightness_set',
        level: args.level,
        requiresDesktopCompanion: true,
      };
    },
  });

  const lockScreenTool = defineTool({
    name: 'lock_screen',
    description:
      'Locks the Windows workstation screen via Tauri Desktop Companion. Requires lockScreen permission.',
    schema: z.object({}),
    risk: 'safe',
    requiredPermission: 'lockScreen',
    getTarget: () => 'workstation',
    summarizeAction: () => 'Lock Windows workstation screen',
    execute: async (_args, ctx) => {
      ctx.onClientAction?.({ kind: 'lock_screen' });
      return {
        approved: true,
        action: 'lock_screen',
        requiresDesktopCompanion: true,
      };
    },
  });

  const sleepDisplayTool = defineTool({
    name: 'sleep_display',
    description:
      'Puts the display monitor into low-power standby via Tauri Desktop Companion without sleeping the PC. Requires sleepDisplay permission.',
    schema: z.object({}),
    risk: 'safe',
    requiredPermission: 'sleepDisplay',
    getTarget: () => 'display',
    summarizeAction: () => 'Turn display monitor off (standby)',
    execute: async (_args, ctx) => {
      ctx.onClientAction?.({ kind: 'sleep_display' });
      return {
        approved: true,
        action: 'sleep_display',
        requiresDesktopCompanion: true,
      };
    },
  });

  const windowActionTool = defineTool({
    name: 'window_action',
    description:
      'Performs an allowlisted desktop window action (minimize_all, maximize, switch, close_tab). Requires windowControl permission.',
    schema: z.object({
      action: z
        .enum(['minimize_all', 'maximize', 'switch', 'close_tab'])
        .describe('Allowed window action identifier.'),
    }),
    risk: 'safe',
    requiredPermission: 'windowControl',
    getTarget: (args) => args.action,
    summarizeAction: (args) => `Run window action: ${args.action}`,
    execute: async (args, ctx) => {
      ctx.onClientAction?.({ kind: 'window_action', action: args.action });
      return {
        approved: true,
        action: args.action,
        requiresDesktopCompanion: true,
      };
    },
  });

  const typeTextTool = defineTool({
    name: 'type_text',
    description:
      'Types Unicode text into the active desktop window (max 500 printable chars, no control keys). Requires textTyping permission and explicit confirmation.',
    schema: z.object({
      text: z
        .string()
        .min(1)
        .max(500)
        .describe('Plain printable text to type (no control keys or newlines).'),
    }),
    risk: 'confirm',
    requiredPermission: 'textTyping',
    getTarget: (args) => `${args.text.length} chars`,
    summarizeAction: (args) =>
      `Type ${args.text.length} characters into active desktop window: "${args.text.slice(0, 48)}${args.text.length > 48 ? '…' : ''}"`,
    validatePreflight: async (args) => {
      if (hasControlChars(args.text)) {
        return {
          ok: false,
          errorCode: ErrorCodes.VALIDATION_ERROR,
          detail: 'Control characters (including newlines, tabs, ESC, NUL) are forbidden in type_text.',
          target: 'type_text',
        };
      }
      return { ok: true };
    },
    execute: async (args, ctx) => {
      ctx.onClientAction?.({ kind: 'type_text', text: args.text });
      return {
        approved: true,
        action: 'type_text',
        charCount: args.text.length,
        requiresDesktopCompanion: true,
      };
    },
  });

  const pressShortcutTool = defineTool({
    name: 'press_shortcut',
    description:
      'Presses a strictly allowlisted keyboard shortcut on desktop (e.g. Ctrl+C, Ctrl+V, Ctrl+W, Alt+Tab, MediaPlayPause). Requires shortcutPress permission.',
    schema: z.object({
      shortcut: z
        .enum(ALLOWLISTED_DESKTOP_SHORTCUTS)
        .describe('Allowlisted keyboard shortcut name.'),
    }),
    risk: 'safe',
    requiredPermission: 'shortcutPress',
    getTarget: (args) => args.shortcut,
    summarizeAction: (args) => `Press allowlisted shortcut ${args.shortcut}`,
    validatePreflight: async (args) => {
      if (
        isForbiddenShellTarget(args.shortcut) ||
        !ALLOWLISTED_DESKTOP_SHORTCUTS.includes(args.shortcut)
      ) {
        return {
          ok: false,
          errorCode: ErrorCodes.UNAPPROVED_TARGET,
          detail: 'Shortcut is not in the allowlisted desktop shortcut set.',
          target: args.shortcut,
        };
      }
      return { ok: true };
    },
    execute: async (args, ctx) => {
      ctx.onClientAction?.({ kind: 'press_shortcut', shortcut: args.shortcut });
      return {
        approved: true,
        action: 'press_shortcut',
        shortcut: args.shortcut,
        requiresDesktopCompanion: true,
      };
    },
  });

  const createPowerActionTool = (
    name: string,
    action: DesktopPowerActionKind,
    requiredPermission: ControllablePermissionKey,
    description: string,
    summaryLabel: string,
  ) =>
    defineTool({
      name,
      description,
      schema: z.object({}),
      risk: 'confirm',
      requiredPermission,
      getTarget: () => action,
      summarizeAction: () => summaryLabel,
      execute: async (_args, ctx) => {
        ctx.onClientAction?.({ kind: 'power_action', action });
        return {
          approved: true,
          action,
          requiresDesktopCompanion: true,
        };
      },
    });

  const pcShutdownTool = createPowerActionTool(
    'pc_shutdown',
    'shutdown',
    'pcShutdown',
    'Shuts down the Windows PC cleanly via Win32 ExitWindowsEx. Requires pcShutdown permission and explicit spoken or clicked confirmation.',
    'Shut down the Windows PC',
  );
  const pcRestartTool = createPowerActionTool(
    'pc_restart',
    'restart',
    'pcRestart',
    'Restarts the Windows PC cleanly via Win32 ExitWindowsEx. Requires pcRestart permission and explicit spoken or clicked confirmation.',
    'Restart the Windows PC',
  );
  const pcSleepTool = createPowerActionTool(
    'pc_sleep',
    'sleep',
    'pcSleep',
    'Puts the Windows PC into sleep/suspend via Win32 SetSuspendState. Requires pcSleep permission and explicit spoken or clicked confirmation.',
    'Put the Windows PC to sleep',
  );
  const pcLogoffTool = createPowerActionTool(
    'pc_logoff',
    'logoff',
    'pcLogoff',
    'Signs out the current Windows user session via Win32 ExitWindowsEx. Requires pcLogoff permission and explicit spoken or clicked confirmation.',
    'Log off the current Windows session',
  );

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
    getBatteryCpuRamTool,
    listAllowlistTool,
    readApprovedFolderTool,
    readApprovedFileTool,
    writeApprovedNoteTool,
    openApprovedUrlTool,
    openUrlTool,
    youtubeSearchTool,
    youtubePlayTool,
    webSearchTool,
    weatherReportTool,
    fileSearchTool,
    openFolderTool,
    organizeFilesTool,
    clipboardCopyTool,
    clipboardPasteSummaryTool,
    openApprovedAppTool,
    closeApprovedAppTool,
    volumeSetTool,
    volumeMuteTool,
    brightnessSetTool,
    lockScreenTool,
    sleepDisplayTool,
    windowActionTool,
    typeTextTool,
    pressShortcutTool,
    pcShutdownTool,
    pcRestartTool,
    pcSleepTool,
    pcLogoffTool,
    runShellCommandTool,
  ];
}
