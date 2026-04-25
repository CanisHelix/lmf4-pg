#!/usr/bin/env node

// LMF - Persistent AI Memory System
// CLI entry point

// Parse --db=sqlite|postgres BEFORE Commander sees the args
const dbFlagIdx = process.argv.findIndex(a => a.startsWith('--db='));
if (dbFlagIdx !== -1) {
  const val = process.argv[dbFlagIdx].split('=')[1].toLowerCase();
  if (val === 'postgres' || val === 'postgresql') {
    process.env.LMF_DB_BACKEND = 'postgres';
  } else if (val === 'sqlite') {
    process.env.LMF_DB_BACKEND = 'sqlite';
  } else {
    console.error(`Unknown --db value: ${val}. Use 'sqlite' or 'postgres'.`);
    process.exit(1);
  }
  process.argv.splice(dbFlagIdx, 1);
}

import { Command } from 'commander';
import { VERSION, DISPLAY_NAME } from './version.js';
import { runInit, runMigrate } from './commands/init.js';
import { runAddBreadcrumb, runAddDecision, runAddLearning } from './commands/add.js';
import { runSearch } from './commands/search.js';
import { runRecent } from './commands/recent.js';
import { runShow } from './commands/show.js';
import { runStats } from './commands/stats.js';
import { runImport } from './commands/import.js';
import { runLoa, runLoaQuote, runLoaShow, runLoaList } from './commands/loa.js';
import { runDump } from './commands/dump.js';
import { runImportLegacy } from './commands/import-legacy.js';
import { runImportDocs, runDocsList, runDocsSearch, runDocsShow } from './commands/import-docs.js';
import { runCatchup } from './commands/catchup.js';
import { runEmbedBackfill, runSemanticSearch, runEmbedStats, runHybridSearch } from './commands/embed.js';
import { runMigrateToPg } from './commands/migrate-to-pg.js';
import { closeDb } from './db/index.js';

const program = new Command();

program
  .name('mem')
  .description(`${DISPLAY_NAME} - Persistent AI Memory System`)
  .version(VERSION)
  .enablePositionalOptions();

// mem init
program
  .command('init')
  .description('Initialize the memory database (safe to re-run)')
  .action(async () => {
    await runInit();
    await closeDb();
  });

// mem migrate
program
  .command('migrate')
  .description('Apply pending schema migrations to an existing database')
  .action(async () => {
    await runMigrate();
    await closeDb();
  });

// mem migrate-to-pg
program
  .command('migrate-to-pg')
  .description('Copy existing SQLite data into PostgreSQL (use LMF_DATABASE_URL or --db=postgres)')
  .option('-y, --yes', 'Perform migration (default: dry-run preview)')
  .action(async (options) => {
    await runMigrateToPg({ yes: options.yes });
  });

// mem add
const addCmd = program.command('add').description('Add a memory record');

addCmd
  .command('breadcrumb <content>')
  .description('Add a breadcrumb (context, note, reference)')
  .option('-p, --project <name>', 'Project name')
  .option('-c, --category <cat>', 'Category (context, note, todo, reference)')
  .option('-i, --importance <n>', 'Importance 1-10', '5')
  .action(async (content, options) => {
    await runAddBreadcrumb(content, { project: options.project, category: options.category, importance: parseInt(options.importance, 10) });
    await closeDb();
  });

addCmd
  .command('decision <decision>')
  .description('Record a decision')
  .option('-p, --project <name>', 'Project name')
  .option('-c, --category <cat>', 'Category (architecture, tooling, process)')
  .option('-w, --why <reasoning>', 'Why this decision was made')
  .option('-a, --alternatives <alt>', 'Alternatives considered')
  .action(async (decision, options) => {
    await runAddDecision(decision, { project: options.project, category: options.category, why: options.why, alternatives: options.alternatives });
    await closeDb();
  });

addCmd
  .command('learning <problem> <solution>')
  .description('Record a learning (problem + solution)')
  .option('-p, --project <name>', 'Project name')
  .option('-c, --category <cat>', 'Category (error, pattern, optimization)')
  .option('--prevention <text>', 'How to prevent in future')
  .option('-t, --tags <tags>', 'Comma-separated tags')
  .action(async (problem, solution, options) => {
    await runAddLearning(problem, solution, { project: options.project, category: options.category, prevention: options.prevention, tags: options.tags });
    await closeDb();
  });

