// mem loa command - Library of Alexandria capture

import { execSync } from 'child_process';
import {
  createLoaEntry, getMessagesSinceLastLoa, getLastLoaEntry,
  getLoaEntry, getLoaMessages, recentLoaEntries,
} from '../lib/memory.js';
import { detectProject } from '../lib/project.js';
import { embed, embeddingToBlob, checkEmbeddingService } from '../lib/embeddings.js';
import { getDb } from '../db/index.js';

interface LoaOptions {
  continues?: number;
  project?: string;
  tags?: string;
  limit?: number;
}

const MAX_FABRIC_INPUT_BYTES = 50 * 1024 * 1024;
const EXTRACT_MODEL = process.env.LMF4_EXTRACT_MODEL || 'claude-haiku-4-5';

async function autoEmbedLoaEntry(id: number, title: string, fabricExtract: string): Promise<void> {
  try {
    const serviceStatus = await checkEmbeddingService();
    if (!serviceStatus.available) {
      console.log(`  ⚠ Embedding skipped (service unavailable)`);
      return;
    }

    const content = `${title}\n\n${fabricExtract}`;
    const result = await embed(content);
    const db = await getDb();

    const payload = db.backend === 'sqlite'
      ? embeddingToBlob(result.embedding)
      : JSON.stringify(result.embedding);

    await db.run(`
      INSERT INTO embeddings (source_table, source_id, model, dimensions, embedding)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT (source_table, source_id) DO UPDATE SET
        embedding = EXCLUDED.embedding, model = EXCLUDED.model, dimensions = EXCLUDED.dimensions
    `, ['loa_entries', id, result.model, result.dimensions, payload]);

    console.log(`  ✓ Auto-embedded for semantic search (${result.dimensions}d)`);
  } catch (err) {
    console.log(`  ⚠ Embedding failed: ${err instanceof Error ? err.message : err}`);
  }
}

function runFabricExtract(content: string): string {
  const inputBytes = Buffer.byteLength(content, 'utf-8');
  if (inputBytes > MAX_FABRIC_INPUT_BYTES) {
    throw new Error(`Input too large (${(inputBytes / 1024 / 1024).toFixed(1)}MB > 50MB limit). Use --limit to reduce message count.`);
  }

  const env = { ...process.env };
  delete env.ANTHROPIC_API_KEY;
  delete env.CLAUDECODE;

  try {
    const result = execSync(
      `claude --print --model ${EXTRACT_MODEL} --output-format text`,
      { input: content, encoding: 'utf-8', maxBuffer: MAX_FABRIC_INPUT_BYTES, timeout: 600000, env }
    );
    return result.trim();
  } catch (err) {
    throw new Error(`Extraction via \`claude --print\` failed: ${err instanceof Error ? err.message : err}`);
  }
}

function formatMessagesForFabric(messages: Array<{ role: string; content: string; timestamp: string }>): string {
  return messages.map(m => {
    const time = m.timestamp.split('T')[1]?.slice(0, 5) || '';
    return `[${m.role.toUpperCase()} ${time}]\n${m.content}`;
  }).join('\n\n---\n\n');
}

export async function runLoa(title: string, options: LoaOptions): Promise<void> {
  const project = options.project || detectProject();
  const { messages, startId, endId } = await getMessagesSinceLastLoa(options.limit);

  if (messages.length === 0) {
    console.log('No new messages since last LoA entry.');
    const lastLoa = await getLastLoaEntry();
    if (lastLoa) console.log(`\nLast LoA: #${lastLoa.id} "${lastLoa.title}" (${lastLoa.created_at})`);
    return;
  }

  console.log(`Extracting ${messages.length} messages via \`claude --print --model ${EXTRACT_MODEL}\`...`);

  let fabricExtract: string;
  try {
    fabricExtract = runFabricExtract(formatMessagesForFabric(messages));
  } catch (err) {
    console.error(`\nError: ${err instanceof Error ? err.message : err}`);
    console.error('\nExtraction is MANDATORY for LoA entries. Check that `claude --print` works in your shell.');
    process.exit(1);
  }

  const id = await createLoaEntry({
    title,
    description: `Captured ${messages.length} messages`,
    fabric_extract: fabricExtract,
    message_range_start: startId || undefined,
    message_range_end: endId || undefined,
    parent_loa_id: options.continues,
    project,
    tags: options.tags,
    message_count: messages.length,
  });

  console.log(`\n✓ LoA #${id} captured: "${title}"`);
  console.log(`  Messages: ${messages.length} (IDs ${startId}-${endId})`);
  console.log(`  Project: ${project || 'N/A'}`);

  await autoEmbedLoaEntry(id, title, fabricExtract);

  if (options.continues) {
    const parent = await getLoaEntry(options.continues);
    if (parent) console.log(`  Continues: LoA #${options.continues} "${parent.title}"`);
  }

  console.log(`\n--- Extract Preview ---`);
  console.log(fabricExtract.slice(0, 500) + (fabricExtract.length > 500 ? '...' : ''));
}

export async function runLoaQuote(loaId: number): Promise<void> {
  const loa = await getLoaEntry(loaId);
  if (!loa) { console.error(`LoA #${loaId} not found`); process.exit(1); }

  const messages = await getLoaMessages(loaId);
  console.log(`LoA #${loaId}: "${loa.title}"`);
  console.log(`Created: ${loa.created_at}`);
  console.log(`Messages: ${messages.length} (IDs ${loa.message_range_start}-${loa.message_range_end})`);
  console.log(`\n${'='.repeat(60)}\n`);

  for (const m of messages) {
    const time = m.timestamp.split('T')[1]?.slice(0, 8) || '';
    console.log(`[${m.role.toUpperCase()} ${time}]`);
    console.log(m.content);
    console.log('\n---\n');
  }
}

export async function runLoaShow(loaId: number): Promise<void> {
  const loa = await getLoaEntry(loaId);
  if (!loa) { console.error(`LoA #${loaId} not found`); process.exit(1); }

  console.log('Library of Alexandria Entry\n===========================\n');
  console.log(`ID:         ${loa.id}`);
  console.log(`Title:      ${loa.title}`);
  console.log(`Created:    ${loa.created_at}`);
  console.log(`Project:    ${loa.project || 'N/A'}`);
  console.log(`Messages:   ${loa.message_count || 0} (IDs ${loa.message_range_start}-${loa.message_range_end})`);

  if (loa.parent_loa_id) {
    const parent = await getLoaEntry(loa.parent_loa_id);
    console.log(`Continues:  LoA #${loa.parent_loa_id}${parent ? ` "${parent.title}"` : ''}`);
  }
  if (loa.tags) console.log(`Tags:       ${loa.tags}`);
  console.log(`\n--- Extract ---\n`);
  console.log(loa.fabric_extract);
}

export async function runLoaList(limit: number = 10): Promise<void> {
  const entries = await recentLoaEntries(limit);

  if (entries.length === 0) {
    console.log('No LoA entries yet. Use "mem loa <title>" to create one.');
    return;
  }

  console.log(`Recent ${entries.length} LoA entries:\n`);
  for (const e of entries) {
    const date = e.created_at?.split('T')[0] || 'unknown';
    const projectTag = e.project ? ` [${e.project}]` : '';
    const parentTag = e.parent_loa_id ? ` → #${e.parent_loa_id}` : '';
    console.log(`#${e.id}${projectTag} ${date}${parentTag}`);
    console.log(`  ${e.title}`);
    console.log(`  ${e.message_count || 0} messages`);
    console.log('');
  }
}
