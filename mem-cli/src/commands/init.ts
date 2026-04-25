// mem init command

import { initDb, activeBackend } from '../db/index.js';
import { existsSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';

const SETTINGS_PATH = join(homedir(), '.claude', 'settings.json');

export async function runInit(): Promise<void> {
  const backend = activeBackend();
  console.log(`Initialising LMF memory database [${backend}]...`);

  const result = await initDb(backend);
  console.log(`✓ Database ${result.created ? 'created' : 'already exists'} [${backend}]`);

  await patchSettingsJson(backend);

  console.log('\n✓ Init complete.');
  if (backend === 'postgres') {
    console.log('  Hooks and MCP server will use PostgreSQL via Claude Code env injection.');
    console.log(`  Connection: ${process.env.LMF_DATABASE_URL ?? 'postgresql://lmf:changeme@localhost:5432/lmf'}`);
    console.log('\n  Note: if you use systemd timers for mem catchup, add to each .service unit:');
    console.log('    Environment=LMF_DB_BACKEND=postgres');
    console.log(`    Environment=LMF_DATABASE_URL=${process.env.LMF_DATABASE_URL ?? 'postgresql://lmf:changeme@localhost:5432/lmf'}`);
  }
}

export async function runMigrate(): Promise<void> {
  const backend = activeBackend();
  console.log(`Applying schema migrations [${backend}]...`);
  const result = await initDb(backend);
  console.log(`✓ Schema up to date [${backend}]${result.created ? ' (freshly created)' : ''}`);
}

async function patchSettingsJson(backend: 'sqlite' | 'postgres'): Promise<void> {
  let settings: Record<string, unknown> = {};
  if (existsSync(SETTINGS_PATH)) {
    try {
      settings = JSON.parse(readFileSync(SETTINGS_PATH, 'utf8'));
    } catch {
      console.warn('⚠️  Could not parse settings.json — will merge carefully');
    }
  }

  const env = (settings.env ?? {}) as Record<string, string>;

  if (backend === 'postgres') {
    env['LMF_DB_BACKEND'] = 'postgres';
    env['LMF_DATABASE_URL'] = process.env.LMF_DATABASE_URL ?? 'postgresql://lmf:changeme@localhost:5432/lmf';
    console.log('✓ settings.json env block → LMF_DB_BACKEND=postgres');
  } else {
    delete env['LMF_DB_BACKEND'];
    delete env['LMF_DATABASE_URL'];
    console.log('✓ settings.json env block → SQLite (default, no backend key needed)');
  }

  settings.env = env;
  writeFileSync(SETTINGS_PATH, JSON.stringify(settings, null, 2), 'utf8');
}
