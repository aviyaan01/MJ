import { integer, real, sqliteTable, text } from 'drizzle-orm/sqlite-core';

export const conversations = sqliteTable('conversations', {
  id: text('id').primaryKey(),
  title: text('title').notNull(),
  model: text('model').notNull(),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
});

export const messages = sqliteTable('messages', {
  id: text('id').primaryKey(),
  conversationId: text('conversation_id')
    .notNull()
    .references(() => conversations.id, { onDelete: 'cascade' }),
  role: text('role', { enum: ['user', 'assistant'] }).notNull(),
  content: text('content').notNull(),
  channel: text('channel', { enum: ['text', 'voice'] }).notNull().default('text'),
  status: text('status', { enum: ['streaming', 'completed', 'aborted', 'error'] })
    .notNull()
    .default('completed'),
  model: text('model'),
  xaiResponseId: text('xai_response_id'),
  inputTokens: integer('input_tokens'),
  outputTokens: integer('output_tokens'),
  reasoningTokens: integer('reasoning_tokens'),
  cachedTokens: integer('cached_tokens'),
  latencyMs: integer('latency_ms'),
  estimatedCostUsd: real('estimated_cost_usd'),
  errorCode: text('error_code'),
  createdAt: text('created_at').notNull(),
});

export const usageLogs = sqliteTable('usage_logs', {
  id: text('id').primaryKey(),
  conversationId: text('conversation_id'),
  messageId: text('message_id'),
  kind: text('kind', { enum: ['text', 'voice_realtime', 'tts', 'stt'] })
    .notNull()
    .default('text'),
  model: text('model').notNull(),
  status: text('status', { enum: ['success', 'error', 'aborted'] }).notNull(),
  inputTokens: integer('input_tokens').notNull().default(0),
  outputTokens: integer('output_tokens').notNull().default(0),
  reasoningTokens: integer('reasoning_tokens').notNull().default(0),
  cachedTokens: integer('cached_tokens').notNull().default(0),
  totalTokens: integer('total_tokens').notNull().default(0),
  voiceSeconds: integer('voice_seconds').notNull().default(0),
  estimatedCostUsd: real('estimated_cost_usd').notNull().default(0),
  latencyMs: integer('latency_ms').notNull().default(0),
  errorCode: text('error_code'),
  createdAt: text('created_at').notNull(),
});

export const appSettings = sqliteTable('app_settings', {
  key: text('key').primaryKey(),
  valueJson: text('value_json').notNull(),
  updatedAt: text('updated_at').notNull(),
});

export const desktopAllowlist = sqliteTable('desktop_allowlist', {
  id: text('id').primaryKey(),
  kind: text('kind', { enum: ['app', 'folder', 'web_domain'] }).notNull(),
  label: text('label').notNull(),
  target: text('target').notNull(),
  createdAt: text('created_at').notNull(),
});

export const privilegedAuditLogs = sqliteTable('privileged_audit_logs', {
  id: text('id').primaryKey(),
  timestamp: text('timestamp').notNull(),
  capability: text('capability').notNull(),
  action: text('action').notNull(),
  target: text('target').notNull(),
  outcome: text('outcome', { enum: ['allowed', 'denied', 'cancelled', 'error'] }).notNull(),
  source: text('source', { enum: ['web', 'server', 'desktop-tauri'] }).notNull(),
  detail: text('detail'),
});

export type ConversationRow = typeof conversations.$inferSelect;
export type MessageRow = typeof messages.$inferSelect;
export type UsageLogRow = typeof usageLogs.$inferSelect;
export type AppSettingRow = typeof appSettings.$inferSelect;
export type DesktopAllowlistRow = typeof desktopAllowlist.$inferSelect;
export type PrivilegedAuditLogRow = typeof privilegedAuditLogs.$inferSelect;
