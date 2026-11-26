-- document_members faltaba en 0001_init (Etapa 4 la necesita).
CREATE TABLE IF NOT EXISTS document_members (
  document_id TEXT NOT NULL REFERENCES documents (id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  role TEXT NOT NULL CHECK (role IN ('owner', 'editor', 'viewer')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (document_id, user_id)
);
