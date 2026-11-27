export interface SqlMigration {
  id: string;
  description: string;
  sql: string;
}

export const SQL_MIGRATIONS: SqlMigration[] = [
  {
    id: '0001_stage1_foundation',
    description: 'Create conversations, messages, usage_logs, and app_settings tables',
    sql: `
      CREATE TABLE IF NOT EXISTS conversations (
        id TEXT PRIMARY KEY NOT NULL,
        title TEXT NOT NULL,
        model TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_conversations_updated_at
        ON conversations (updated_at DESC);

      CREATE TABLE IF NOT EXISTS messages (
        id TEXT PRIMARY KEY NOT NULL,
        conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
        role TEXT NOT NULL CHECK (role IN ('user', 'assistant')),
        content TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'completed' CHECK (status IN ('streaming', 'completed', 'aborted', 'error')),
        model TEXT,
        xai_response_id TEXT,
        input_tokens INTEGER,
        output_tokens INTEGER,
        reasoning_tokens INTEGER,
        cached_tokens INTEGER,
        latency_ms INTEGER,
        estimated_cost_usd REAL,
        error_code TEXT,
        created_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_messages_conversation_created
        ON messages (conversation_id, created_at ASC);

      CREATE TABLE IF NOT EXISTS usage_logs (
        id TEXT PRIMARY KEY NOT NULL,
        conversation_id TEXT,
        message_id TEXT,
        model TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('success', 'error', 'aborted')),
        input_tokens INTEGER NOT NULL DEFAULT 0,
        output_tokens INTEGER NOT NULL DEFAULT 0,
        reasoning_tokens INTEGER NOT NULL DEFAULT 0,
        cached_tokens INTEGER NOT NULL DEFAULT 0,
        total_tokens INTEGER NOT NULL DEFAULT 0,
        estimated_cost_usd REAL NOT NULL DEFAULT 0,
        latency_ms INTEGER NOT NULL DEFAULT 0,
        error_code TEXT,
        created_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_usage_logs_created_at
        ON usage_logs (created_at DESC);

      CREATE TABLE IF NOT EXISTS app_settings (
        key TEXT PRIMARY KEY NOT NULL,
        value_json TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
    `,
  },
  {
    id: '0002_stage2_voice_tracking',
    description: 'Add message channel (text/voice) and voice usage tracking columns',
    sql: `
      ALTER TABLE messages ADD COLUMN channel TEXT NOT NULL DEFAULT 'text';
      ALTER TABLE usage_logs ADD COLUMN kind TEXT NOT NULL DEFAULT 'text';
      ALTER TABLE usage_logs ADD COLUMN voice_seconds INTEGER NOT NULL DEFAULT 0;
    `,
  },
];
