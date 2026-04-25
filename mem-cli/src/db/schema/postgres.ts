/**
 * PostgreSQL schema for LMF4.1
 *
 * Key differences from SQLite schema:
 *   - BIGSERIAL instead of INTEGER AUTOINCREMENT
 *   - TIMESTAMPTZ instead of DATETIME
 *   - tsvector GENERATED columns instead of FTS5 virtual tables + triggers
 *   - vector(768) instead of BLOB for embeddings (pgvector)
 *   - HNSW index for approximate nearest-neighbour search
 *   - INSERT ... ON CONFLICT instead of INSERT OR REPLACE/IGNORE
 *   - fabric_extract (not fabric_extract) from day one
 */

export const PG_CREATE_EXTENSIONS = `
DO $$ BEGIN
  CREATE EXTENSION IF NOT EXISTS vector;
EXCEPTION WHEN insufficient_privilege THEN
  NULL;
END $$;
DO $$ BEGIN
  CREATE EXTENSION IF NOT EXISTS pg_trgm;
EXCEPTION WHEN insufficient_privilege THEN
  NULL;
END $$;
`;

export const PG_CREATE_TABLES = `
CREATE TABLE IF NOT EXISTS schema_meta (
  key   TEXT PRIMARY KEY,
  value TEXT
);

CREATE TABLE IF NOT EXISTS sessions (
  id         BIGSERIAL PRIMARY KEY,
  session_id TEXT UNIQUE NOT NULL,
  started_at TIMESTAMPTZ DEFAULT NOW(),
  ended_at   TIMESTAMPTZ,
  summary    TEXT,
  project    TEXT,
  cwd        TEXT,
  git_branch TEXT,
  model      TEXT
);

CREATE TABLE IF NOT EXISTS messages (
  id         BIGSERIAL PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES sessions(session_id),
  timestamp  TIMESTAMPTZ NOT NULL,
  role       TEXT NOT NULL CHECK (role IN ('user', 'assistant', 'system')),
  content    TEXT NOT NULL,
  project    TEXT
);

CREATE TABLE IF NOT EXISTS decisions (
  id           BIGSERIAL PRIMARY KEY,
  created_at   TIMESTAMPTZ DEFAULT NOW(),
  session_id   TEXT REFERENCES sessions(session_id),
  category     TEXT,
  project      TEXT,
  decision     TEXT NOT NULL,
  reasoning    TEXT,
  alternatives TEXT,
  status       TEXT DEFAULT 'active'
               CHECK (status IN ('active', 'superseded', 'reverted'))
);

CREATE TABLE IF NOT EXISTS learnings (
  id         BIGSERIAL PRIMARY KEY,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  session_id TEXT REFERENCES sessions(session_id),
  category   TEXT,
  project    TEXT,
  problem    TEXT NOT NULL,
  solution   TEXT,
  prevention TEXT,
  tags       TEXT
);

CREATE TABLE IF NOT EXISTS errors (
  id         BIGSERIAL PRIMARY KEY,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  error      TEXT NOT NULL,
  cause      TEXT,
  fix        TEXT,
  frequency  INTEGER DEFAULT 1,
  last_seen  TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS breadcrumbs (
  id         BIGSERIAL PRIMARY KEY,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  session_id TEXT REFERENCES sessions(session_id),
  content    TEXT NOT NULL,
  category   TEXT,
  project    TEXT,
  importance INTEGER DEFAULT 5 CHECK (importance BETWEEN 1 AND 10),
  expires_at TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS loa_entries (
  id                  BIGSERIAL PRIMARY KEY,
  created_at          TIMESTAMPTZ DEFAULT NOW(),
  title               TEXT NOT NULL,
  description         TEXT,
  fabric_extract     TEXT NOT NULL,
  message_range_start BIGINT REFERENCES messages(id) ON DELETE SET NULL,
  message_range_end   BIGINT REFERENCES messages(id) ON DELETE SET NULL,
  parent_loa_id       BIGINT REFERENCES loa_entries(id),
  session_id          TEXT REFERENCES sessions(session_id),
  project             TEXT,
  tags                TEXT,
  message_count       INTEGER
);

CREATE TABLE IF NOT EXISTS telos (
  id          BIGSERIAL PRIMARY KEY,
  code        TEXT UNIQUE NOT NULL,
  type        TEXT NOT NULL CHECK (type IN (
                'identity','problem','mission','goal','challenge',
                'strategy','project','skill','aspiration','metric','other'
              )),
  category    TEXT,
  title       TEXT NOT NULL,
  content     TEXT NOT NULL,
  parent_code TEXT,
  source_file TEXT,
  created_at  TIMESTAMPTZ DEFAULT NOW(),
  updated_at  TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS documents (
  id               BIGSERIAL PRIMARY KEY,
  path             TEXT UNIQUE NOT NULL,
  title            TEXT NOT NULL,
  type             TEXT NOT NULL CHECK (type IN (
                     'diary','reference','wisdom','plan',
                     'memory','enterprise','other'
                   )),
  content          TEXT NOT NULL,
  summary          TEXT,
  size_bytes       BIGINT,
  file_modified_at TIMESTAMPTZ,
  created_at       TIMESTAMPTZ DEFAULT NOW(),
  updated_at       TIMESTAMPTZ DEFAULT NOW()
);
`;

