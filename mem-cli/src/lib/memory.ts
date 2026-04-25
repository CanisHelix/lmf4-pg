// Core memory operations for LMF

import { getDb } from '../db/index.js';
import { existsSync, statSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import type { Session, Message, Decision, Learning, Breadcrumb, LoaEntry, Stats, SearchResult } from '../types/index.js';

// ============ Sessions ============

export async function createSession(session: Omit<Session, 'id'>): Promise<number> {
  const db = await getDb();
  const row = await db.queryOne<{ id: number }>(`
    INSERT INTO sessions (session_id, started_at, ended_at, summary, project, cwd, git_branch, model)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    RETURNING id
  `, [
    session.session_id,
    session.started_at,
    session.ended_at || null,
    session.summary || null,
    session.project || null,
    session.cwd || null,
    session.git_branch || null,
    session.model || null,
  ]);
  return row!.id as number;
}

export async function getSession(sessionId: string): Promise<Session | undefined> {
  const db = await getDb();
  return (await db.queryOne<Session>('SELECT * FROM sessions WHERE session_id = ?', [sessionId])) ?? undefined;
}

export async function sessionExists(sessionId: string): Promise<boolean> {
  const db = await getDb();
  const row = await db.queryOne('SELECT 1 FROM sessions WHERE session_id = ?', [sessionId]);
  return !!row;
}

export async function endSession(sessionId: string, summary?: string): Promise<void> {
  const db = await getDb();
  await db.run(
    'UPDATE sessions SET ended_at = CURRENT_TIMESTAMP, summary = COALESCE(?, summary) WHERE session_id = ?',
    [summary || null, sessionId]
  );
}

// ============ Messages ============

export async function addMessage(message: Omit<Message, 'id'>): Promise<number> {
  const db = await getDb();
  const row = await db.queryOne<{ id: number }>(`
    INSERT INTO messages (session_id, timestamp, role, content, project)
    VALUES (?, ?, ?, ?, ?)
    RETURNING id
  `, [
    message.session_id,
    message.timestamp,
    message.role,
    message.content,
    message.project || null,
  ]);
  return row!.id as number;
}

export async function addMessagesBatch(messages: Omit<Message, 'id'>[]): Promise<number> {
  const db = await getDb();
  let count = 0;
  for (const msg of messages) {
    await db.run(`
      INSERT INTO messages (session_id, timestamp, role, content, project)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT DO NOTHING
    `, [msg.session_id, msg.timestamp, msg.role, msg.content, msg.project || null]);
    count++;
  }
  return count;
}

// ============ Decisions ============

export async function addDecision(decision: Omit<Decision, 'id' | 'created_at'>): Promise<number> {
  const db = await getDb();
  const row = await db.queryOne<{ id: number }>(`
    INSERT INTO decisions (session_id, category, project, decision, reasoning, alternatives, status)
    VALUES (?, ?, ?, ?, ?, ?, ?)
    RETURNING id
  `, [
    decision.session_id || null,
    decision.category || null,
    decision.project || null,
    decision.decision,
    decision.reasoning || null,
    decision.alternatives || null,
    decision.status || 'active',
  ]);
  return row!.id as number;
}

export async function getDecision(id: number): Promise<Decision | undefined> {
  const db = await getDb();
  return (await db.queryOne<Decision>('SELECT * FROM decisions WHERE id = ?', [id])) ?? undefined;
}

// ============ Learnings ============

export async function addLearning(learning: Omit<Learning, 'id' | 'created_at'>): Promise<number> {
  const db = await getDb();
  const row = await db.queryOne<{ id: number }>(`
    INSERT INTO learnings (session_id, category, project, problem, solution, prevention, tags)
    VALUES (?, ?, ?, ?, ?, ?, ?)
    RETURNING id
  `, [
    learning.session_id || null,
    learning.category || null,
    learning.project || null,
    learning.problem,
    learning.solution || null,
    learning.prevention || null,
    learning.tags || null,
  ]);
  return row!.id as number;
}

export async function getLearning(id: number): Promise<Learning | undefined> {
  const db = await getDb();
  return (await db.queryOne<Learning>('SELECT * FROM learnings WHERE id = ?', [id])) ?? undefined;
}

// ============ Breadcrumbs ============

export async function addBreadcrumb(breadcrumb: Omit<Breadcrumb, 'id' | 'created_at'>): Promise<number> {
  const db = await getDb();
  const row = await db.queryOne<{ id: number }>(`
    INSERT INTO breadcrumbs (session_id, content, category, project, importance, expires_at)
    VALUES (?, ?, ?, ?, ?, ?)
    RETURNING id
  `, [
    breadcrumb.session_id || null,
    breadcrumb.content,
    breadcrumb.category || null,
    breadcrumb.project || null,
    breadcrumb.importance ?? 5,
    breadcrumb.expires_at || null,
  ]);
  return row!.id as number;
}

export async function getBreadcrumb(id: number): Promise<Breadcrumb | undefined> {
  const db = await getDb();
  return (await db.queryOne<Breadcrumb>('SELECT * FROM breadcrumbs WHERE id = ?', [id])) ?? undefined;
}

// ============ Search ============

let lastSearchErrors: string[] = [];

export function getLastSearchErrors(): string[] {
  return lastSearchErrors;
}

export async function search(query: string, options?: { project?: string; table?: string; limit?: number }): Promise<SearchResult[]> {
  const db = await getDb();
  const limit = options?.limit || 20;
  const results: SearchResult[] = [];
  lastSearchErrors = [];

  const tables = options?.table
    ? [options.table]
    : ['messages', 'loa', 'decisions', 'learnings', 'breadcrumbs'];

  for (const table of tables) {
    let sql: string;
    const params: unknown[] = [];

    if (db.backend === 'sqlite') {
      switch (table) {
        case 'messages':
          sql = `SELECT m.id, m.content, m.project, m.timestamp as created_at, f.rank
                 FROM messages_fts f JOIN messages m ON m.id = f.rowid
                 WHERE messages_fts MATCH ?${options?.project ? ' AND m.project = ?' : ''}
                 ORDER BY f.rank LIMIT ?`;
          break;
        case 'decisions':
          sql = `SELECT d.id, d.decision as content, d.project, d.created_at, f.rank
                 FROM decisions_fts f JOIN decisions d ON d.id = f.rowid
                 WHERE decisions_fts MATCH ?${options?.project ? ' AND d.project = ?' : ''}
                 ORDER BY f.rank LIMIT ?`;
          break;
        case 'learnings':
          sql = `SELECT l.id, l.problem as content, l.project, l.created_at, f.rank
                 FROM learnings_fts f JOIN learnings l ON l.id = f.rowid
                 WHERE learnings_fts MATCH ?${options?.project ? ' AND l.project = ?' : ''}
                 ORDER BY f.rank LIMIT ?`;
          break;
        case 'breadcrumbs':
          sql = `SELECT b.id, b.content, b.project, b.created_at, f.rank
                 FROM breadcrumbs_fts f JOIN breadcrumbs b ON b.id = f.rowid
                 WHERE breadcrumbs_fts MATCH ?${options?.project ? ' AND b.project = ?' : ''}
                 ORDER BY f.rank LIMIT ?`;
          break;
        case 'loa':
          sql = `SELECT l.id, l.title || ': ' || SUBSTR(l.fabric_extract, 1, 200) as content, l.project, l.created_at, f.rank
                 FROM loa_fts f JOIN loa_entries l ON l.id = f.rowid
                 WHERE loa_fts MATCH ?${options?.project ? ' AND l.project = ?' : ''}
                 ORDER BY f.rank LIMIT ?`;
          break;
        default:
          continue;
      }
      params.push(query);
      if (options?.project) params.push(options.project);
      params.push(limit);
    } else {
      // PostgreSQL: tsvector columns on base tables
      switch (table) {
        case 'messages':
          sql = `SELECT id, content, project, timestamp as created_at,
                        ts_rank(fts, plainto_tsquery('english', ?)) AS rank
                 FROM messages
                 WHERE fts @@ plainto_tsquery('english', ?)${options?.project ? ' AND project = ?' : ''}
                 ORDER BY rank DESC LIMIT ?`;
          break;
        case 'decisions':
          sql = `SELECT id, decision as content, project, created_at,
                        ts_rank(fts, plainto_tsquery('english', ?)) AS rank
                 FROM decisions
                 WHERE fts @@ plainto_tsquery('english', ?)${options?.project ? ' AND project = ?' : ''}
                 ORDER BY rank DESC LIMIT ?`;
          break;
        case 'learnings':
          sql = `SELECT id, problem as content, project, created_at,
                        ts_rank(fts, plainto_tsquery('english', ?)) AS rank
                 FROM learnings
                 WHERE fts @@ plainto_tsquery('english', ?)${options?.project ? ' AND project = ?' : ''}
                 ORDER BY rank DESC LIMIT ?`;
          break;
        case 'breadcrumbs':
          sql = `SELECT id, content, project, created_at,
                        ts_rank(fts, plainto_tsquery('english', ?)) AS rank
                 FROM breadcrumbs
                 WHERE fts @@ plainto_tsquery('english', ?)${options?.project ? ' AND project = ?' : ''}
                 ORDER BY rank DESC LIMIT ?`;
          break;
        case 'loa':
          sql = `SELECT id, title || ': ' || SUBSTR(fabric_extract, 1, 200) as content, project, created_at,
                        ts_rank(fts, plainto_tsquery('english', ?)) AS rank
                 FROM loa_entries
                 WHERE fts @@ plainto_tsquery('english', ?)${options?.project ? ' AND project = ?' : ''}
                 ORDER BY rank DESC LIMIT ?`;
          break;
        default:
          continue;
      }
      params.push(query, query);
      if (options?.project) params.push(options.project);
      params.push(limit);
    }

    try {
      const rows = await db.query<{
        id: number;
        content: string;
        project: string | null;
        created_at: string;
        rank: number;
      }>(sql, params);

      for (const row of rows) {
        results.push({
          table,
          id: row.id,
          content: row.content,
          project: row.project || undefined,
          created_at: row.created_at,
          rank: row.rank,
        });
      }
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      lastSearchErrors.push(`[${table}] ${errorMsg}`);
    }
  }

  results.sort((a, b) => (a.rank || 0) - (b.rank || 0));
  return results.slice(0, limit);
}

// ============ Recent ============

export async function recentMessages(limit: number = 10, project?: string): Promise<Message[]> {
  const db = await getDb();
  const sql = project
    ? 'SELECT * FROM messages WHERE project = ? ORDER BY timestamp DESC LIMIT ?'
    : 'SELECT * FROM messages ORDER BY timestamp DESC LIMIT ?';
  return db.query<Message>(sql, project ? [project, limit] : [limit]);
}

export async function recentDecisions(limit: number = 10, project?: string): Promise<Decision[]> {
  const db = await getDb();
  const sql = project
    ? 'SELECT * FROM decisions WHERE project = ? ORDER BY created_at DESC LIMIT ?'
    : 'SELECT * FROM decisions ORDER BY created_at DESC LIMIT ?';
  return db.query<Decision>(sql, project ? [project, limit] : [limit]);
}

export async function recentLearnings(limit: number = 10, project?: string): Promise<Learning[]> {
  const db = await getDb();
  const sql = project
    ? 'SELECT * FROM learnings WHERE project = ? ORDER BY created_at DESC LIMIT ?'
    : 'SELECT * FROM learnings ORDER BY created_at DESC LIMIT ?';
  return db.query<Learning>(sql, project ? [project, limit] : [limit]);
}

export async function recentBreadcrumbs(limit: number = 10, project?: string): Promise<Breadcrumb[]> {
  const db = await getDb();
  const sql = project
    ? 'SELECT * FROM breadcrumbs WHERE project = ? ORDER BY created_at DESC LIMIT ?'
    : 'SELECT * FROM breadcrumbs ORDER BY created_at DESC LIMIT ?';
  return db.query<Breadcrumb>(sql, project ? [project, limit] : [limit]);
}

// ============ Library of Alexandria ============

export async function createLoaEntry(entry: Omit<LoaEntry, 'id' | 'created_at'>): Promise<number> {
  const db = await getDb();
  const row = await db.queryOne<{ id: number }>(`
    INSERT INTO loa_entries (title, description, fabric_extract, message_range_start, message_range_end, parent_loa_id, session_id, project, tags, message_count)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    RETURNING id
  `, [
    entry.title,
    entry.description || null,
    entry.fabric_extract,
    entry.message_range_start || null,
    entry.message_range_end || null,
    entry.parent_loa_id || null,
    entry.session_id || null,
    entry.project || null,
    entry.tags || null,
    entry.message_count || null,
  ]);
  return row!.id as number;
}

export async function getLoaEntry(id: number): Promise<LoaEntry | undefined> {
  const db = await getDb();
  return (await db.queryOne<LoaEntry>('SELECT * FROM loa_entries WHERE id = ?', [id])) ?? undefined;
}

export async function getLastLoaEntry(): Promise<LoaEntry | undefined> {
  const db = await getDb();
  return (await db.queryOne<LoaEntry>('SELECT * FROM loa_entries ORDER BY created_at DESC LIMIT 1')) ?? undefined;
}

export async function getLoaMessages(loaId: number): Promise<Message[]> {
  const loa = await getLoaEntry(loaId);
  if (!loa || !loa.message_range_start || !loa.message_range_end) {
    return [];
  }
  const db = await getDb();
  return db.query<Message>(
    'SELECT * FROM messages WHERE id >= ? AND id <= ? ORDER BY timestamp',
    [loa.message_range_start, loa.message_range_end]
  );
}

export async function getMessagesSinceLastLoa(limit?: number): Promise<{ messages: Message[]; startId: number | null; endId: number | null }> {
  const lastLoa = await getLastLoaEntry();
  const db = await getDb();

  let messages: Message[];

  if (lastLoa?.message_range_end) {
    const sql = limit
      ? 'SELECT * FROM messages WHERE id > ? ORDER BY timestamp LIMIT ?'
      : 'SELECT * FROM messages WHERE id > ? ORDER BY timestamp';
    messages = await db.query<Message>(sql, limit ? [lastLoa.message_range_end, limit] : [lastLoa.message_range_end]);
  } else {
    const sql = limit
      ? 'SELECT * FROM messages ORDER BY timestamp LIMIT ?'
      : 'SELECT * FROM messages ORDER BY timestamp';
    messages = await db.query<Message>(sql, limit ? [limit] : []);
  }

  return {
    messages,
    startId: messages.length > 0 ? messages[0].id! : null,
    endId: messages.length > 0 ? messages[messages.length - 1].id! : null,
  };
}

export async function recentLoaEntries(limit: number = 10, project?: string): Promise<LoaEntry[]> {
  const db = await getDb();
  const sql = project
    ? 'SELECT * FROM loa_entries WHERE project = ? ORDER BY created_at DESC LIMIT ?'
    : 'SELECT * FROM loa_entries ORDER BY created_at DESC LIMIT ?';
  return db.query<LoaEntry>(sql, project ? [project, limit] : [limit]);
}

// ============ Stats ============

export async function getStats(): Promise<Stats> {
  const db = await getDb();

  const count = async (table: string) =>
    Number((await db.queryOne<{ count: unknown }>(`SELECT COUNT(*) as count FROM ${table}`))?.count ?? 0);

  const [sessions, messages, decisions, learnings, breadcrumbs, loa_entries, telos, documents] =
    await Promise.all([
      count('sessions'), count('messages'), count('decisions'), count('learnings'),
      count('breadcrumbs'), count('loa_entries'), count('telos'), count('documents'),
    ]);

  let db_size_bytes = 0;
  if (db.backend === 'sqlite') {
    const p = process.env.MEM_DB_PATH ?? join(homedir(), '.claude', 'memory.db');
    if (existsSync(p)) db_size_bytes = statSync(p).size;
  } else {
    const row = await db.queryOne<{ size: string }>(
      `SELECT pg_database_size(current_database()) AS size`
    );
    db_size_bytes = row ? parseInt(row.size, 10) : 0;
  }

  return { sessions, messages, decisions, learnings, breadcrumbs, loa_entries, telos, documents, db_size_bytes };
}
