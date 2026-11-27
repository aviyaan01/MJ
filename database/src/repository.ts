import { randomUUID } from 'node:crypto';
import { asc, desc, eq, gte, sql } from 'drizzle-orm';
import {
  AppError,
  ErrorCodes,
  evaluateBudgetStatus,
  sanitizeDiagnosticText,
  type AllowlistEntryDTO,
  type AllowlistKind,
  type AuditLogEntryDTO,
  type AuditOutcome,
  type AuditSource,
  type BudgetSettings,
  type ConversationDTO,
  type ConversationDetailDTO,
  type MessageChannel,
  type MessageDTO,
  type MessageRole,
  type MessageStatus,
  type TokenUsage,
  type UsageKind,
  type UsageSummaryDTO,
} from '@mj/shared';
import { mapDatabaseError, type MjDatabaseHandle } from './client.js';
import {
  appSettings,
  conversations,
  desktopAllowlist,
  messages,
  privilegedAuditLogs,
  usageLogs,
} from './schema.js';

export interface AddMessageInput {
  id?: string;
  conversationId: string;
  role: MessageRole;
  content: string;
  channel?: MessageChannel;
  status?: MessageStatus;
  model?: string | null;
  xaiResponseId?: string | null;
  usage?: TokenUsage;
  latencyMs?: number | null;
  estimatedCostUsd?: number | null;
  errorCode?: string | null;
}

export interface UpdateMessageInput {
  content?: string;
  status?: MessageStatus;
  model?: string | null;
  xaiResponseId?: string | null;
  usage?: TokenUsage;
  latencyMs?: number | null;
  estimatedCostUsd?: number | null;
  errorCode?: string | null;
}

export class MjDatabaseRepository {
  constructor(private readonly handle: MjDatabaseHandle) {}

  public async createConversation(params: {
    title?: string;
    model: string;
  }): Promise<ConversationDTO> {
    try {
      const now = new Date().toISOString();
      const id = randomUUID();
      const title = params.title?.trim() || 'New conversation';

      await this.handle.db.insert(conversations).values({
        id,
        title,
        model: params.model,
        createdAt: now,
        updatedAt: now,
      });

      return {
        id,
        title,
        model: params.model,
        createdAt: now,
        updatedAt: now,
        messageCount: 0,
      };
    } catch (err) {
      throw mapDatabaseError(err, 'query');
    }
  }

  public async listConversations(search?: string): Promise<ConversationDTO[]> {
    try {
      const rows = await this.handle.db
        .select()
        .from(conversations)
        .orderBy(desc(conversations.updatedAt));

      const allMessages = await this.handle.db
        .select({
          conversationId: messages.conversationId,
          content: messages.content,
          createdAt: messages.createdAt,
        })
        .from(messages)
        .orderBy(asc(messages.createdAt));

      const statsByConv = new Map<string, { count: number; lastPreview: string }>();
      for (const msg of allMessages) {
        const current = statsByConv.get(msg.conversationId) ?? { count: 0, lastPreview: '' };
        const clean = msg.content.replace(/\s+/g, ' ').trim();
        current.count += 1;
        if (clean) {
          current.lastPreview = clean.length > 96 ? `${clean.slice(0, 93)}...` : clean;
        }
        statsByConv.set(msg.conversationId, current);
      }

      const normalizedSearch = search?.trim().toLowerCase() ?? '';
      const mapped = rows.map((row) => {
        const stats = statsByConv.get(row.id);
        return {
          id: row.id,
          title: row.title,
          model: row.model,
          createdAt: row.createdAt,
          updatedAt: row.updatedAt,
          messageCount: stats?.count ?? 0,
          ...(stats?.lastPreview ? { lastMessagePreview: stats.lastPreview } : {}),
        };
      });

      if (!normalizedSearch) return mapped;

      return mapped.filter(
        (conv) =>
          conv.title.toLowerCase().includes(normalizedSearch) ||
          (conv.lastMessagePreview?.toLowerCase().includes(normalizedSearch) ?? false),
      );
    } catch (err) {
      throw mapDatabaseError(err, 'query');
    }
  }

