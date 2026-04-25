/**
 * PostgresAdapter — wraps postgres.js to fulfil the DbAdapter contract.
 *
 * Uses `sql.unsafe()` for DDL (multi-statement, no params) and tagged
 * template literals with auto-parameterisation for all DML.
 *
 * Placeholder convention: callers always use `?` (SQLite-style).
 * This adapter converts `?` → `$1, $2, …` before sending to PostgreSQL.
 */

import postgres, { type Sql } from 'postgres';
import type { DbAdapter, Row } from '../adapter.js';

const DEFAULT_URL = 'postgresql://lmf:changeme@localhost:5432/lmf';

export class PostgresAdapter implements DbAdapter {
  readonly backend = 'postgres' as const;

  private sql: Sql;

  constructor(connectionUrl: string = process.env.LMF_DATABASE_URL ?? DEFAULT_URL) {
    this.sql = postgres(connectionUrl, {
      max: 10,
      idle_timeout: 30,
      connect_timeout: 10,
      onnotice: () => {},
    });
  }

  /** Factory: standard connection — no schema creation. */
  static connect(url?: string): PostgresAdapter {
    return new PostgresAdapter(url);
  }

  /** Factory: creates schema. Caller passes ordered SQL strings. */
  static async init(schemaSql: string[], url?: string): Promise<PostgresAdapter> {
    const adapter = new PostgresAdapter(url);
    for (const sql of schemaSql) {
      await adapter.exec(sql);
    }
    return adapter;
  }

  /**
   * Convert `?` positional placeholders (SQLite convention) to
   * `$1, $2, …` (PostgreSQL convention).
   */
  private convertPlaceholders(sql: string): string {
    let i = 0;
    return sql.replace(/\?/g, () => `$${++i}`);
  }

  /**
   * Execute DDL (CREATE TABLE, CREATE INDEX, ALTER TABLE …).
   * Uses sql.unsafe() which allows multi-statement strings.
   */
  async exec(sql: string): Promise<void> {
    await this.sql.unsafe(sql);
  }

  async run(sql: string, params: unknown[] = []): Promise<void> {
    const converted = this.convertPlaceholders(sql);
    await this.sql.unsafe(converted, params as postgres.ParameterOrJSON<never>[]);
  }

  async query<T extends Row = Row>(sql: string, params: unknown[] = []): Promise<T[]> {
    const converted = this.convertPlaceholders(sql);
    const rows = await this.sql.unsafe(converted, params as postgres.ParameterOrJSON<never>[]);
    return (rows as unknown as Record<string, unknown>[]).map(r => this.normalizeRow(r)) as T[];
  }

  async queryOne<T extends Row = Row>(sql: string, params: unknown[] = []): Promise<T | null> {
    const rows = await this.query<T>(sql, params);
    return rows[0] ?? null;
  }

  /** Normalize PG-specific types to match SQLite conventions used throughout the codebase. */
  private normalizeRow(row: Record<string, unknown>): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(row)) {
      if (v instanceof Date) {
        out[k] = v.toISOString(); // TIMESTAMPTZ → ISO string (SQLite stores as TEXT)
      } else if (typeof v === 'bigint') {
        out[k] = Number(v);       // BIGSERIAL/COUNT → number
      } else {
        out[k] = v;
      }
    }
    return out;
  }

  async close(): Promise<void> {
    await this.sql.end();
  }
}
