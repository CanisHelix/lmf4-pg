/**
 * fts.ts — backend-aware full-text search helpers.
 *
 * Callers use buildFtsQuery() to get a WHERE clause + params tuple
 * appropriate for the active backend. This keeps all FTS syntax
 * differences in one place.
 *
 * SQLite:  WHERE <fts_table> MATCH ?
 * Postgres: WHERE fts @@ plainto_tsquery('english', ?)
 */

import type { Backend } from './index.js';

export interface FtsClause {
  /** The WHERE clause fragment (no leading "WHERE") */
  where: string;
  /** Bound parameters for this clause */
  params: string[];
}

/**
 * Returns a backend-appropriate FTS WHERE clause.
 *
 * @param term       - Search term from the user
 * @param ftsTable   - SQLite FTS virtual table name (e.g. 'messages_fts')
 * @param baseTable  - Underlying table name (e.g. 'messages')
 * @param backend    - Active backend
 *
 * @example
 * const { where, params } = buildFtsClause('my term', 'messages_fts', 'messages', 'sqlite');
 * const rows = await db.query(
 *   `SELECT m.* FROM messages m
 *    JOIN messages_fts fts ON fts.rowid = m.id
 *    WHERE ${where}`,
 *   params
 * );
 */
export function buildFtsClause(
  term: string,
  ftsTable: string,
  baseTable: string,
  backend: Backend
): FtsClause {
  if (backend === 'sqlite') {
    return {
      where: `${ftsTable} MATCH ?`,
      params: [term],
    };
  }

  // PostgreSQL: fts column lives directly on the base table
  return {
    where: `${baseTable}.fts @@ plainto_tsquery('english', ?)`,
    params: [term],
  };
}

/**
 * Returns a full ranked FTS SELECT for a given table.
 *
 * SQLite:   uses FTS5 bm25() for ranking
 * Postgres: uses ts_rank() for ranking
 */
export function buildFtsSelect(
  term: string,
  ftsTable: string,
  baseTable: string,
  selectCols: string,
  backend: Backend
): { sql: string; params: string[] } {
  if (backend === 'sqlite') {
    return {
      sql: `
        SELECT ${selectCols}, bm25(${ftsTable}) AS rank
        FROM ${baseTable}
        JOIN ${ftsTable} ON ${ftsTable}.rowid = ${baseTable}.id
        WHERE ${ftsTable} MATCH ?
        ORDER BY rank
      `,
      params: [term],
    };
  }

  return {
    sql: `
      SELECT ${selectCols},
             ts_rank(fts, plainto_tsquery('english', ?)) AS rank
      FROM ${baseTable}
      WHERE fts @@ plainto_tsquery('english', ?)
      ORDER BY rank DESC
    `,
    params: [term, term],
  };
}