  public async getConversationDetail(conversationId: string): Promise<ConversationDetailDTO | null> {
    try {
      const convRows = await this.handle.db
        .select()
        .from(conversations)
        .where(eq(conversations.id, conversationId))
        .limit(1);

      const conv = convRows[0];
      if (!conv) return null;

      const msgRows = await this.handle.db
        .select()
        .from(messages)
        .where(eq(messages.conversationId, conversationId))
        .orderBy(asc(messages.createdAt));

      const lastMsg = msgRows[msgRows.length - 1];
      const previewClean = lastMsg?.content.replace(/\s+/g, ' ').trim();

      return {
        conversation: {
          id: conv.id,
          title: conv.title,
          model: conv.model,
          createdAt: conv.createdAt,
          updatedAt: conv.updatedAt,
          messageCount: msgRows.length,
          ...(previewClean
            ? {
                lastMessagePreview:
                  previewClean.length > 96 ? `${previewClean.slice(0, 93)}...` : previewClean,
              }
            : {}),
        },
        messages: msgRows.map(toMessageDTO),
      };
    } catch (err) {
      throw mapDatabaseError(err, 'query');
    }
  }

  public async renameConversation(
    conversationId: string,
    title: string,
  ): Promise<ConversationDTO> {
    try {
      const existing = await this.getConversationDetail(conversationId);
      if (!existing) {
        throw new AppError({
          code: ErrorCodes.NOT_FOUND,
          category: 'validation',
          statusCode: 404,
          message: 'Conversation not found.',
        });
      }

      const now = new Date().toISOString();
      await this.handle.db
        .update(conversations)
        .set({ title: title.trim(), updatedAt: now })
        .where(eq(conversations.id, conversationId));

      return {
        ...existing.conversation,
        title: title.trim(),
        updatedAt: now,
      };
    } catch (err) {
      throw mapDatabaseError(err, 'query');
    }
  }

  public async touchConversation(
    conversationId: string,
    updates: { title?: string; model?: string },
  ): Promise<void> {
    try {
      const now = new Date().toISOString();
      await this.handle.db
        .update(conversations)
        .set({
          ...(updates.title ? { title: updates.title } : {}),
          ...(updates.model ? { model: updates.model } : {}),
          updatedAt: now,
        })
        .where(eq(conversations.id, conversationId));
    } catch (err) {
      throw mapDatabaseError(err, 'query');
    }
  }

  public async deleteConversation(conversationId: string): Promise<boolean> {
    try {
      const existing = await this.handle.db
        .select({ id: conversations.id })
        .from(conversations)
        .where(eq(conversations.id, conversationId))
        .limit(1);

      if (existing.length === 0) return false;

      await this.handle.db.delete(conversations).where(eq(conversations.id, conversationId));
      return true;
    } catch (err) {
      throw mapDatabaseError(err, 'query');
    }
  }

  public async addMessage(input: AddMessageInput): Promise<MessageDTO> {
    try {
      const now = new Date().toISOString();
      const id = input.id ?? randomUUID();
      const channel = input.channel ?? 'text';

      await this.handle.db.insert(messages).values({
        id,
        conversationId: input.conversationId,
        role: input.role,
        content: input.content,
        channel,
        status: input.status ?? 'completed',
        model: input.model ?? null,
        xaiResponseId: input.xaiResponseId ?? null,
        inputTokens: input.usage?.inputTokens ?? null,
        outputTokens: input.usage?.outputTokens ?? null,
        reasoningTokens: input.usage?.reasoningTokens ?? null,
        cachedTokens: input.usage?.cachedTokens ?? null,
        latencyMs: input.latencyMs ?? null,
        estimatedCostUsd: input.estimatedCostUsd ?? null,
        errorCode: input.errorCode ?? null,
        createdAt: now,
      });

      await this.handle.db
        .update(conversations)
        .set({ updatedAt: now })
        .where(eq(conversations.id, input.conversationId));

      return {
        id,
        conversationId: input.conversationId,
        role: input.role,
        content: input.content,
        channel,
        status: input.status ?? 'completed',
        model: input.model ?? null,
        xaiResponseId: input.xaiResponseId ?? null,
        inputTokens: input.usage?.inputTokens ?? null,
        outputTokens: input.usage?.outputTokens ?? null,
        reasoningTokens: input.usage?.reasoningTokens ?? null,
        cachedTokens: input.usage?.cachedTokens ?? null,
        latencyMs: input.latencyMs ?? null,
        estimatedCostUsd: input.estimatedCostUsd ?? null,
        errorCode: input.errorCode ?? null,
        createdAt: now,
      };
    } catch (err) {
      throw mapDatabaseError(err, 'query');
    }
  }

