/**
 * Common schema constants shared across both SQLite and PostgreSQL backends.
 */

/** Bump this whenever schema changes. Both backends share the same version space. */
export const SCHEMA_VERSION = 3; // v3 = PostgreSQL dual-backend support

/** Canonical table names — used for type-safe lookups in embeddings etc. */
export const TABLES = {
  SESSIONS:    'sessions',
  MESSAGES:    'messages',
  DECISIONS:   'decisions',
  LEARNINGS:   'learnings',
  ERRORS:      'errors',
  BREADCRUMBS: 'breadcrumbs',
  LOA_ENTRIES: 'loa_entries',
  TELOS:       'telos',
  DOCUMENTS:   'documents',
  EMBEDDINGS:  'embeddings',
  SCHEMA_META: 'schema_meta',
} as const;

export type TableName = (typeof TABLES)[keyof typeof TABLES];
