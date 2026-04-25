// Import legacy DISTILLED.md extracts into LoA entries

import { readFileSync, existsSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { getDb } from '../db/index.js';
import { createLoaEntry } from '../lib/memory.js';

const DISTILLED_PATH = join(homedir(), '.claude', 'MEMORY', 'DISTILLED.md');
const HOT_RECALL_PATH = join(homedir(), '.claude', 'MEMORY', 'HOT_RECALL.md');

interface LegacyExtract {
  date: string;
  project: string;
  content: string;
  title: string;
}

function parseDistilledFile(filePath: string): LegacyExtract[] {
  if (!existsSync(filePath)) { console.log(`File not found: ${filePath}`); return []; }

  const content = readFileSync(filePath, 'utf-8');
  const extracts: LegacyExtract[] = [];
  const extractRegex = /## Extracted:\s*([0-9-]+)\s*\|\s*([^\n]+)\n([\s\S]*?)(?=\n---\n## Extracted:|\n---\s*$|$)/g;

  let match;
  while ((match = extractRegex.exec(content)) !== null) {
    const date = match[1].trim();
    const project = match[2].trim();
    let extractContent = match[3].trim().replace(/\n---\s*$/, '').trim();
    if (!extractContent) continue;

    let title = `Legacy extract from ${project}`;
    const sessionMatch = extractContent.match(/SESSION:\s*([^\n]+)/);
    if (sessionMatch) title = sessionMatch[1].trim();
    const summaryMatch = extractContent.match(/ONE SENTENCE SUMMARY\s*\n([^\n]+)/i);
    if (summaryMatch) title = summaryMatch[1].trim();

    extracts.push({ date, project, content: extractContent, title });
  }
  return extracts;
}

async function extractExists(title: string, date: string): Promise<boolean> {
  const db = await getDb();
  const result = await db.queryOne(
    `SELECT 1 FROM loa_entries WHERE title = ? AND DATE(created_at) = ?`,
    [title, date]
  );
  return !!result;
}

export interface ImportLegacyOptions {
  dryRun?: boolean;
  verbose?: boolean;
  yes?: boolean;
  source?: 'distilled' | 'hot_recall' | 'all';
}

export async function runImportLegacy(options: ImportLegacyOptions): Promise<void> {
  console.log('Import Legacy Memory\n====================\n');

  const sources: string[] = [];
  if (options.source === 'distilled' || options.source === 'all' || !options.source) sources.push(DISTILLED_PATH);
  if (options.source === 'hot_recall' || options.source === 'all') sources.push(HOT_RECALL_PATH);

  let totalExtracts: LegacyExtract[] = [];
  for (const source of sources) {
    console.log(`Parsing: ${source}`);
    const extracts = parseDistilledFile(source);
    console.log(`  Found ${extracts.length} extracts\n`);
    totalExtracts = totalExtracts.concat(extracts);
  }

  console.log(`Total extracts found: ${totalExtracts.length}\n`);

  let newCount = 0;
  let skipCount = 0;
  for (const extract of totalExtracts) {
    if (await extractExists(extract.title, extract.date)) {
      skipCount++;
      if (options.verbose) console.log(`[SKIP] ${extract.date} | ${extract.title.slice(0, 50)}...`);
    } else {
      newCount++;
      if (options.verbose) console.log(`[NEW]  ${extract.date} | ${extract.title.slice(0, 50)}...`);
    }
  }

  console.log(`\nNew extracts to import: ${newCount}`);
  console.log(`Already exists (skip):  ${skipCount}\n`);

  if (newCount === 0) { console.log('Nothing new to import.'); return; }
  if (options.dryRun) { console.log('[DRY RUN] Would import the above extracts.'); return; }
  if (!options.yes) { console.log('Run with --yes to confirm import, or --dry-run to preview.'); return; }

  console.log('Importing...\n');
  let imported = 0;
  let errors = 0;

  for (const extract of totalExtracts) {
    if (await extractExists(extract.title, extract.date)) continue;
    try {
      const loaId = await createLoaEntry({
        title: extract.title, fabric_extract: extract.content, project: extract.project,
        message_range_start: undefined, message_range_end: undefined,
        message_count: undefined, tags: 'legacy,imported',
      });

      const db = await getDb();
      await db.run(`UPDATE loa_entries SET created_at = ? WHERE id = ?`, [`${extract.date} 00:00:00`, loaId]);

      imported++;
      if (options.verbose) console.log(`✓ LoA #${loaId}: ${extract.title.slice(0, 50)}...`);
    } catch (err) {
      errors++;
      console.error(`✗ Error importing ${extract.title}: ${err}`);
    }
  }

  console.log(`\nImport Complete\n===============`);
  console.log(`  Imported: ${imported}`);
  console.log(`  Skipped:  ${skipCount}`);
  console.log(`  Errors:   ${errors}`);
}
