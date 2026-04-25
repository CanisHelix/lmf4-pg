// mem migrate-to-pg — copy existing SQLite data into PostgreSQL
//
// Copies all base tables row-by-row using ON CONFLICT DO NOTHING (idempotent).
// Skips FTS5 virtual tables (PostgreSQL auto-generates tsvectors).
// Skips embeddings table — re-backfill in PG with: mem embed backfill

import { SQLiteAdapter } from '../db/adapters/sqlite.js';
import { PostgresAdapter } from '../db/adapters/postgres.js';
import { PG_SCHEMA_ORDERED } from '../db/schema/postgres.js';

// schema_meta is intentionally excluded — the PG schema version is managed
// by mem init, not copied from SQLite (which may be at a different version).
const TABLES = [
  'sessions',
  'messages',
  'decisions',
  'learnings',
  'errors',
  'breadcrumbs',
  'loa_entries',
  'telos',
  'documents',
];

export async function runMigrateToPg(options: { yes?: boolean }): Promise<void> {
  console.log('Migrate SQLite → PostgreSQL\n===========================\n');
  console.log('Embeddings will be SKIPPED — re-backfill with: mem embed backfill\n');

  const sqlite = SQLiteAdapter.open();

  try {
    // Dry-run: show row counts from SQLite without touching PostgreSQL
    if (!options.yes) {
      for (const table of TABLES) {
        try {
          const rows = await sqlite.query(`SELECT COUNT(*) AS c FROM ${table}`);
          const count = (rows[0] as any)?.c ?? 0;
          console.log(`  ${table}: ${count} rows`);
        } catch {
          console.log(`  ${table}: skipped (not found in SQLite)`);
        }
      }
      console.log('\n[DRY RUN] Run with --yes to perform the migration.');
      console.log('After migration, run: mem embed backfill (for each table you had embeddings for)');
      return;
    }

    // Actual migration: connect to PG and copy
    const pg = await PostgresAdapter.init(PG_SCHEMA_ORDERED);
    try {
      let grandTotal = 0;

      // Pre-flight: PG enforces FK constraints strictly. If any child records (decisions,
      // learnings, etc.) reference a session_id that doesn't exist in sessions, the INSERT
      // fails. This happens when records were manually bootstrapped before sessions were
      // ever imported (e.g. a "lmf4-genesis" seed session).
      //
      // Only stub session_ids that are genuinely orphaned in SQLite — ones that exist in
      // real sessions are migrated normally in the sessions table pass below.
      const childTables = ['decisions', 'learnings', 'breadcrumbs', 'loa_entries', 'messages'];
      const referencedSessionIds = new Set<string>();
      for (const t of childTables) {
        try {
          const rows = await sqlite.query<{ session_id: string }>(`SELECT DISTINCT session_id FROM ${t} WHERE session_id IS NOT NULL`);
          for (const r of rows) referencedSessionIds.add(r.session_id);
        } catch {}
      }
      const knownSessionIds = new Set<string>();
      try {
        const sessions = await sqlite.query<{ session_id: string }>('SELECT session_id FROM sessions');
        for (const r of sessions) knownSessionIds.add(r.session_id);
      } catch {}

      const orphaned = [...referencedSessionIds]
        .filter(sid => !knownSessionIds.has(sid))
        .sort((a, b) => {
          // lmf4-genesis is the system bootstrap session — always insert first so it gets ID 1
          if (a === 'lmf4-genesis') return -1;
          if (b === 'lmf4-genesis') return 1;
          return a.localeCompare(b);
        });
      for (const sid of orphaned) {
        await pg.run(
          `INSERT INTO sessions (session_id, started_at) VALUES (?, NOW()) ON CONFLICT (session_id) DO NOTHING`,
          [sid]
        );
      }
      if (orphaned.length > 0) {
        console.log(`✓ Created ${orphaned.length} stub session(s) for orphaned references: ${orphaned.join(', ')}`);
      }

      for (const table of TABLES) {
        let rows: Record<string, unknown>[];
        try {
          rows = await sqlite.query(`SELECT * FROM ${table}`);
        } catch {
          console.log(`  ${table}: skipped (not found in SQLite)`);
          continue;
        }

        if (rows.length === 0) {
          console.log(`  ${table}: 0 rows (empty)`);
          continue;
        }

        let copied = 0;
        let skipped = 0;
        for (const row of rows) {
          const cols = Object.keys(row);
          const vals = cols.map(c => row[c]);
          const placeholders = cols.map(() => '?').join(', ');
          try {
            await pg.run(
              `INSERT INTO ${table} (${cols.join(', ')}) VALUES (${placeholders}) ON CONFLICT DO NOTHING`,
              vals
            );
            copied++;
          } catch {
            skipped++;
          }
        }

        console.log(`✓ ${table}: ${copied} copied, ${skipped} skipped`);
        grandTotal += copied;
      }

      console.log(`\n✓ Migration complete: ${grandTotal} rows copied`);
      console.log('Next steps:');
      console.log('  mem stats --db=postgres           # verify counts');
      console.log('  mem search "test" --db=postgres   # verify FTS');
      console.log('  mem embed backfill --table loa    # re-build embeddings in PG');
    } finally {
      await pg.close();
    }
  } finally {
    await sqlite.close();
  }
}
