/**
 * hook-db.ts — lightweight DB bootstrap for LMF hooks.
 *
 * Hooks (SessionExtract, AssociativeRecall, mem-mcp-server) are spawned
 * as separate processes by Claude Code. They can't share the mem-cli
 * singleton. This file gives them a clean way to open the right adapter.
 *
 * Install path after `mem init`:  ~/.claude/hooks/hook-db.ts
 * Import from hooks:              import { openHookDb } from './hook-db.js';
 *
 * The backend is determined by LMF_DB_BACKEND env var, which Claude Code
 * injects from settings.json `env` block — written there by `mem init`.
 *
 * Usage:
 *   const db = await openHookDb();
 *   const rows = await db.query('SELECT ...', [params]);
 *   await db.close();
 */

import { Database } from 'bun:sqlite';
import { join } from 'path';
import { homedir } from 'os';
import { existsSync } from 'fs';
import postgres from 'postgres';

// ---- Minimal inline adapter (no dependency on mem-cli dist) ----
// Duplicates the interface so hooks work even if mem-cli isn't built yet.

export type HookRow = Record<string, unknown>;

export interface HookDb {
  backend: 'sqlite' | 'postgres';
  query<T extends HookRow = HookRow>(sql: string, params?: unknown[]): Promise<T[]>;
  queryOne<T extends HookRow = HookRow>(sql: string, params?: unknown[]): Promise<T | null>;
  run(sql: string, params?: unknown[]): Promise<void>;
  close(): Promise<void>;
}

export async function openHookDb(): Promise<HookDb> {
  const backend = resolveBackend();
  return backend === 'postgres' ? openPostgres() : openSqlite();
}

function resolveBackend(): 'sqlite' | 'postgres' {
  const env = process.env.LMF_DB_BACKEND?.toLowerCase();
  return env === 'postgres' || env === 'postgresql' ? 'postgres' : 'sqlite';
}

// ---- SQLite ----

function openSqlite(): HookDb {
  const path = process.env.MEM_DB_PATH
    ?? join(homedir(), '.claude', 'memory.db');

  if (!existsSync(path)) {
    throw new Error(`LMF: SQLite DB not found at ${path}. Run 'mem init' first.`);
  }

  const db = new Database(path);
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA foreign_keys = ON');

  return {
    backend: 'sqlite',
    async query<T extends HookRow>(sql: string, params: unknown[] = []): Promise<T[]> {
      return db.prepare(sql).all(...params) as T[];
    },
    async queryOne<T extends HookRow>(sql: string, params: unknown[] = []): Promise<T | null> {
      return (db.prepare(sql).get(...params) as T | undefined) ?? null;
    },
    async run(sql: string, params: unknown[] = []): Promise<void> {
      db.prepare(sql).run(...params);
    },
    async close(): Promise<void> {
      db.close();
    },
  };
}

// ---- PostgreSQL ----

function openPostgres(): HookDb {
  const url = process.env.LMF_DATABASE_URL
    ?? 'postgresql://lmf:changeme@localhost:5432/lmf';

  const sql = postgres(url, {
    max: 3,              // hooks are short-lived, small pool
    idle_timeout: 10,
    connect_timeout: 5,
    onnotice: () => {},
  });

  function convertPlaceholders(s: string): string {
    let i = 0;
    return s.replace(/\?/g, () => `$${++i}`);
  }

  function normalizeRow(row: Record<string, unknown>): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(row)) {
      if (v instanceof Date) out[k] = v.toISOString();
      else if (typeof v === 'bigint') out[k] = Number(v);
      else out[k] = v;
    }
    return out;
  }

  return {
    backend: 'postgres',
    async query<T extends HookRow>(s: string, params: unknown[] = []): Promise<T[]> {
      const rows = await sql.unsafe(convertPlaceholders(s), params as never[]);
      return (rows as unknown as Record<string, unknown>[]).map(normalizeRow) as T[];
    },
    async queryOne<T extends HookRow>(s: string, params: unknown[] = []): Promise<T | null> {
      const rows = await sql.unsafe(convertPlaceholders(s), params as never[]);
      return rows[0] ? normalizeRow(rows[0] as Record<string, unknown>) as T : null;
    },
    async run(s: string, params: unknown[] = []): Promise<void> {
      await sql.unsafe(convertPlaceholders(s), params as never[]);
    },
    async close(): Promise<void> {
      await sql.end();
    },
  };
}
