/**
 * DbAdapter — backend-agnostic database interface for LMF4.1
 *
 * Both the SQLite and PostgreSQL adapters implement this contract.
 * All methods are async so callers are uniform regardless of backend.
 * SQLite wraps its synchronous calls in Promise.resolve().
 */

export type Row = Record<string, unknown>;

export interface DbAdapter {
  /** Execute one or more DDL statements (CREATE TABLE, CREATE INDEX, etc.) */
  exec(sql: string): Promise<void>;

  /** Execute a write statement (INSERT / UPDATE / DELETE). */
  run(sql: string, params?: unknown[]): Promise<void>;

  /** Execute a read statement, returning all matching rows. */
  query<T extends Row = Row>(sql: string, params?: unknown[]): Promise<T[]>;

  /** Execute a read statement, returning the first row or null. */
  queryOne<T extends Row = Row>(sql: string, params?: unknown[]): Promise<T | null>;

  /** Release connections / close the database. */
  close(): Promise<void>;

  /** Human-readable backend name for logging. */
  readonly backend: 'sqlite' | 'postgres';
}
