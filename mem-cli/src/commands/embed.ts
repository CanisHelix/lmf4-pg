// mem embed command - Generate and store embeddings for semantic search

import { getDb } from '../db/index.js';
import type { DbAdapter } from '../db/adapter.js';
import {
  embed, embeddingToBlob, blobToEmbedding,
  cosineSimilarity, checkEmbeddingService, reciprocalRankFusion,
} from '../lib/embeddings.js';
import { search as ftsSearch } from '../lib/memory.js';

interface EmbedOptions {
  table?: 'loa' | 'decisions' | 'messages';
  limit?: number;
  force?: boolean;
}

function getContentForTable(table: string, row: Record<string, unknown>): string {
  switch (table) {
    case 'loa': return `${row.title}\n\n${row.fabric_extract}`;
    case 'decisions': return `${row.decision}\n\nReasoning: ${row.reasoning || 'N/A'}`;
    case 'messages': return String(row.content || '');
    default: return String(row.content || row.text || '');
  }
}

function embeddingFromRow(backend: 'sqlite' | 'postgres', raw: unknown): number[] {
  if (backend === 'sqlite') {
    return blobToEmbedding(raw as Buffer);
  }
  if (typeof raw === 'string') return JSON.parse(raw);
  if (Array.isArray(raw)) return raw as number[];
  return [];
}

/**
 * Backend-aware vector search.
 * PostgreSQL: uses <=> operator with HNSW index (server-side ANN, O(log n)).
 * SQLite:     reads all embeddings and ranks client-side (fine at small scale).
 */
async function vectorSearch(
  db: DbAdapter,
  queryEmbedding: number[],
  limit: number,
  tableFilter?: string
): Promise<Array<{ source_table: string; source_id: number; similarity: number }>> {
  const whereClause = tableFilter ? `WHERE source_table = '${tableFilter}'` : '';

  if (db.backend === 'postgres') {
    const vectorStr = JSON.stringify(queryEmbedding);
    const rows = await db.query<{ source_table: string; source_id: number; similarity: number }>(
      `SELECT source_table, source_id,
              1 - (embedding <=> ?::vector) AS similarity
       FROM embeddings ${whereClause}
       ORDER BY embedding <=> ?::vector
       LIMIT ?`,
      [vectorStr, vectorStr, limit]
    );
    return rows.map(r => ({
      source_table: String(r.source_table),
      source_id: Number(r.source_id),
      similarity: Number(r.similarity),
    }));
  }

  // SQLite: client-side cosine similarity
  const rows = await db.query<{ source_table: string; source_id: number; embedding: unknown }>(
    `SELECT source_table, source_id, embedding FROM embeddings ${whereClause}`
  );
  return rows
    .map(r => ({
      source_table: String(r.source_table),
      source_id: Number(r.source_id),
      similarity: cosineSimilarity(queryEmbedding, blobToEmbedding(r.embedding as Buffer)),
    }))
    .sort((a, b) => b.similarity - a.similarity)
    .slice(0, limit);
}

