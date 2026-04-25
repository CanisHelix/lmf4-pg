// mem show command

import { getDb } from '../db/index.js';
import { getLoaEntry } from '../lib/memory.js';
import type { Session, Message, Decision, Learning, Breadcrumb } from '../types/index.js';

export async function runShow(table: string, id: number): Promise<void> {
  const db = await getDb();

  switch (table) {
    case 'session':
    case 'sessions': {
      const row = await db.queryOne<Session>('SELECT * FROM sessions WHERE id = ?', [id]);
      if (!row) { console.error(`Session #${id} not found`); process.exit(1); }
      console.log('Session Details\n===============');
      console.log(`ID:         ${row.id}`);
      console.log(`Session ID: ${row.session_id}`);
      console.log(`Project:    ${row.project || 'N/A'}`);
      console.log(`Started:    ${row.started_at}`);
      console.log(`Ended:      ${row.ended_at || 'N/A'}`);
      console.log(`CWD:        ${row.cwd || 'N/A'}`);
      console.log(`Branch:     ${row.git_branch || 'N/A'}`);
      if (row.summary) console.log(`\nSummary:\n${row.summary}`);
      break;
    }

    case 'message':
    case 'messages': {
      const row = await db.queryOne<Message>('SELECT * FROM messages WHERE id = ?', [id]);
      if (!row) { console.error(`Message #${id} not found`); process.exit(1); }
      console.log('Message Details\n===============');
      console.log(`ID:        ${row.id}`);
      console.log(`Session:   ${row.session_id}`);
      console.log(`Role:      ${row.role}`);
      console.log(`Timestamp: ${row.timestamp}`);
      console.log(`Project:   ${row.project || 'N/A'}`);
      console.log(`\nContent:\n${row.content}`);
      break;
    }

    case 'decision':
    case 'decisions': {
      const row = await db.queryOne<Decision>('SELECT * FROM decisions WHERE id = ?', [id]);
      if (!row) { console.error(`Decision #${id} not found`); process.exit(1); }
      console.log('Decision Details\n================');
      console.log(`ID:       ${row.id}`);
      console.log(`Created:  ${row.created_at}`);
      console.log(`Project:  ${row.project || 'N/A'}`);
      console.log(`Category: ${row.category || 'N/A'}`);
      console.log(`Status:   ${row.status}`);
      console.log(`\nDecision:\n${row.decision}`);
      if (row.reasoning) console.log(`\nReasoning:\n${row.reasoning}`);
      if (row.alternatives) console.log(`\nAlternatives Considered:\n${row.alternatives}`);
      break;
    }

    case 'learning':
    case 'learnings': {
      const row = await db.queryOne<Learning>('SELECT * FROM learnings WHERE id = ?', [id]);
      if (!row) { console.error(`Learning #${id} not found`); process.exit(1); }
      console.log('Learning Details\n================');
      console.log(`ID:       ${row.id}`);
      console.log(`Created:  ${row.created_at}`);
      console.log(`Project:  ${row.project || 'N/A'}`);
      console.log(`Category: ${row.category || 'N/A'}`);
      console.log(`Tags:     ${row.tags || 'N/A'}`);
      console.log(`\nProblem:\n${row.problem}`);
      if (row.solution) console.log(`\nSolution:\n${row.solution}`);
      if (row.prevention) console.log(`\nPrevention:\n${row.prevention}`);
      break;
    }

    case 'breadcrumb':
    case 'breadcrumbs': {
      const row = await db.queryOne<Breadcrumb>('SELECT * FROM breadcrumbs WHERE id = ?', [id]);
      if (!row) { console.error(`Breadcrumb #${id} not found`); process.exit(1); }
      console.log('Breadcrumb Details\n==================');
      console.log(`ID:         ${row.id}`);
      console.log(`Created:    ${row.created_at}`);
      console.log(`Project:    ${row.project || 'N/A'}`);
      console.log(`Category:   ${row.category || 'N/A'}`);
      console.log(`Importance: ${row.importance}`);
      console.log(`Expires:    ${row.expires_at || 'Never'}`);
      console.log(`\nContent:\n${row.content}`);
      break;
    }

    case 'loa':
    case 'loa_entries': {
      const row = await getLoaEntry(id);
      if (!row) { console.error(`LoA #${id} not found`); process.exit(1); }
      console.log('Library of Alexandria Entry\n===========================');
      console.log(`ID:         ${row.id}`);
      console.log(`Title:      ${row.title}`);
      console.log(`Created:    ${row.created_at}`);
      console.log(`Project:    ${row.project || 'N/A'}`);
      console.log(`Messages:   ${row.message_count || 0} (IDs ${row.message_range_start}-${row.message_range_end})`);
      if (row.parent_loa_id) console.log(`Continues:  LoA #${row.parent_loa_id}`);
      if (row.tags) console.log(`Tags:       ${row.tags}`);
      console.log(`\n--- Extract ---\n`);
      console.log(row.fabric_extract);
      break;
    }

    default:
      console.error(`Unknown table: ${table}`);
      console.error('Valid tables: sessions, messages, decisions, learnings, breadcrumbs, loa');
      process.exit(1);
  }
}
