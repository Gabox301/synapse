-- Synapse schema v1 (Etapa 3). Identidad mínima + workspaces para FKs honestas;
-- la lógica de auth/roles llega en Etapa 4.

CREATE TABLE users (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE workspaces (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  owner_id TEXT REFERENCES users (id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE workspace_members (
  workspace_id TEXT NOT NULL REFERENCES workspaces (id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  role TEXT NOT NULL CHECK (role IN ('owner', 'editor', 'viewer')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, user_id)
);

CREATE TABLE documents (
  id TEXT PRIMARY KEY,
  workspace_id TEXT REFERENCES workspaces (id) ON DELETE CASCADE,
  title TEXT NOT NULL DEFAULT 'Untitled',
  visibility TEXT NOT NULL DEFAULT 'private'
    CHECK (visibility IN ('private', 'workspace', 'shared')),
  last_seq BIGINT NOT NULL DEFAULT 0,
  schema_version INT NOT NULL DEFAULT 1,
  created_by TEXT REFERENCES users (id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at TIMESTAMPTZ
);

CREATE TABLE document_updates (
  document_id TEXT NOT NULL REFERENCES documents (id) ON DELETE CASCADE,
  seq BIGINT NOT NULL,
  update_data BYTEA NOT NULL,
  author_id TEXT REFERENCES users (id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (document_id, seq)
);

CREATE TABLE document_snapshots (
  id TEXT PRIMARY KEY,
  document_id TEXT NOT NULL REFERENCES documents (id) ON DELETE CASCADE,
  state BYTEA NOT NULL,
  last_seq BIGINT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('auto', 'named')),
  label TEXT,
  created_by TEXT REFERENCES users (id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX document_snapshots_doc_seq_idx
  ON document_snapshots (document_id, last_seq DESC);

CREATE INDEX document_updates_doc_seq_idx
  ON document_updates (document_id, seq);