export async function runEmbedBackfill(options: EmbedOptions): Promise<void> {
  const db = await getDb();
  const table = options.table || 'loa';
  const limit = options.limit || 100;

  console.log('Checking embedding service...');
  const serviceStatus = await checkEmbeddingService();

  if (!serviceStatus.available) {
    console.error(`\nError: Embedding service not available at ${serviceStatus.url}`);
    console.error(`Make sure Ollama is running with the ${serviceStatus.model} model.`);
    console.error(`\nTo install locally:`);
    console.error(`  1. Install Ollama:  https://ollama.com/download`);
    console.error(`  2. Pull the model:  ollama pull ${serviceStatus.model}`);
    console.error(`\nOr point at a remote Ollama: OLLAMA_URL=http://host:11434 mem embed backfill`);
    process.exit(1);
  }

  console.log(`✓ Embedding service available (${serviceStatus.model} @ ${serviceStatus.url})\n`);

  let sourceTable: string;
  let query: string;

  switch (table) {
    case 'loa':
      sourceTable = 'loa_entries';
      query = options.force
        ? `SELECT id, title, fabric_extract FROM loa_entries ORDER BY created_at DESC LIMIT ?`
        : `SELECT l.id, l.title, l.fabric_extract FROM loa_entries l
           LEFT JOIN embeddings e ON e.source_table = 'loa_entries' AND e.source_id = l.id
           WHERE e.id IS NULL ORDER BY l.created_at DESC LIMIT ?`;
      break;
    case 'decisions':
      sourceTable = 'decisions';
      query = options.force
        ? `SELECT id, decision, reasoning FROM decisions ORDER BY created_at DESC LIMIT ?`
        : `SELECT d.id, d.decision, d.reasoning FROM decisions d
           LEFT JOIN embeddings e ON e.source_table = 'decisions' AND e.source_id = d.id
           WHERE e.id IS NULL ORDER BY d.created_at DESC LIMIT ?`;
      break;
    case 'messages':
      sourceTable = 'messages';
      query = options.force
        ? `SELECT id, content FROM messages WHERE role = 'assistant' ORDER BY timestamp DESC LIMIT ?`
        : `SELECT m.id, m.content FROM messages m
           LEFT JOIN embeddings e ON e.source_table = 'messages' AND e.source_id = m.id
           WHERE e.id IS NULL AND m.role = 'assistant' ORDER BY m.timestamp DESC LIMIT ?`;
      break;
    default:
      console.error(`Unknown table: ${table}`);
      process.exit(1);
  }

  const rows = await db.query<Record<string, unknown>>(query, [limit]);

  if (rows.length === 0) {
    console.log(`No ${table} entries to embed (all already embedded or none exist).`);
    return;
  }

  console.log(`Embedding ${rows.length} ${table} entries...\n`);

  let success = 0;
  let failed = 0;

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    const content = getContentForTable(table, row);

    if (!content || content.trim().length < 10) {
      console.log(`  [${i + 1}/${rows.length}] Skipping #${row.id} (empty content)`);
      failed++;
      continue;
    }

    try {
      process.stdout.write(`  [${i + 1}/${rows.length}] Embedding #${row.id}... `);

      const result = await embed(content);
      const payload = db.backend === 'sqlite'
        ? embeddingToBlob(result.embedding)
        : JSON.stringify(result.embedding);

      await db.run(`
        INSERT INTO embeddings (source_table, source_id, model, dimensions, embedding)
        VALUES (?, ?, ?, ?, ?)
        ON CONFLICT (source_table, source_id) DO UPDATE SET
          embedding = EXCLUDED.embedding, model = EXCLUDED.model, dimensions = EXCLUDED.dimensions
      `, [sourceTable, row.id, result.model, result.dimensions, payload]);

      console.log(`✓ (${result.dimensions}d)`);
      success++;
    } catch (err) {
      console.log(`✗ ${err instanceof Error ? err.message : err}`);
      failed++;
    }
  }

  console.log(`\nDone: ${success} embedded, ${failed} failed`);
}

export async function runSemanticSearch(query: string, options: { table?: string; limit?: number }): Promise<void> {
  const db = await getDb();
  const limit = options.limit || 10;

  const serviceStatus = await checkEmbeddingService();
  if (!serviceStatus.available) {
    console.error(`Error: Embedding service not available at ${serviceStatus.url}`);
    process.exit(1);
  }

  console.log(`Searching for: "${query}"\n`);

  const queryResult = await embed(query);
  const results = await vectorSearch(db, queryResult.embedding, limit, options.table);

  if (results.length === 0) {
    console.log('No embeddings found. Run `mem embed backfill` first.');
    return;
  }

  console.log(`Found ${results.length} result(s) [${db.backend === 'postgres' ? 'HNSW' : 'cosine'}], showing top ${limit}:\n`);

  for (let i = 0; i < Math.min(limit, results.length); i++) {
    const r = results[i];
    const score = (r.similarity * 100).toFixed(1);
    let preview = '';
    let meta = '';

    if (r.source_table === 'loa_entries') {
      const loa = await db.queryOne<{ title: string; fabric_extract: string }>('SELECT title, fabric_extract FROM loa_entries WHERE id = ?', [r.source_id]);
      if (loa) { preview = String(loa.title); meta = `[LoA #${r.source_id}]`; }
    } else if (r.source_table === 'decisions') {
      const dec = await db.queryOne<{ decision: string }>('SELECT decision FROM decisions WHERE id = ?', [r.source_id]);
      if (dec) { preview = String(dec.decision).slice(0, 80); meta = `[Decision #${r.source_id}]`; }
    } else if (r.source_table === 'messages') {
      const msg = await db.queryOne<{ content: string; project: string }>('SELECT content, project FROM messages WHERE id = ?', [r.source_id]);
      if (msg) { preview = String(msg.content).slice(0, 80).replace(/\n/g, ' '); meta = `[Message #${r.source_id}]`; }
    }

    console.log(`${score}% ${meta} ${preview}...`);
  }
}

export async function runEmbedStats(): Promise<void> {
  const db = await getDb();
  console.log('Embedding Statistics\n====================\n');

  const stats = await db.query<{ source_table: string; count: number; model: string }>(
    `SELECT source_table, COUNT(*) as count, model FROM embeddings GROUP BY source_table, model`
  );

  if (stats.length === 0) {
    console.log('No embeddings yet. Run `mem embed --backfill --table loa` to start.');
    return;
  }

  for (const s of stats) console.log(`${s.source_table}: ${s.count} (${s.model})`);

  const total = stats.reduce((sum, s) => sum + Number(s.count), 0);
  console.log(`\nTotal: ${total} embeddings`);

  if (db.backend === 'sqlite') {
    const sizeResult = await db.queryOne<{ bytes: number }>(`SELECT SUM(LENGTH(embedding)) as bytes FROM embeddings`);
    if (sizeResult?.bytes) {
      console.log(`Storage: ${(Number(sizeResult.bytes) / 1024 / 1024).toFixed(2)} MB`);
    }
  }
}