export const PG_CREATE_INDEXES = `
CREATE INDEX IF NOT EXISTS idx_sessions_project   ON sessions(project);
CREATE INDEX IF NOT EXISTS idx_sessions_started   ON sessions(started_at);
CREATE INDEX IF NOT EXISTS idx_messages_session   ON messages(session_id);
CREATE INDEX IF NOT EXISTS idx_messages_timestamp ON messages(timestamp);
CREATE INDEX IF NOT EXISTS idx_messages_project   ON messages(project);
CREATE INDEX IF NOT EXISTS idx_decisions_project  ON decisions(project);
CREATE INDEX IF NOT EXISTS idx_decisions_category ON decisions(category);
CREATE INDEX IF NOT EXISTS idx_decisions_created  ON decisions(created_at);
CREATE INDEX IF NOT EXISTS idx_decisions_status   ON decisions(status);
CREATE INDEX IF NOT EXISTS idx_learnings_project  ON learnings(project);
CREATE INDEX IF NOT EXISTS idx_learnings_category ON learnings(category);
CREATE INDEX IF NOT EXISTS idx_learnings_created  ON learnings(created_at);
CREATE INDEX IF NOT EXISTS idx_errors_error       ON errors(error);
CREATE INDEX IF NOT EXISTS idx_errors_last_seen   ON errors(last_seen);
CREATE INDEX IF NOT EXISTS idx_breadcrumbs_project    ON breadcrumbs(project);
CREATE INDEX IF NOT EXISTS idx_breadcrumbs_importance ON breadcrumbs(importance);
CREATE INDEX IF NOT EXISTS idx_breadcrumbs_created    ON breadcrumbs(created_at);
CREATE INDEX IF NOT EXISTS idx_loa_project  ON loa_entries(project);
CREATE INDEX IF NOT EXISTS idx_loa_created  ON loa_entries(created_at);
CREATE INDEX IF NOT EXISTS idx_loa_parent   ON loa_entries(parent_loa_id);
CREATE INDEX IF NOT EXISTS idx_telos_type     ON telos(type);
CREATE INDEX IF NOT EXISTS idx_telos_category ON telos(category);
CREATE INDEX IF NOT EXISTS idx_telos_parent   ON telos(parent_code);
CREATE INDEX IF NOT EXISTS idx_documents_type    ON documents(type);
CREATE INDEX IF NOT EXISTS idx_documents_created ON documents(created_at);
`;

/**
 * GENERATED ALWAYS AS STORED tsvector columns.
 * PostgreSQL maintains these automatically on every INSERT/UPDATE.
 * No triggers needed — replaces the entire FTS5 virtual table + trigger system.
 *
 * Run as separate ALTER TABLE statements (one per table) after CREATE TABLE.
 * Uses IF NOT EXISTS equivalent: ALTER TABLE ... ADD COLUMN IF NOT EXISTS.
 */
