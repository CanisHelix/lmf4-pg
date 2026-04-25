/**
 * SQLiteAdapter — wraps bun:sqlite to fulfil the DbAdapter contract.
 *
 * bun:sqlite is synchronous; every method here wraps calls in
 * Promise.resolve() so callers can be uniformly async.
 */

import { Database } from 'bun:sqlite';
import { existsSync, mkdirSync, chmodSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import type { DbAdapter, Row } from '../adapter.js';

const DEFAULT_PATH = join(homedir(), '.claude', 'memory.db');

export class SQLiteAdapter implements DbAdapter {
  readonly backend = 'sqlite' as const;

  private db: Database;

  constructor(path: string = process.env.MEM_DB_PATH ?? DEFAULT_PATH) {
    this.db = new Database(path);
    this.db.exec('PRAGMA journal_mode = WAL');
    this.db.exec('PRAGMA foreign_keys = ON');
  }

  /** Factory: opens an existing database (requires prior initDb). */
  static open(path?: string): SQLiteAdapter {
    const p = path ?? process.env.MEM_DB_PATH ?? DEFAULT_PATH;
    if (!existsSync(p)) {
      throw new Error(`SQLite DB not found at ${p}. Run 'mem init' first.`);
    }
    return new SQLiteAdapter(p);
  }

  /** Factory: creates or opens the database and runs schema creation. */
  static init(
    path: string = process.env.MEM_DB_PATH ?? DEFAULT_PATH,
    schemaSql: string[]
  ): SQLiteAdapter {
    const dir = join(path, '..');
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

    const adapter = new SQLiteAdapter(path);
    for (const sql of schemaSql) {
      adapter.db.exec(sql);
    }

    // Restrict file permissions — owner read/write only
    try {
      chmodSync(path, 0o600);
      for (const ext of ['-wal', '-shm']) {
        const f = path + ext;
        if (existsSync(f)) chmodSync(f, 0o600);
      }
    } catch {
      // chmod may fail on some filesystems — non-fatal
    }

    return adapter;
  }

  async exec(sql: string): Promise<void> {
    this.db.exec(sql);
  }

  async run(sql: string, params: unknown[] = []): Promise<void> {
    this.db.prepare(sql).run(...params);
  }

  async query<T extends Row = Row>(sql: string, params: unknown[] = []): Promise<T[]> {
    return this.db.prepare(sql).all(...params) as T[];
  }

  async queryOne<T extends Row = Row>(sql: string, params: unknown[] = []): Promise<T | null> {
    return (this.db.prepare(sql).get(...params) as T | undefined) ?? null;
  }

  async close(): Promise<void> {
    this.db.close();
  }
}
