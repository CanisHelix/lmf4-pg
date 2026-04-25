#!/usr/bin/env bun
/**
 * mem-mcp-server.ts — MCP server for PAI memory search
 *
 * Exposes the LMF memory database as MCP tools so Claude can search
 * past sessions, decisions, errors, and learnings without shelling out.
 *
 * Tools:
 *   memory_search  — Full-text search across all memory tables
 *   memory_recall  — Get recent session extractions for context loading
 *
 * Runs as stdio MCP server, wired in settings.json mcpServers.
 */

import { join } from "path";
import { openHookDb, type HookDb } from "../hooks/hook-db.js";

// ─── MCP Protocol Types ───────────────────────────────────────────

interface JsonRpcRequest {
  jsonrpc: "2.0";
  id?: number | string;
  method: string;
  params?: any;
}

interface JsonRpcResponse {
  jsonrpc: "2.0";
  id: number | string | null;
  result?: any;
  error?: { code: number; message: string };
}

// ─── Database Queries ─────────────────────────────────────────────

async function searchMemory(db: HookDb, query: string, limit: number = 15): Promise<any[]> {
  const b = db.backend;
  const results: any[] = [];

  const ftsWhere = (table: string, ftsTable: string) => b === "sqlite"
    ? { where: `${ftsTable} MATCH ?`, join: `JOIN ${ftsTable} ON ${ftsTable}.rowid = ${table}.id`, params: [query] as unknown[] }
    : { where: `${table}.fts @@ plainto_tsquery('english', ?)`, join: "", params: [query] as unknown[] };

  const rankExpr = (table: string) => b === "sqlite"
    ? `rank`
    : `ts_rank(${table}.fts, plainto_tsquery('english', ?))`;
  const rankParam = (): unknown[] => b === "sqlite" ? [] : [query];

  // LoA entries (session extractions)
  try {
    const { where, join, params } = ftsWhere("loa_entries", "loa_fts");
    const rows = await db.query<any>(
      `SELECT l.created_at, l.project, l.title, ${rankExpr("loa_entries")} AS rank
       FROM loa_entries l ${join}
       WHERE ${where}
       ORDER BY rank ${b === "sqlite" ? "ASC" : "DESC"}
       LIMIT ?`, [...rankParam(), ...params, limit]
    );
    for (const r of rows) results.push({ type: "session", date: r.created_at, project: r.project, title: r.title, excerpt: "" });
  } catch {}

  // Decisions
  try {
    const { where, join, params } = ftsWhere("decisions", "decisions_fts");
    const rows = await db.query<any>(
      `SELECT d.created_at, d.project, d.decision, d.reasoning, ${rankExpr("decisions")} AS rank
       FROM decisions d ${join}
       WHERE ${where}
       ORDER BY rank ${b === "sqlite" ? "ASC" : "DESC"}
       LIMIT ?`, [...rankParam(), ...params, Math.min(limit, 10)]
    );
    for (const r of rows) results.push({ type: "decision", date: r.created_at, project: r.project, decision: r.decision, reasoning: r.reasoning });
  } catch {}

  // Errors
  try {
    const { where, join, params } = ftsWhere("errors", "errors_fts");
    const rows = await db.query<any>(
      `SELECT e.created_at, e.error, e.fix, e.frequency, ${rankExpr("errors")} AS rank
       FROM errors e ${join}
       WHERE ${where}
       ORDER BY rank ${b === "sqlite" ? "ASC" : "DESC"}
       LIMIT ?`, [...rankParam(), ...params, Math.min(limit, 10)]
    );
    for (const r of rows) results.push({ type: "error", date: r.created_at, error: r.error, fix: r.fix, frequency: r.frequency });
  } catch {}

  // Learnings
  try {
    const { where, join, params } = ftsWhere("learnings", "learnings_fts");
    const rows = await db.query<any>(
      `SELECT l.created_at, l.project, l.problem, l.solution, ${rankExpr("learnings")} AS rank
       FROM learnings l ${join}
       WHERE ${where}
       ORDER BY rank ${b === "sqlite" ? "ASC" : "DESC"}
       LIMIT ?`, [...rankParam(), ...params, Math.min(limit, 10)]
    );
    for (const r of rows) results.push({ type: "learning", date: r.created_at, project: r.project, problem: r.problem, solution: r.solution });
  } catch {}

  return results;
}

async function recallRecent(db: HookDb, count: number = 5, project?: string): Promise<any[]> {
  const sql = project
    ? `SELECT created_at, project, title, fabric_extract FROM loa_entries WHERE project = ? ORDER BY id DESC LIMIT ?`
    : `SELECT created_at, project, title, fabric_extract FROM loa_entries ORDER BY id DESC LIMIT ?`;
  return db.query<any>(sql, project ? [project, count] : [count]);
}

