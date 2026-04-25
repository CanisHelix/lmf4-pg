// Import standalone markdown documents into the database
// mem docs import [--dry-run] [--yes]

import { existsSync, readFileSync, statSync, readdirSync } from 'fs';
import { join, basename } from 'path';
import { homedir } from 'os';
import { getDb } from '../db/index.js';

const LMF_BASE_DIR = process.env.LMF_BASE_DIR || join(homedir(), '.claude');

interface DocFile {
  path: string;
  title: string;
  type: 'diary' | 'reference' | 'wisdom' | 'plan' | 'memory' | 'enterprise' | 'other';
  content: string;
  summary: string | null;
  sizeBytes: number;
  fileModifiedAt: Date;
}

const DOCUMENT_SOURCES: { pattern: string; type: DocFile['type']; minSize?: number }[] = [
  { pattern: 'MEMORY/DISTILLED.md', type: 'memory' },
  { pattern: 'MEMORY/DECISIONS.log', type: 'memory' },
  { pattern: 'MEMORY/REJECTIONS.log', type: 'memory' },
  { pattern: 'MEMORY/HOT_RECALL.md', type: 'memory' },
  { pattern: 'plans/*.md', type: 'plan' },
  { pattern: 'History/wisdom/**/*_wisdom.md', type: 'wisdom' },
];

