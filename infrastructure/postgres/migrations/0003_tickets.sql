-- Tickets de un solo uso para el handshake WS (Etapa 4).
CREATE TABLE tickets (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  document_id TEXT NOT NULL REFERENCES documents (id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL UNIQUE,
  expires_at TIMESTAMPTZ NOT NULL,
  used_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX tickets_doc_idx ON tickets (document_id);