  public async updateMessage(
    messageId: string,
    updates: UpdateMessageInput,
  ): Promise<MessageDTO | null> {
    try {
      await this.handle.db
        .update(messages)
        .set({
          ...(updates.content !== undefined ? { content: updates.content } : {}),
          ...(updates.status !== undefined ? { status: updates.status } : {}),
          ...(updates.model !== undefined ? { model: updates.model } : {}),
          ...(updates.xaiResponseId !== undefined ? { xaiResponseId: updates.xaiResponseId } : {}),
          ...(updates.usage !== undefined
            ? {
                inputTokens: updates.usage.inputTokens,
                outputTokens: updates.usage.outputTokens,
                reasoningTokens: updates.usage.reasoningTokens,
                cachedTokens: updates.usage.cachedTokens,
              }
            : {}),
          ...(updates.latencyMs !== undefined ? { latencyMs: updates.latencyMs } : {}),
          ...(updates.estimatedCostUsd !== undefined
            ? { estimatedCostUsd: updates.estimatedCostUsd }
            : {}),
          ...(updates.errorCode !== undefined ? { errorCode: updates.errorCode } : {}),
        })
        .where(eq(messages.id, messageId));

      const rows = await this.handle.db
        .select()
        .from(messages)
        .where(eq(messages.id, messageId))
        .limit(1);

      return rows[0] ? toMessageDTO(rows[0]) : null;
    } catch (err) {
      throw mapDatabaseError(err, 'query');
    }
  }

  public async deleteMessage(messageId: string): Promise<void> {
    try {
      await this.handle.db.delete(messages).where(eq(messages.id, messageId));
    } catch (err) {
      throw mapDatabaseError(err, 'query');
    }
  }

  public async getContextTurns(
    conversationId: string,
    maxTurns = 30,
  ): Promise<Array<{ role: MessageRole; content: string }>> {
    try {
      const rows = await this.handle.db
        .select({
          role: messages.role,
          content: messages.content,
          status: messages.status,
        })
        .from(messages)
        .where(eq(messages.conversationId, conversationId))
        .orderBy(asc(messages.createdAt));

      const completed = rows
        .filter((row) => row.status === 'completed' && row.content.trim().length > 0)
        .map((row) => ({ role: row.role, content: row.content }));

      if (completed.length <= maxTurns) return completed;
      return completed.slice(completed.length - maxTurns);
    } catch (err) {
      throw mapDatabaseError(err, 'query');
    }
  }

  public async recordUsageLog(entry: {
    conversationId?: string;
    messageId?: string;
    kind?: UsageKind;
    model: string;
    status: 'success' | 'error' | 'aborted';
    usage?: TokenUsage;
    voiceSeconds?: number;
    estimatedCostUsd?: number;
    latencyMs: number;
    errorCode?: string;
  }): Promise<void> {
    try {
      await this.handle.db.insert(usageLogs).values({
        id: randomUUID(),
        conversationId: entry.conversationId ?? null,
        messageId: entry.messageId ?? null,
        kind: entry.kind ?? 'text',
        model: entry.model,
        status: entry.status,
        inputTokens: entry.usage?.inputTokens ?? 0,
        outputTokens: entry.usage?.outputTokens ?? 0,
        reasoningTokens: entry.usage?.reasoningTokens ?? 0,
        cachedTokens: entry.usage?.cachedTokens ?? 0,
        totalTokens: entry.usage?.totalTokens ?? 0,
        voiceSeconds: Math.max(0, Math.round(entry.voiceSeconds ?? 0)),
        estimatedCostUsd: entry.estimatedCostUsd ?? 0,
        latencyMs: entry.latencyMs,
        errorCode: entry.errorCode ?? null,
        createdAt: new Date().toISOString(),
      });
    } catch (err) {
      throw mapDatabaseError(err, 'query');
    }
  }