export async function runHybridSearch(query: string, options: { table?: string; limit?: number }): Promise<void> {
  const db = await getDb();
  const limit = options.limit || 10;

  const serviceStatus = await checkEmbeddingService();
  if (!serviceStatus.available) {
    console.error(`Error: Embedding service not available at ${serviceStatus.url}`);
    console.error('Falling back to keyword-only search...\n');
    const ftsResults = await ftsSearch(query, { table: options.table === 'loa_entries' ? 'loa' : options.table, limit });
    console.log(`Keyword search results (${ftsResults.length}):\n`);
    for (const r of ftsResults) console.log(`[${r.table} #${r.id}] ${r.content?.slice(0, 80)}...`);
    return;
  }

  console.log(`Hybrid search for: "${query}"\n`);
  console.log('Running keyword search (FTS)...');

  const ftsTable = options.table === 'loa_entries' ? 'loa' : options.table;
  const ftsResults = await ftsSearch(query, { table: ftsTable, limit: limit * 2 });
  console.log(`  Found ${ftsResults.length} keyword matches`);

  console.log('Running semantic search (embeddings)...');
  const queryResult = await embed(query);
  const topSemantic = await vectorSearch(db, queryResult.embedding, limit * 2, options.table);
  console.log(`  Found ${topSemantic.length} semantic matches [${db.backend === 'postgres' ? 'HNSW' : 'cosine'}]\n`);

  console.log('Applying Reciprocal Rank Fusion (RRF)...\n');

  const ftsRanked = ftsResults.map(r => ({ id: `${r.table === 'loa' ? 'loa_entries' : r.table}:${r.id}`, score: r.rank }));
  const semanticRanked = topSemantic.map(r => ({ id: `${r.source_table}:${r.source_id}`, score: r.similarity }));

  const fusedScores = reciprocalRankFusion([ftsRanked, semanticRanked]);
  const sortedResults = Array.from(fusedScores.entries()).sort((a, b) => b[1] - a[1]).slice(0, limit);

  console.log(`Top ${sortedResults.length} hybrid results:\n`);
  console.log('Score   | Source      | Preview');
  console.log('--------|-------------|' + '-'.repeat(60));

  for (const [key, score] of sortedResults) {
    const [table, idStr] = key.split(':');
    const id = parseInt(idStr, 10);
    const inFts = ftsRanked.some(r => r.id === key);
    const inSemantic = semanticRanked.some(r => r.id === key);
    const sourceIndicator = inFts && inSemantic ? 'FTS+VEC' : inFts ? 'FTS   ' : 'VEC   ';

    let preview = '';
    let meta = '';

    if (table === 'loa_entries') {
      const loa = await db.queryOne<{ title: string }>('SELECT title FROM loa_entries WHERE id = ?', [id]);
      if (loa) { preview = String(loa.title); meta = `LoA #${id}`; }
    } else if (table === 'decisions') {
      const dec = await db.queryOne<{ decision: string }>('SELECT decision FROM decisions WHERE id = ?', [id]);
      if (dec) { preview = String(dec.decision).slice(0, 50); meta = `Decision #${id}`; }
    } else if (table === 'messages') {
      const msg = await db.queryOne<{ content: string }>('SELECT content FROM messages WHERE id = ?', [id]);
      if (msg) { preview = String(msg.content).slice(0, 50).replace(/\n/g, ' '); meta = `Message #${id}`; }
    } else if (table === 'learnings') {
      const learn = await db.queryOne<{ problem: string }>('SELECT problem FROM learnings WHERE id = ?', [id]);
      if (learn) { preview = String(learn.problem).slice(0, 50); meta = `Learning #${id}`; }
    } else if (table === 'breadcrumbs') {
      const bc = await db.queryOne<{ content: string }>('SELECT content FROM breadcrumbs WHERE id = ?', [id]);
      if (bc) { preview = String(bc.content).slice(0, 50); meta = `Breadcrumb #${id}`; }
    }

    const scoreStr = (score * 100).toFixed(2).padStart(6);
    console.log(`${scoreStr}% | ${sourceIndicator} | [${meta}] ${preview}...`);
  }

  const bothCount = sortedResults.filter(([key]) => ftsRanked.some(r => r.id === key) && semanticRanked.some(r => r.id === key)).length;
  console.log(`\n--- Fusion Summary ---`);
  console.log(`Results in both FTS + Vector: ${bothCount}`);
  console.log(`FTS-only: ${sortedResults.filter(([key]) => ftsRanked.some(r => r.id === key) && !semanticRanked.some(r => r.id === key)).length}`);
  console.log(`Vector-only: ${sortedResults.filter(([key]) => !ftsRanked.some(r => r.id === key) && semanticRanked.some(r => r.id === key)).length}`);
}