async function getStats(db: HookDb): Promise<any> {
  const count = async (t: string) => ((await db.queryOne<{ c: number }>(`SELECT COUNT(*) as c FROM ${t}`))?.c ?? 0);
  const [sessions, decisions, errors, learnings] = await Promise.all([
    count("loa_entries"), count("decisions"), count("errors"), count("learnings"),
  ]);
  const dateRange = await db.queryOne<{ earliest: string; latest: string }>(
    `SELECT MIN(created_at) as earliest, MAX(created_at) as latest FROM loa_entries`
  );
  return { sessions, decisions, errors, learnings, date_range: dateRange };
}

// ─── MCP Protocol Handler ─────────────────────────────────────────

const TOOLS = [
  {
    name: "memory_search",
    description:
      "Search your persistent memory across all sessions, decisions, errors, and learnings. Uses full-text search over your extracted session transcripts. Use this to find past context, decisions, error fixes, or any topic discussed in previous conversations.",
    inputSchema: {
      type: "object" as const,
      properties: {
        query: { type: "string" as const, description: "Search query" },
        limit: { type: "number" as const, description: "Max results (default 15)", default: 15 },
      },
      required: ["query"],
    },
  },
  {
    name: "memory_recall",
    description:
      "Get recent session extractions for context loading. Returns the most recent conversation summaries, optionally filtered by project name.",
    inputSchema: {
      type: "object" as const,
      properties: {
        count: { type: "number" as const, description: "Number of recent sessions (default 5)", default: 5 },
        project: { type: "string" as const, description: "Filter by project name (optional)" },
      },
    },
  },
];

async function handleRequest(db: HookDb, req: JsonRpcRequest): Promise<JsonRpcResponse | null> {
  switch (req.method) {
    case "initialize":
      return {
        jsonrpc: "2.0",
        id: req.id ?? null,
        result: {
          protocolVersion: "2024-11-05",
          capabilities: { tools: {} },
          serverInfo: { name: "pai-memory", version: "1.0.0" },
        },
      };

    case "notifications/initialized":
      return null;

    case "tools/list":
      return { jsonrpc: "2.0", id: req.id ?? null, result: { tools: TOOLS } };

    case "tools/call": {
      const toolName = req.params?.name;
      const args = req.params?.arguments || {};

      if (toolName === "memory_search") {
        const results = await searchMemory(db, args.query, args.limit || 15);
        const stats = await getStats(db);
        const text = results.length === 0
          ? `No results for "${args.query}" (searched ${stats.sessions} sessions, ${stats.decisions} decisions, ${stats.errors} errors)`
          : results.map((r) => {
              if (r.type === "session") return `[SESSION ${r.date}] ${r.project}: ${r.title}`;
              if (r.type === "decision") return `[DECISION ${r.date}] ${r.project}: ${r.decision} — ${r.reasoning || ""}`;
              if (r.type === "error") return `[ERROR ×${r.frequency}] ${r.error}: ${r.fix}`;
              if (r.type === "learning") return `[LEARNING ${r.date}] ${r.project}: ${r.problem} → ${r.solution}`;
              return JSON.stringify(r);
            }).join("\n\n");

        return { jsonrpc: "2.0", id: req.id ?? null, result: { content: [{ type: "text", text }] } };
      }

      if (toolName === "memory_recall") {
        const results = await recallRecent(db, args.count || 5, args.project);
        const text = results.length === 0
          ? "No recent sessions found."
          : results.map((r: any) => `## ${r.created_at} | ${r.project}\n${r.title}\n\n${r.fabric_extract?.slice(0, 500) || ""}`).join("\n\n---\n\n");

        return { jsonrpc: "2.0", id: req.id ?? null, result: { content: [{ type: "text", text }] } };
      }

      return { jsonrpc: "2.0", id: req.id ?? null, error: { code: -32601, message: `Unknown tool: ${toolName}` } };
    }

    default:
      return { jsonrpc: "2.0", id: req.id ?? null, error: { code: -32601, message: `Unknown method: ${req.method}` } };
  }
}

// ─── Stdio Transport ──────────────────────────────────────────────

async function main() {
  const db = await openHookDb();
  const decoder = new TextDecoder();
  let buffer = "";

  const reader = Bun.stdin.stream().getReader();

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });

      let newlineIdx;
      while ((newlineIdx = buffer.indexOf("\n")) !== -1) {
        const line = buffer.slice(0, newlineIdx).trim();
        buffer = buffer.slice(newlineIdx + 1);
        if (!line) continue;
        try {
          const req: JsonRpcRequest = JSON.parse(line);
          const res = await handleRequest(db, req);
          if (res) process.stdout.write(JSON.stringify(res) + "\n");
        } catch (e: any) {
          process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: -32700, message: `Parse error: ${e.message}` } }) + "\n");
        }
      }
    }
  } finally {
    await db.close();
  }
}

main();