  public async getUsageSummary(budget: BudgetSettings): Promise<UsageSummaryDTO> {
    try {
      const now = new Date();
      const startOfDay = new Date(now.getFullYear(), now.getMonth(), now.getDate()).toISOString();
      const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1).toISOString();

      const monthRows = await this.handle.db
        .select()
        .from(usageLogs)
        .where(gte(usageLogs.createdAt, startOfMonth))
        .orderBy(desc(usageLogs.createdAt));

      const todayRows = monthRows.filter((row) => row.createdAt >= startOfDay);

      const aggregate = (rows: typeof monthRows) => {
        let errorCount = 0;
        let inputTokens = 0;
        let outputTokens = 0;
        let reasoningTokens = 0;
        let cachedTokens = 0;
        let totalTokens = 0;
        let voiceSeconds = 0;
        let estimatedCostUsd = 0;
        let latencySum = 0;

        const kindAccum: Record<
          UsageKind,
          { requests: number; errors: number; estimatedCostUsd: number; latencySum: number; totalTokens: number; voiceSeconds: number }
        > = {
          text: { requests: 0, errors: 0, estimatedCostUsd: 0, latencySum: 0, totalTokens: 0, voiceSeconds: 0 },
          voice_realtime: { requests: 0, errors: 0, estimatedCostUsd: 0, latencySum: 0, totalTokens: 0, voiceSeconds: 0 },
          tts: { requests: 0, errors: 0, estimatedCostUsd: 0, latencySum: 0, totalTokens: 0, voiceSeconds: 0 },
          stt: { requests: 0, errors: 0, estimatedCostUsd: 0, latencySum: 0, totalTokens: 0, voiceSeconds: 0 },
        };

        for (const r of rows) {
          if (r.status === 'error') errorCount += 1;
          inputTokens += r.inputTokens;
          outputTokens += r.outputTokens;
          reasoningTokens += r.reasoningTokens;
          cachedTokens += r.cachedTokens;
          totalTokens += r.totalTokens;
          voiceSeconds += r.voiceSeconds;
          estimatedCostUsd += r.estimatedCostUsd;
          latencySum += r.latencyMs;

          const bucket = kindAccum[r.kind];
          if (bucket) {
            bucket.requests += 1;
            if (r.status === 'error') bucket.errors += 1;
            bucket.estimatedCostUsd += r.estimatedCostUsd;
            bucket.latencySum += r.latencyMs;
            bucket.totalTokens += r.totalTokens;
            bucket.voiceSeconds += r.voiceSeconds;
          }
        }

        return {
          requestCount: rows.length,
          errorCount,
          inputTokens,
          outputTokens,
          reasoningTokens,
          cachedTokens,
          totalTokens,
          voiceSeconds,
          estimatedCostUsd: Number(estimatedCostUsd.toFixed(6)),
          avgLatencyMs: rows.length > 0 ? Math.round(latencySum / rows.length) : 0,
          byKind: {
            text: {
              requests: kindAccum.text.requests,
              errors: kindAccum.text.errors,
              estimatedCostUsd: Number(kindAccum.text.estimatedCostUsd.toFixed(6)),
              avgLatencyMs:
                kindAccum.text.requests > 0
                  ? Math.round(kindAccum.text.latencySum / kindAccum.text.requests)
                  : 0,
              totalTokens: kindAccum.text.totalTokens,
              voiceSeconds: kindAccum.text.voiceSeconds,
            },
            voice_realtime: {
              requests: kindAccum.voice_realtime.requests,
              errors: kindAccum.voice_realtime.errors,
              estimatedCostUsd: Number(kindAccum.voice_realtime.estimatedCostUsd.toFixed(6)),
              avgLatencyMs:
                kindAccum.voice_realtime.requests > 0
                  ? Math.round(
                      kindAccum.voice_realtime.latencySum / kindAccum.voice_realtime.requests,
                    )
                  : 0,
              totalTokens: kindAccum.voice_realtime.totalTokens,
              voiceSeconds: kindAccum.voice_realtime.voiceSeconds,
            },
            tts: {
              requests: kindAccum.tts.requests,
              errors: kindAccum.tts.errors,
              estimatedCostUsd: Number(kindAccum.tts.estimatedCostUsd.toFixed(6)),
              avgLatencyMs:
                kindAccum.tts.requests > 0
                  ? Math.round(kindAccum.tts.latencySum / kindAccum.tts.requests)
                  : 0,
              totalTokens: kindAccum.tts.totalTokens,
              voiceSeconds: kindAccum.tts.voiceSeconds,
            },
            stt: {
              requests: kindAccum.stt.requests,
              errors: kindAccum.stt.errors,
              estimatedCostUsd: Number(kindAccum.stt.estimatedCostUsd.toFixed(6)),
              avgLatencyMs:
                kindAccum.stt.requests > 0
                  ? Math.round(kindAccum.stt.latencySum / kindAccum.stt.requests)
                  : 0,
              totalTokens: kindAccum.stt.totalTokens,
              voiceSeconds: kindAccum.stt.voiceSeconds,
            },
          },
        };
      };

      const today = aggregate(todayRows);
      const month = aggregate(monthRows);

      const recentRows = await this.handle.db
        .select()
        .from(usageLogs)
        .orderBy(desc(usageLogs.createdAt))
        .limit(30);

      return {
        today,
        month,
        budgetStatus: evaluateBudgetStatus(month.estimatedCostUsd, today.estimatedCostUsd, budget),
        recentEvents: recentRows.map((row) => ({
          id: row.id,
          kind: row.kind,
          model: row.model,
          status: row.status,
          totalTokens: row.totalTokens,
          voiceSeconds: row.voiceSeconds,
          estimatedCostUsd: row.estimatedCostUsd,
          latencyMs: row.latencyMs,
          errorCode: row.errorCode,
          createdAt: row.createdAt,
        })),
      };
    } catch (err) {
      throw mapDatabaseError(err, 'query');
    }
  }

  public async getStoredSettings<T>(key: string): Promise<T | null> {
    try {
      const rows = await this.handle.db
        .select()
        .from(appSettings)
        .where(eq(appSettings.key, key))
        .limit(1);

      const first = rows[0];
      if (!first) return null;
      return JSON.parse(first.valueJson) as T;
    } catch (err) {
      throw mapDatabaseError(err, 'query');
    }
  }

  public async saveStoredSettings<T>(key: string, value: T): Promise<void> {
    try {
      const now = new Date().toISOString();
      const serialized = JSON.stringify(value);
      await this.handle.db
        .insert(appSettings)
        .values({
          key,
          valueJson: serialized,
          updatedAt: now,
        })
        .onConflictDoUpdate({
          target: appSettings.key,
          set: {
            valueJson: sql`excluded.value_json`,
            updatedAt: sql`excluded.updated_at`,
          },
        });
    } catch (err) {
      throw mapDatabaseError(err, 'query');
    }
  }

  public async clearAllConversations(): Promise<number> {
    try {
      const existing = await this.handle.db
        .select({ id: conversations.id })
        .from(conversations);
      await this.handle.db.delete(conversations);
      return existing.length;
    } catch (err) {
      throw mapDatabaseError(err, 'query');
    }
  }

  public async listAllowlist(kind?: AllowlistKind): Promise<AllowlistEntryDTO[]> {
    try {
      const rows = kind
        ? await this.handle.db
            .select()
            .from(desktopAllowlist)
            .where(eq(desktopAllowlist.kind, kind))
            .orderBy(desc(desktopAllowlist.createdAt))
        : await this.handle.db
            .select()
            .from(desktopAllowlist)
            .orderBy(desc(desktopAllowlist.createdAt));

      return rows.map((row) => ({
        id: row.id,
        kind: row.kind,
        label: row.label,
        target: row.target,
        createdAt: row.createdAt,
      }));
    } catch (err) {
      throw mapDatabaseError(err, 'query');
    }
  }

  public async addAllowlistEntry(entry: {
    kind: AllowlistKind;
    label: string;
    target: string;
  }): Promise<AllowlistEntryDTO> {
    try {
      const id = randomUUID();
      const createdAt = new Date().toISOString();
      await this.handle.db.insert(desktopAllowlist).values({
        id,
        kind: entry.kind,
        label: entry.label,
        target: entry.target,
        createdAt,
      });
      return {
        id,
        kind: entry.kind,
        label: entry.label,
        target: entry.target,
        createdAt,
      };
    } catch (err) {
      throw mapDatabaseError(err, 'query');
    }
  }

  public async deleteAllowlistEntry(id: string): Promise<boolean> {
    try {
      const existing = await this.handle.db
        .select({ id: desktopAllowlist.id })
        .from(desktopAllowlist)
        .where(eq(desktopAllowlist.id, id))
        .limit(1);
      if (existing.length === 0) return false;
      await this.handle.db.delete(desktopAllowlist).where(eq(desktopAllowlist.id, id));
      return true;
    } catch (err) {
      throw mapDatabaseError(err, 'query');
    }
  }

  public async recordAuditLog(entry: {
    capability: string;
    action: string;
    target: string;
    outcome: AuditOutcome;
    source: AuditSource;
    detail?: string | null;
  }): Promise<AuditLogEntryDTO> {
    try {
      const id = randomUUID();
      const timestamp = new Date().toISOString();
      const safeTarget = sanitizeDiagnosticText(entry.target).slice(0, 240);
      const safeDetail = entry.detail ? sanitizeDiagnosticText(entry.detail).slice(0, 400) : null;

      await this.handle.db.insert(privilegedAuditLogs).values({
        id,
        timestamp,
        capability: entry.capability,
        action: entry.action,
        target: safeTarget,
        outcome: entry.outcome,
        source: entry.source,
        detail: safeDetail,
      });

      return {
        id,
        timestamp,
        capability: entry.capability,
        action: entry.action,
        target: safeTarget,
        outcome: entry.outcome,
        source: entry.source,
        detail: safeDetail,
      };
    } catch (err) {
      throw mapDatabaseError(err, 'query');
    }
  }

  public async listAuditLogs(options: {
    capability?: string;
    outcome?: AuditOutcome;
    limit?: number;
  } = {}): Promise<AuditLogEntryDTO[]> {
    try {
      const limit = Math.max(1, Math.min(options.limit ?? 100, 500));
      const rows = await this.handle.db
        .select()
        .from(privilegedAuditLogs)
        .orderBy(desc(privilegedAuditLogs.timestamp))
        .limit(limit);

      return rows
        .filter((row) => {
          if (options.capability && row.capability !== options.capability) return false;
          if (options.outcome && row.outcome !== options.outcome) return false;
          return true;
        })
        .map((row) => ({
          id: row.id,
          timestamp: row.timestamp,
          capability: row.capability,
          action: row.action,
          target: row.target,
          outcome: row.outcome,
          source: row.source,
          detail: row.detail,
        }));
    } catch (err) {
      throw mapDatabaseError(err, 'query');
    }
  }

  public async exportPersonalData(): Promise<{
    conversations: ConversationDetailDTO[];
    allowlist: AllowlistEntryDTO[];
    auditLogs: AuditLogEntryDTO[];
  }> {
    try {
      const convList = await this.listConversations();
      const details: ConversationDetailDTO[] = [];
      for (const conv of convList) {
        const detail = await this.getConversationDetail(conv.id);
        if (detail) details.push(detail);
      }
      const allowlist = await this.listAllowlist();
      const auditLogs = await this.listAuditLogs({ limit: 500 });
      return {
        conversations: details,
        allowlist,
        auditLogs,
      };
    } catch (err) {
      throw mapDatabaseError(err, 'query');
    }
  }
}

function toMessageDTO(row: typeof messages.$inferSelect): MessageDTO {
  return {
    id: row.id,
    conversationId: row.conversationId,
    role: row.role,
    content: row.content,
    channel: row.channel,
    status: row.status,
    model: row.model,
    xaiResponseId: row.xaiResponseId,
    inputTokens: row.inputTokens,
    outputTokens: row.outputTokens,
    reasoningTokens: row.reasoningTokens,
    cachedTokens: row.cachedTokens,
    latencyMs: row.latencyMs,
    estimatedCostUsd: row.estimatedCostUsd,
    errorCode: row.errorCode,
    createdAt: row.createdAt,
  };
}