// mem search
program
  .command('search <query>')
  .description('Full-text search across all memory')
  .option('-p, --project <name>', 'Filter by project')
  .option('-t, --table <table>', 'Search specific table (messages, decisions, learnings, breadcrumbs)')
  .option('-l, --limit <n>', 'Max results', '20')
  .action(async (query, options) => {
    await runSearch(query, { project: options.project, table: options.table, limit: parseInt(options.limit, 10) });
    await closeDb();
  });

// mem recent
program
  .command('recent [table]')
  .description('Show recent records (messages, decisions, learnings, breadcrumbs, all)')
  .option('-p, --project <name>', 'Filter by project')
  .option('-l, --limit <n>', 'Max results', '10')
  .action(async (table, options) => {
    await runRecent(table, { project: options.project, limit: parseInt(options.limit, 10) });
    await closeDb();
  });

// mem show
program
  .command('show <table> <id>')
  .description('Show full details of a record')
  .action(async (table, id) => {
    await runShow(table, parseInt(id, 10));
    await closeDb();
  });

// mem stats
program
  .command('stats')
  .description('Show database statistics')
  .action(async () => {
    await runStats();
    await closeDb();
  });

// mem import
program
  .command('import')
  .description('Import conversations from Claude Code session files')
  .option('--dry-run', 'Preview what would be imported without making changes')
  .option('-v, --verbose', 'Show detailed progress')
  .option('-y, --yes', 'Confirm import (required to actually import)')
  .action(async (options) => {
    await runImport({ dryRun: options.dryRun, verbose: options.verbose, yes: options.yes });
    await closeDb();
  });

// mem loa
const loaCmd = program.command('loa').description('Library of Alexandria - curated knowledge capture');

loaCmd
  .command('write <title>')
  .description('Capture messages since last LoA entry (extracted via claude --print)')
  .option('-p, --project <name>', 'Project name')
  .option('-c, --continues <id>', 'Continue from a previous LoA entry')
  .option('-t, --tags <tags>', 'Comma-separated tags')
  .option('-n, --limit <n>', 'Max messages to process (default: all since last LoA)')
  .action(async (title, options) => {
    await runLoa(title, {
      project: options.project,
      continues: options.continues ? parseInt(options.continues, 10) : undefined,
      tags: options.tags,
      limit: options.limit ? parseInt(options.limit, 10) : undefined,
    });
    await closeDb();
  });

loaCmd
  .command('show <id>')
  .description('Show full LoA entry with its extract')
  .action(async (id) => {
    await runLoaShow(parseInt(id, 10));
    await closeDb();
  });

loaCmd
  .command('quote <id>')
  .description('Show the raw source messages for an LoA entry')
  .action(async (id) => {
    await runLoaQuote(parseInt(id, 10));
    await closeDb();
  });

loaCmd
  .command('list')
  .description('List recent LoA entries')
  .option('-l, --limit <n>', 'Max entries', '10')
  .action(async (options) => {
    await runLoaList(parseInt(options.limit, 10));
    await closeDb();
  });

// mem import-legacy
program
  .command('import-legacy')
  .description('Import legacy DISTILLED.md extracts as LoA entries')
  .option('--dry-run', 'Preview what would be imported')
  .option('-v, --verbose', 'Show detailed progress')
  .option('-y, --yes', 'Confirm import')
  .option('-s, --source <source>', 'Source: distilled, hot_recall, or all', 'all')
  .action(async (options) => {
    await runImportLegacy({ dryRun: options.dryRun, verbose: options.verbose, yes: options.yes, source: options.source });
    await closeDb();
  });

// mem catchup
program
  .command('catchup')
  .description('Extract any unprocessed session transcripts (idempotent; safe to run often)')
  .option('-f, --force', 'Re-extract all sessions, even already-extracted ones')
  .action(async (options) => {
    await runCatchup({ force: !!options.force });
    await closeDb();
  });