function extractTitle(content: string, filename: string): string {
  const h1Match = content.match(/^#\s+(.+)$/m);
  if (h1Match) return h1Match[1].trim();
  const boldTitleMatch = content.match(/\*\*(?:Title|Name):\*\*\s*(.+)/i);
  if (boldTitleMatch) return boldTitleMatch[1].trim();
  return basename(filename, '.md').replace(/[-_]/g, ' ');
}

function extractSummary(content: string): string | null {
  const purposeMatch = content.match(/\*\*Purpose:\*\*\s*(.+)/i);
  if (purposeMatch) return purposeMatch[1].trim();
  const lines = content.split('\n');
  for (let i = 0; i < Math.min(20, lines.length); i++) {
    const line = lines[i].trim();
    if (line && !line.startsWith('#') && !line.startsWith('*') && !line.startsWith('-') && line.length > 30) {
      return line.substring(0, 200);
    }
  }
  return null;
}

function findFiles(baseDir: string, pattern: string): string[] {
  const results: string[] = [];
  if (pattern.includes('*')) {
    const parts = pattern.split('/');
    const dirPart = parts.slice(0, -1).join('/');
    const filePart = parts[parts.length - 1];
    const searchDir = join(baseDir, dirPart);
    if (!existsSync(searchDir)) return results;
    const searchRecursively = (dir: string) => {
      try {
        const entries = readdirSync(dir, { withFileTypes: true });
        for (const entry of entries) {
          const fullPath = join(dir, entry.name);
          if (entry.isDirectory() && pattern.includes('**')) searchRecursively(fullPath);
          else if (entry.isFile()) {
            if (filePart === '*.md' && entry.name.endsWith('.md')) results.push(fullPath);
            else if (filePart.includes('*') && entry.name.endsWith('.md') && entry.name.includes(filePart.replace('*', '').replace('.md', ''))) results.push(fullPath);
          }
        }
      } catch { /* ignore permission errors */ }
    };
    searchRecursively(searchDir);
  } else {
    const fullPath = join(baseDir, pattern);
    if (existsSync(fullPath)) results.push(fullPath);
  }
  return results;
}

function collectDocuments(): DocFile[] {
  const docs: DocFile[] = [];
  const seen = new Set<string>();
  for (const source of DOCUMENT_SOURCES) {
    const files = findFiles(LMF_BASE_DIR, source.pattern);
    for (const filePath of files) {
      if (seen.has(filePath)) continue;
      seen.add(filePath);
      try {
        const stats = statSync(filePath);
        if (stats.size < (source.minSize || 500)) continue;
        const content = readFileSync(filePath, 'utf-8');
        const relativePath = filePath.replace(LMF_BASE_DIR + '/', '');
        docs.push({
          path: relativePath,
          title: extractTitle(content, filePath),
          type: source.type,
          content,
          summary: extractSummary(content),
          sizeBytes: stats.size,
          fileModifiedAt: stats.mtime,
        });
      } catch { /* skip unreadable */ }
    }
  }
  return docs;
}

export async function runImportDocs(options: { dryRun?: boolean; yes?: boolean; verbose?: boolean }): Promise<void> {
  console.log('Import Standalone Documents\n===========================\n');

  const docs = collectDocuments();
  console.log(`Found ${docs.length} documents to import\n`);
  if (docs.length === 0) { console.log('No documents found to import.'); return; }

  const db = await getDb();
  const existingRows = await db.query<{ path: string }>('SELECT path FROM documents');
  const existing = new Set(existingRows.map(r => r.path));

  const toInsert = docs.filter(d => !existing.has(d.path));
  const toUpdate = docs.filter(d => existing.has(d.path));

  if (options.verbose || options.dryRun) {
    for (const doc of toInsert) console.log(`[NEW] ${doc.type}: ${doc.title} (${(doc.sizeBytes / 1024).toFixed(1)}KB)`);
    for (const doc of toUpdate) console.log(`[UPDATE] ${doc.type}: ${doc.title} (${(doc.sizeBytes / 1024).toFixed(1)}KB)`);
  }

  console.log(`\nSummary:`);
  console.log(`  New documents:    ${toInsert.length}`);
  console.log(`  To update:        ${toUpdate.length}`);
  console.log(`  Already exists:   ${existing.size - toUpdate.length}`);

  if (options.dryRun) { console.log('\n[DRY RUN] Would import/update the above documents.'); return; }
  if (!options.yes && toInsert.length + toUpdate.length > 0) { console.log('\nRun with --yes to import, or --dry-run to preview.'); return; }

  console.log('\nImporting...\n');
  let imported = 0;
  let updated = 0;
  let errors = 0;

  for (const doc of toInsert) {
    try {
      await db.run(
        `INSERT INTO documents (path, title, type, content, summary, size_bytes, file_modified_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [doc.path, doc.title, doc.type, doc.content, doc.summary, doc.sizeBytes, doc.fileModifiedAt.toISOString()]
      );
      console.log(`✓ Imported: ${doc.title}`);
      imported++;
    } catch (e: unknown) {
      console.log(`✗ Error importing ${doc.path}: ${e instanceof Error ? e.message : e}`);
      errors++;
    }
  }

  for (const doc of toUpdate) {
    try {
      await db.run(
        `UPDATE documents SET title = ?, type = ?, content = ?, summary = ?, size_bytes = ?, file_modified_at = ?, updated_at = CURRENT_TIMESTAMP WHERE path = ?`,
        [doc.title, doc.type, doc.content, doc.summary, doc.sizeBytes, doc.fileModifiedAt.toISOString(), doc.path]
      );
      console.log(`✓ Updated: ${doc.title}`);
      updated++;
    } catch (e: unknown) {
      console.log(`✗ Error updating ${doc.path}: ${e instanceof Error ? e.message : e}`);
      errors++;
    }
  }

  console.log('\nImport Complete\n===============');
  console.log(`  Imported: ${imported}`);
  console.log(`  Updated:  ${updated}`);
  console.log(`  Errors:   ${errors}`);
}

export async function runDocsList(): Promise<void> {
  const db = await getDb();
  const docs = await db.query<{ id: number; path: string; title: string; type: string; size_bytes: number; created_at: string }>(
    `SELECT id, path, title, type, size_bytes, created_at FROM documents ORDER BY type, title`
  );

  console.log(`Documents in LMF (${docs.length} total):\n`);
  let currentType = '';
  for (const doc of docs) {
    if (doc.type !== currentType) {
      currentType = doc.type;
      console.log(`\n[${currentType.toUpperCase()}]`);
    }
    console.log(`  #${doc.id} ${doc.title} (${(Number(doc.size_bytes) / 1024).toFixed(1)}KB)`);
  }
}

export async function runDocsSearch(query: string, limit: number = 10): Promise<void> {
  const db = await getDb();

  let results: { id: number; path: string; title: string; type: string; size_bytes: number; snippet: string }[];

  if (db.backend === 'sqlite') {
    results = await db.query(
      `SELECT d.id, d.path, d.title, d.type, d.size_bytes,
              snippet(documents_fts, 2, '**', '**', '...', 40) as snippet
       FROM documents_fts f JOIN documents d ON d.id = f.rowid
       WHERE documents_fts MATCH ? ORDER BY rank LIMIT ?`,
      [query, limit]
    );
  } else {
    results = (await db.query<{ id: number; path: string; title: string; type: string; size_bytes: number; snippet: string }>(
      `SELECT id, path, title, type, size_bytes,
              ts_headline('english', content, plainto_tsquery('english', ?), 'MaxWords=20,MinWords=5') as snippet
       FROM documents
       WHERE fts @@ plainto_tsquery('english', ?)
       ORDER BY ts_rank(fts, plainto_tsquery('english', ?)) DESC LIMIT ?`,
      [query, query, query, limit]
    ));
  }

  console.log(`Found ${results.length} document(s) for "${query}":\n`);
  for (const doc of results) {
    console.log(`**${doc.title}** (${doc.type})`);
    console.log(`  ${doc.snippet}`);
    console.log('');
  }
}

export async function runDocsShow(id: number): Promise<void> {
  const db = await getDb();
  const doc = await db.queryOne<{ id: number; path: string; title: string; type: string; content: string; summary: string; size_bytes: number; created_at: string }>(
    `SELECT * FROM documents WHERE id = ?`,
    [id]
  );

  if (!doc) { console.log(`Document #${id} not found.`); return; }

  console.log(`Document #${doc.id}: ${doc.title}`);
  console.log(`${'='.repeat(40)}`);
  console.log(`Type: ${doc.type}`);
  console.log(`Path: ${doc.path}`);
  console.log(`Size: ${(Number(doc.size_bytes) / 1024).toFixed(1)} KB`);
  console.log(`Imported: ${doc.created_at}`);
  if (doc.summary) console.log(`Summary: ${doc.summary}`);
  console.log(`\n--- Content Preview (first 2000 chars) ---\n`);
  console.log(doc.content.substring(0, 2000));
  if (doc.content.length > 2000) console.log('\n... [truncated]');
}