export const PG_CREATE_FTS_COLUMNS = `
ALTER TABLE messages    ADD COLUMN IF NOT EXISTS fts tsvector
  GENERATED ALWAYS AS (
    to_tsvector('english', coalesce(content,'') || ' ' || coalesce(project,''))
  ) STORED;

ALTER TABLE decisions   ADD COLUMN IF NOT EXISTS fts tsvector
  GENERATED ALWAYS AS (
    to_tsvector('english',
      coalesce(decision,'') || ' ' || coalesce(reasoning,'') || ' ' || coalesce(project,''))
  ) STORED;

ALTER TABLE learnings   ADD COLUMN IF NOT EXISTS fts tsvector
  GENERATED ALWAYS AS (
    to_tsvector('english',
      coalesce(problem,'') || ' ' || coalesce(solution,'') || ' ' ||
      coalesce(tags,'')    || ' ' || coalesce(project,''))
  ) STORED;

ALTER TABLE errors      ADD COLUMN IF NOT EXISTS fts tsvector
  GENERATED ALWAYS AS (
    to_tsvector('english',
      coalesce(error,'') || ' ' || coalesce(fix,'') || ' ' || coalesce(cause,''))
  ) STORED;

ALTER TABLE breadcrumbs ADD COLUMN IF NOT EXISTS fts tsvector
  GENERATED ALWAYS AS (
    to_tsvector('english',
      coalesce(content,'') || ' ' || coalesce(category,'') || ' ' || coalesce(project,''))
  ) STORED;

ALTER TABLE loa_entries ADD COLUMN IF NOT EXISTS fts tsvector
  GENERATED ALWAYS AS (
    to_tsvector('english',
      coalesce(title,'')           || ' ' || coalesce(description,'')   || ' ' ||
      coalesce(fabric_extract,'') || ' ' || coalesce(tags,'')          || ' ' ||
      coalesce(project,''))
  ) STORED;

ALTER TABLE telos       ADD COLUMN IF NOT EXISTS fts tsvector
  GENERATED ALWAYS AS (
    to_tsvector('english',
      coalesce(code,'')    || ' ' || coalesce(type,'')    || ' ' ||
      coalesce(title,'')   || ' ' || coalesce(content,'') || ' ' ||
      coalesce(category,''))
  ) STORED;

ALTER TABLE documents   ADD COLUMN IF NOT EXISTS fts tsvector
  GENERATED ALWAYS AS (
    to_tsvector('english',
      coalesce(title,'')   || ' ' || coalesce(type,'')    || ' ' ||
      coalesce(content,'') || ' ' || coalesce(summary,'') || ' ' ||
      coalesce(path,''))
  ) STORED;
`;

export const PG_CREATE_FTS_INDEXES = `
CREATE INDEX IF NOT EXISTS idx_messages_fts    ON messages    USING GIN (fts);
CREATE INDEX IF NOT EXISTS idx_decisions_fts   ON decisions   USING GIN (fts);
CREATE INDEX IF NOT EXISTS idx_learnings_fts   ON learnings   USING GIN (fts);
CREATE INDEX IF NOT EXISTS idx_errors_fts      ON errors      USING GIN (fts);
CREATE INDEX IF NOT EXISTS idx_breadcrumbs_fts ON breadcrumbs USING GIN (fts);
CREATE INDEX IF NOT EXISTS idx_loa_fts         ON loa_entries USING GIN (fts);
CREATE INDEX IF NOT EXISTS idx_telos_fts       ON telos       USING GIN (fts);
CREATE INDEX IF NOT EXISTS idx_documents_fts   ON documents   USING GIN (fts);
`;

export const PG_CREATE_VECTOR_TABLES = `
DO $$ BEGIN
  EXECUTE '
    CREATE TABLE IF NOT EXISTS embeddings (
      id           BIGSERIAL PRIMARY KEY,
      source_table TEXT NOT NULL,
      source_id    BIGINT NOT NULL,
      model        TEXT NOT NULL DEFAULT ''nomic-embed-text'',
      dimensions   INTEGER NOT NULL DEFAULT 768,
      embedding    vector(768) NOT NULL,
      created_at   TIMESTAMPTZ DEFAULT NOW(),
      UNIQUE (source_table, source_id)
    )';
  EXECUTE 'CREATE INDEX IF NOT EXISTS idx_embeddings_source ON embeddings(source_table, source_id)';
  EXECUTE 'CREATE INDEX IF NOT EXISTS idx_embeddings_model  ON embeddings(model)';
  EXECUTE $i$
    CREATE INDEX IF NOT EXISTS idx_embeddings_hnsw ON embeddings
      USING hnsw (embedding vector_cosine_ops)
      WITH (m = 16, ef_construction = 64)
  $i$;
EXCEPTION WHEN undefined_object OR feature_not_supported THEN
  RAISE NOTICE 'pgvector not installed — embeddings table skipped. Install postgresql-pgvector to enable semantic search.';
END $$;
`;

/** Ordered list of DDL strings for PostgresAdapter.init() */
export const PG_SCHEMA_ORDERED = [
  PG_CREATE_EXTENSIONS,
  PG_CREATE_TABLES,
  PG_CREATE_INDEXES,
  PG_CREATE_FTS_COLUMNS,
  PG_CREATE_FTS_INDEXES,
  PG_CREATE_VECTOR_TABLES,
];
