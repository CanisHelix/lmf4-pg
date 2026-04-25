// mem dump command - Flush current session to DB + capture LoA

import { readdirSync, readFileSync, existsSync, statSync } from 'fs';
import { join, basename, dirname } from 'path';
import { homedir } from 'os';
import { execSync } from 'child_process';
import { getDb } from '../db/index.js';
import { createSession, sessionExists, addMessagesBatch, createLoaEntry, getLastLoaEntry } from '../lib/memory.js';
import { extractProjectFromPath } from '../lib/project.js';
import { embed, embeddingToBlob, checkEmbeddingService } from '../lib/embeddings.js';
import type { DbAdapter } from '../db/adapter.js';
import type { Message } from '../types/index.js';

async function autoEmbedLoaEntry(id: number, title: string, fabricExtract: string): Promise<void> {
  try {
    const serviceStatus = await checkEmbeddingService();
    if (!serviceStatus.available) { console.log(`  ⚠ Embedding skipped (service unavailable)`); return; }

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

const CLAUDE_PROJECTS_DIR = join(homedir(), '.claude', 'projects');

interface DumpOptions {
  project?: string;
  continues?: number;
  tags?: string;
  limit?: number;
  skipFabric?: boolean;
}

function findCurrentSessionFile(): string | null {
  if (!existsSync(CLAUDE_PROJECTS_DIR)) return null;
  let mostRecentFile: string | null = null;
  let mostRecentTime = 0;
  for (const projectDir of readdirSync(CLAUDE_PROJECTS_DIR, { withFileTypes: true }).filter(d => d.isDirectory()).map(d => d.name)) {
    const projectPath = join(CLAUDE_PROJECTS_DIR, projectDir);
    for (const f of readdirSync(projectPath, { withFileTypes: true }).filter(f => f.isFile() && f.name.endsWith('.jsonl'))) {
      const file = join(projectPath, f.name);
      const stat = statSync(file);
      if (stat.mtimeMs > mostRecentTime) { mostRecentTime = stat.mtimeMs; mostRecentFile = file; }
    }
  }
  return mostRecentFile;
}

function parseSessionFile(filePath: string): { sessionId: string; project: string; messages: Omit<Message, 'id'>[] } | null {
  const content = readFileSync(filePath, 'utf-8');
  const lines = content.split('\n').filter(l => l.trim());
  if (lines.length === 0) return null;

  const messages: Omit<Message, 'id'>[] = [];
  let sessionId: string | null = null;
  let project: string | null = null;

  for (const line of lines) {
    try {
      const parsed = JSON.parse(line);
      if (parsed.type !== 'user' && parsed.type !== 'assistant') continue;
      if (!sessionId && parsed.sessionId) sessionId = parsed.sessionId;
      if (parsed.message?.content) {
        let msgContent: string;
        if (typeof parsed.message.content === 'string') {
          msgContent = parsed.message.content;
        } else if (Array.isArray(parsed.message.content)) {
          msgContent = parsed.message.content
            .filter((b: { type: string; text?: string }) => b.type === 'text' && b.text)
            .map((b: { text: string }) => b.text).join('\n');
        } else continue;
        if (msgContent.trim()) {
          messages.push({
            session_id: parsed.sessionId || sessionId || 'unknown',
            timestamp: parsed.timestamp || new Date().toISOString(),
            role: parsed.type as 'user' | 'assistant',
            content: msgContent, project: undefined,
          });
        }
      }
    } catch { continue; }
  }

  project = extractProjectFromPath(basename(dirname(filePath)));
  for (const msg of messages) msg.project = project;
  if (!sessionId) sessionId = basename(filePath, '.jsonl');
  return { sessionId, project, messages };
}

async function deleteLoaEntriesRecursive(db: DbAdapter, loaIds: number[]): Promise<void> {
  if (loaIds.length === 0) return;
  const placeholders = loaIds.map(() => '?').join(',');
  const children = await db.query<{ id: number }>(
    `SELECT id FROM loa_entries WHERE parent_loa_id IN (${placeholders})`, loaIds
  );
  if (children.length > 0) await deleteLoaEntriesRecursive(db, children.map(c => c.id as number));
  await db.run(`DELETE FROM loa_entries WHERE id IN (${placeholders})`, loaIds);
}

async function deleteSession(sessionId: string): Promise<number> {
  const db = await getDb();
  await db.run('BEGIN');
  try {
    const countRow = await db.queryOne<{ count: number }>('SELECT COUNT(*) as count FROM messages WHERE session_id = ?', [sessionId]);
    const count = countRow?.count || 0;

    const rangeRow = await db.queryOne<{ minId: number | null; maxId: number | null }>(
      'SELECT MIN(id) as minId, MAX(id) as maxId FROM messages WHERE session_id = ?', [sessionId]
    );

    if (rangeRow?.minId !== null && rangeRow?.maxId !== null) {
      const affectedLoa = await db.query<{ id: number }>(
        `SELECT id FROM loa_entries WHERE message_range_start >= ? AND message_range_end <= ?`,
        [rangeRow.minId, rangeRow.maxId]
      );
      if (affectedLoa.length > 0) await deleteLoaEntriesRecursive(db, affectedLoa.map(e => e.id as number));
    }

    await db.run('DELETE FROM messages WHERE session_id = ?', [sessionId]);
    await db.run('DELETE FROM sessions WHERE session_id = ?', [sessionId]);
    await db.run('COMMIT');
    return count as number;
  } catch (err) {
    await db.run('ROLLBACK');
    throw err;
  }
}

const MAX_EXTRACT_INPUT_BYTES = 50 * 1024 * 1024;
const EXTRACT_MODEL = process.env.LMF4_EXTRACT_MODEL || 'claude-haiku-4-5';

function runExtract(content: string): string {
  const inputBytes = Buffer.byteLength(content, 'utf-8');
  if (inputBytes > MAX_EXTRACT_INPUT_BYTES) {
    throw new Error(`Input too large (${(inputBytes / 1024 / 1024).toFixed(1)}MB > 50MB limit). Use --limit to reduce message count.`);
  }
  const env = { ...process.env };
  delete env.ANTHROPIC_API_KEY;
  delete env.CLAUDECODE;
  try {
    return execSync(`claude --print --model ${EXTRACT_MODEL} --output-format text`, {
      input: content, encoding: 'utf-8', maxBuffer: MAX_EXTRACT_INPUT_BYTES, timeout: 600000, env,
    }).trim();
  } catch (err) {
    throw new Error(`Extraction via \`claude --print\` failed: ${err instanceof Error ? err.message : err}`);
  }
}

export async function runDump(title: string, options: DumpOptions): Promise<void> {
  console.log('Memory Dump\n===========\n');

  const sessionFile = findCurrentSessionFile();
  if (!sessionFile) { console.error('Error: No session files found'); process.exit(1); }

  console.log(`Current session: ${basename(sessionFile)}`);
  console.log(`File size: ${(statSync(sessionFile).size / 1024).toFixed(1)} KB\n`);

  const parsed = parseSessionFile(sessionFile);
  if (!parsed || parsed.messages.length === 0) { console.error('Error: No messages found in session file'); process.exit(1); }

  console.log(`Messages found: ${parsed.messages.length}`);
  console.log(`Project: ${parsed.project}`);

  if (await sessionExists(parsed.sessionId)) {
    console.log(`\nRe-importing session (replacing ${parsed.sessionId})...`);
    const deletedCount = await deleteSession(parsed.sessionId);
    console.log(`Deleted ${deletedCount} existing messages`);
  }

  const timestamps = parsed.messages.map(m => m.timestamp).sort();
  await createSession({
    session_id: parsed.sessionId, started_at: timestamps[0], ended_at: timestamps[timestamps.length - 1],
    project: parsed.project, summary: `Dumped: ${title}`,
  });

  const importedCount = await addMessagesBatch(parsed.messages);
  console.log(`\n✓ Imported ${importedCount} messages`);

  if (options.skipFabric) { console.log('\nSkipping extraction (--skip-fabric)'); return; }

  const db = await getDb();
  await getLastLoaEntry(); // ensure DB open (no-op if already open)

  let sqlQuery = `SELECT id, content, role, timestamp FROM messages WHERE session_id = ? ORDER BY timestamp`;
  const sqlParams: unknown[] = [parsed.sessionId];
  if (options.limit) { sqlQuery += ' LIMIT ?'; sqlParams.push(options.limit); }

  const importedMessages = await db.query<{ id: number; content: string; role: string; timestamp: string }>(sqlQuery, sqlParams);

  if (importedMessages.length === 0) { console.log('\nNo messages to capture for LoA'); return; }

  const firstMsg = importedMessages[0];
  const lastMsg = importedMessages[importedMessages.length - 1];

  if (!firstMsg.id || !lastMsg.id) { console.error('\nError: Messages missing IDs after import'); process.exit(1); }

  const startId = firstMsg.id as number;
  const endId = lastMsg.id as number;
  const messageCount = importedMessages.length;

  const conversationText = importedMessages.map(m => {
    const time = m.timestamp.split('T')[1]?.split('.')[0] || '';
    return `[${m.role.toUpperCase()} ${time}]\n${m.content}`;
  }).join('\n\n---\n\n');

  console.log(`\nExtracting ${messageCount} messages via \`claude --print --model ${EXTRACT_MODEL}\`...`);

  let fabricExtract: string;
  try {
    fabricExtract = runExtract(conversationText);
  } catch (err) {
    console.error(`\nExtraction failed: ${err instanceof Error ? err.message : err}`);
    console.log('Messages were imported but LoA entry was not created.');
    return;
  }

  const loaId = await createLoaEntry({
    title, fabric_extract: fabricExtract,
    message_range_start: startId, message_range_end: endId,
    parent_loa_id: options.continues, project: options.project || parsed.project,
    tags: options.tags, message_count: messageCount,
  });

  console.log(`\n✓ LoA #${loaId} captured: "${title}"`);
  console.log(`  Messages: ${messageCount} (IDs ${startId}-${endId})`);
  console.log(`  Project: ${options.project || parsed.project}`);

  await autoEmbedLoaEntry(loaId, title, fabricExtract);

  console.log('\n--- Extract Preview ---\n');
  console.log(fabricExtract.slice(0, 500) + (fabricExtract.length > 500 ? '...' : ''));
}
