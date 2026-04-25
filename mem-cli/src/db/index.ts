/**
 * DB factory for LMF4.1 dual-backend support.
 *
 * Backend selection (in priority order):
 *   1. Explicit argument to getDb() / initDb()
 *   2. LMF_DB_BACKEND environment variable  ('sqlite' | 'postgres')
 *   3. Default: 'sqlite'  (backward compatible)
 *
 * Usage:
 *   import { getDb } from './db/index.js';
 *   const db = await getDb();
 *   const rows = await db.query('SELECT * FROM sessions WHERE project = ?', ['myproject']);
 *
 * CLI flag pattern (in your CLI entrypoint):
 *   if (args['--db']) process.env.LMF_DB_BACKEND = args['--db'];
 */

import { existsSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import type { DbAdapter } from './adapter.js';
import { SQLiteAdapter } from './adapters/sqlite.js';
import { PostgresAdapter } from './adapters/postgres.js';
import { SQLITE_SCHEMA_ORDERED } from './schema/sqlite.js';
import { PG_SCHEMA_ORDERED } from './schema/postgres.js';
import { SCHEMA_VERSION } from './schema/common.js';

export type Backend = 'sqlite' | 'postgres';

let instance: DbAdapter | null = null;

/** Resolve which backend to use. */
function resolveBackend(explicit?: Backend): Backend {
  if (explicit) return explicit;
  const env = process.env.LMF_DB_BACKEND?.toLowerCase();
  if (env === 'postgres' || env === 'postgresql') return 'postgres';
  return 'sqlite'; // default — backward compatible
}

/**
 * Get the singleton adapter instance.
 * Throws if initDb() has not been called yet.
 */
export async function getDb(backend?: Backend): Promise<DbAdapter> {
  if (instance) return instance;

  const b = resolveBackend(backend);

  switch (b) {
    case 'sqlite':
      instance = SQLiteAdapter.open();
      break;
    case 'postgres':
      instance = PostgresAdapter.connect();
      break;
  }

  await checkSchemaVersion(instance);
  return instance;
}

/**
 * Initialise the database: create schema, set version.
 * Safe to call on an existing database (IF NOT EXISTS on all DDL).
 */
export async function initDb(backend?: Backend): Promise<{ backend: Backend; created: boolean }> {
  const b = resolveBackend(backend);
  let created = false;

  switch (b) {
    case 'sqlite': {
      const sqlitePath = process.env.MEM_DB_PATH ?? join(homedir(), '.claude', 'memory.db');
      created = !existsSync(sqlitePath);
      instance = SQLiteAdapter.init(undefined, SQLITE_SCHEMA_ORDERED);
      break;
    }
    case 'postgres': {
      // For PG we can't easily detect "new vs existing" — treat as upgrade
      created = false;
      instance = await PostgresAdapter.init(PG_SCHEMA_ORDERED);
      break;
    }
  }

  await instance.run(
    `INSERT INTO schema_meta (key, value) VALUES (?, ?)
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
    ['version', String(SCHEMA_VERSION)]
  );

  return { backend: b, created };
}

/** Validate stored schema version matches code expectation. */
async function checkSchemaVersion(db: DbAdapter): Promise<void> {
  const row = await db.queryOne<{ value: string }>(
    `SELECT value FROM schema_meta WHERE key = ?`,
    ['version']
  );
  if (!row) {
    throw new Error(`Database not initialised. Run 'mem init' first.`);
  }
  const stored = parseInt(row.value, 10);
  if (stored < SCHEMA_VERSION) {
    if (stored === 2 && db.backend === 'sqlite') {
      // v2 → v3: no DDL changes for SQLite, just bump the version
      await db.run(
        `INSERT INTO schema_meta (key, value) VALUES (?, ?)
         ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
        ['version', String(SCHEMA_VERSION)]
      );
      return;
    }
    throw new Error(
      `Schema version mismatch: DB has v${stored}, code expects v${SCHEMA_VERSION}. ` +
      `Run 'mem migrate' to upgrade.`
    );
  }
}

/** Close the active adapter and clear the singleton. */
export async function closeDb(): Promise<void> {
  if (instance) {
    await instance.close();
    instance = null;
  }
}

/** Expose the active backend name without opening a connection. */
export function activeBackend(explicit?: Backend): Backend {
  return resolveBackend(explicit);
}
