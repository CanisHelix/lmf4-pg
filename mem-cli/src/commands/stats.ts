// mem stats command

import { getStats } from '../lib/memory.js';
import { getDb } from '../db/index.js';
import { DISPLAY_NAME } from '../version.js';

export async function runStats(): Promise<void> {
  const stats = await getStats();
  const db = await getDb();

  const dbInfo = db.backend === 'sqlite'
    ? `~/.claude/memory.db (SQLite)`
    : `PostgreSQL [${process.env.LMF_DATABASE_URL ?? 'default'}]`;

  const sizeKb = (stats.db_size_bytes / 1024).toFixed(1);
  const sizeMb = (stats.db_size_bytes / (1024 * 1024)).toFixed(2);

  console.log(`${DISPLAY_NAME} Statistics`);
  console.log('===========================\n');
  console.log(`Database: ${dbInfo}`);
  console.log(`Size: ${sizeMb} MB (${sizeKb} KB)\n`);
  console.log('Record Counts:');
  console.log(`  Sessions:    ${stats.sessions.toLocaleString()}`);
  console.log(`  Messages:    ${stats.messages.toLocaleString()}`);
  console.log(`  LoA Entries: ${stats.loa_entries.toLocaleString()}`);
  console.log(`  TELOS:       ${stats.telos.toLocaleString()}`);
  console.log(`  Documents:   ${stats.documents.toLocaleString()}`);
  console.log(`  Decisions:   ${stats.decisions.toLocaleString()}`);
  console.log(`  Learnings:   ${stats.learnings.toLocaleString()}`);
  console.log(`  Breadcrumbs: ${stats.breadcrumbs.toLocaleString()}`);
  console.log('');

  const total = stats.sessions + stats.messages + stats.loa_entries + stats.telos +
    stats.documents + stats.decisions + stats.learnings + stats.breadcrumbs;
  console.log(`Total Records: ${total.toLocaleString()}`);
}