// mem dump
program
  .command('dump <title>')
  .description('Flush current session to DB and capture LoA entry')
  .option('-p, --project <name>', 'Project name')
  .option('-c, --continues <id>', 'Continue from a previous LoA entry')
  .option('-t, --tags <tags>', 'Comma-separated tags')
  .option('-n, --limit <n>', 'Max messages to process')
  .option('--skip-fabric', 'Skip extraction (import only; option kept for LMF3 compat)')
  .action(async (title, options) => {
    await runDump(title, {
      project: options.project,
      continues: options.continues ? parseInt(options.continues, 10) : undefined,
      tags: options.tags,
      limit: options.limit ? parseInt(options.limit, 10) : undefined,
      skipFabric: options.skipFabric,
    });
    await closeDb();
  });

// mem docs
const docsCmd = program.command('docs').description('Standalone documents - diary, reference, wisdom files');

docsCmd
  .command('import')
  .description('Import standalone markdown documents from ~/.claude/')
  .option('--dry-run', 'Preview what would be imported')
  .option('-v, --verbose', 'Show detailed progress')
  .option('-y, --yes', 'Confirm import')
  .action(async (options) => {
    await runImportDocs({ dryRun: options.dryRun, verbose: options.verbose, yes: options.yes });
    await closeDb();
  });

docsCmd.command('list').description('List imported documents').action(async () => { await runDocsList(); await closeDb(); });

docsCmd
  .command('search <query>')
  .description('Search documents')
  .option('-l, --limit <n>', 'Max results', '10')
  .action(async (query, options) => {
    await runDocsSearch(query, parseInt(options.limit, 10));
    await closeDb();
  });

docsCmd.command('show <id>').description('Show a document').action(async (id) => { await runDocsShow(parseInt(id, 10)); await closeDb(); });

// mem embed
const embedCmd = program.command('embed').description('Vector embeddings for semantic search');

embedCmd
  .command('backfill')
  .description('Generate embeddings for existing records')
  .option('-t, --table <table>', 'Table to embed: loa, decisions, messages', 'loa')
  .option('-l, --limit <n>', 'Max records to embed', '100')
  .option('-f, --force', 'Re-embed even if already embedded')
  .action(async (options) => {
    await runEmbedBackfill({ table: options.table as 'loa' | 'decisions' | 'messages', limit: parseInt(options.limit, 10), force: options.force });
    await closeDb();
  });

embedCmd.command('stats').description('Show embedding statistics').action(async () => { await runEmbedStats(); await closeDb(); });

// mem semantic
program
  .command('semantic <query>')
  .description('Semantic search using vector embeddings')
  .option('-t, --table <table>', 'Search specific table (loa_entries, decisions, messages)')
  .option('-l, --limit <n>', 'Max results', '10')
  .action(async (query, options) => {
    await runSemanticSearch(query, { table: options.table, limit: parseInt(options.limit, 10) });
    await closeDb();
  });

// mem hybrid
program
  .command('hybrid <query>')
  .description('Hybrid search combining keywords (FTS) + semantics (embeddings) with RRF fusion')
  .option('-t, --table <table>', 'Search specific table (loa_entries, decisions, messages)')
  .option('-l, --limit <n>', 'Max results', '10')
  .action(async (query, options) => {
    await runHybridSearch(query, { table: options.table, limit: parseInt(options.limit, 10) });
    await closeDb();
  });

// Default: mem <query> → hybrid search
program
  .arguments('[query]')
  .option('-p, --project <name>', 'Filter by project')
  .option('-t, --table <table>', 'Search specific table')
  .option('-l, --limit <n>', 'Max results', '10')
  .option('-k, --keyword', 'Use keyword search only (FTS)')
  .option('-v, --vector', 'Use vector search only (semantic)')
  .action(async (query, options) => {
    const knownCommands = ['init', 'migrate', 'migrate-to-pg', 'add', 'search', 'recent', 'show',
      'stats', 'import', 'loa', 'docs', 'dump', 'embed', 'semantic', 'hybrid', 'catchup', 'import-legacy'];
    if (query && !knownCommands.includes(query)) {
      if (options.keyword) {
        await runSearch(query, { project: options.project, table: options.table, limit: parseInt(options.limit, 10) });
      } else if (options.vector) {
        await runSemanticSearch(query, { table: options.table, limit: parseInt(options.limit, 10) });
      } else {
        await runHybridSearch(query, { table: options.table, limit: parseInt(options.limit, 10) });
      }
      await closeDb();
    }
  });

program.parse();
