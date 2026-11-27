import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import { drizzle, type SqliteRemoteDatabase } from 'drizzle-orm/sqlite-proxy';
import { AppError, ErrorCodes } from '@mj/shared';
import * as schema from './schema.js';
import { SQL_MIGRATIONS } from './migrations.js';

export type MjDrizzleDb = SqliteRemoteDatabase<typeof schema>;

export interface MjDatabaseHandle {
  sqlite: DatabaseSync;
  db: MjDrizzleDb;
  filePath: string;
  ping: () => boolean;
  close: () => void;
}

export function resolveSqlitePath(databaseUrl: string): string {
  const trimmed = databaseUrl.trim();
  if (!trimmed || trimmed === ':memory:') {
    return ':memory:';
  }
  const withoutScheme = trimmed.startsWith('file:') ? trimmed.slice(5) : trimmed;
  if (withoutScheme === ':memory:') {
    return ':memory:';
  }
  return resolve(withoutScheme);
}

function normalizeSqlParams(params: unknown[]): SQLInputValue[] {
  return params.map((value) => {
    if (value === undefined || value === null) return null;
    if (typeof value === 'boolean') return value ? 1 : 0;
    if (value instanceof Date) return value.toISOString();
    if (
      typeof value === 'string' ||
      typeof value === 'number' ||
      typeof value === 'bigint' ||
      value instanceof Uint8Array
    ) {
      return value;
    }
    return JSON.stringify(value);
  });
}

export function mapDatabaseError(err: unknown, context: 'migration' | 'query' | 'connect'): AppError {
  if (err instanceof AppError) return err;

  const message = err instanceof Error ? err.message.toLowerCase() : String(err).toLowerCase();

  if (message.includes('busy') || message.includes('locked') || message.includes('timeout')) {
    return new AppError({
      code: ErrorCodes.DATABASE_TIMEOUT,
      category: 'database',
      statusCode: 504,
      cause: err,
    });
  }

  if (
    context === 'connect' ||
    message.includes('unable to open') ||
    message.includes('cantopen') ||
    message.includes('readonly') ||
    message.includes('no such file')
  ) {
    return new AppError({
      code: ErrorCodes.DATABASE_UNAVAILABLE,
      category: 'database',
      statusCode: 503,
      cause: err,
    });
  }

  if (context === 'migration') {
    return new AppError({
      code: ErrorCodes.DATABASE_MIGRATION_ERROR,
      category: 'database',
      statusCode: 500,
      cause: err,
    });
  }

  return new AppError({
    code: ErrorCodes.DATABASE_QUERY_ERROR,
    category: 'database',
    statusCode: 500,
    cause: err,
  });
}

export function runMigrations(sqlite: DatabaseSync): void {
  try {
    sqlite.exec(`
      CREATE TABLE IF NOT EXISTS __mj_migrations (
        id TEXT PRIMARY KEY NOT NULL,
        description TEXT NOT NULL,
        applied_at TEXT NOT NULL
      );
    `);

    const appliedRows = sqlite
      .prepare('SELECT id FROM __mj_migrations')
      .all() as Array<{ id: string }>;
    const appliedIds = new Set(appliedRows.map((row) => row.id));

    for (const migration of SQL_MIGRATIONS) {
      if (appliedIds.has(migration.id)) continue;

      sqlite.exec('BEGIN IMMEDIATE;');
      try {
        sqlite.exec(migration.sql);
        sqlite
          .prepare(
            'INSERT INTO __mj_migrations (id, description, applied_at) VALUES (?, ?, ?)',
          )
          .run(migration.id, migration.description, new Date().toISOString());
        sqlite.exec('COMMIT;');
      } catch (innerErr) {
        sqlite.exec('ROLLBACK;');
        throw innerErr;
      }
    }
  } catch (err) {
    throw mapDatabaseError(err, 'migration');
  }
}

export function createDatabase(databaseUrl: string): MjDatabaseHandle {
  const filePath = resolveSqlitePath(databaseUrl);

  let sqlite: DatabaseSync;
  try {
    if (filePath !== ':memory:') {
      mkdirSync(dirname(filePath), { recursive: true });
    }
    sqlite = new DatabaseSync(filePath);
    sqlite.exec('PRAGMA foreign_keys = ON;');
    sqlite.exec('PRAGMA busy_timeout = 5000;');
    if (filePath !== ':memory:') {
      sqlite.exec('PRAGMA journal_mode = WAL;');
    }
  } catch (err) {
    throw mapDatabaseError(err, 'connect');
  }

  runMigrations(sqlite);

  const db = drizzle(
    async (sql, params, method) => {
      try {
        const stmt = sqlite.prepare(sql);
        const bound = normalizeSqlParams(params);

        if (method === 'run') {
          stmt.run(...bound);
          return { rows: [] };
        }

        stmt.setReturnArrays(true);

        if (method === 'get') {
          const row = stmt.get(...bound);
          return { rows: row as unknown as unknown[] };
        }

        const rows = stmt.all(...bound);
        return { rows: rows as unknown as unknown[][] };
      } catch (err) {
        throw mapDatabaseError(err, 'query');
      }
    },
    { schema },
  );

  return {
    sqlite,
    db,
    filePath,
    ping: () => {
      try {
        const row = sqlite.prepare('SELECT 1 AS ok').get() as { ok?: number } | undefined;
        return row?.ok === 1;
      } catch {
        return false;
      }
    },
    close: () => {
      try {
        sqlite.close();
      } catch {
        // ignore close errors on shutdown
      }
    },
  };
}
