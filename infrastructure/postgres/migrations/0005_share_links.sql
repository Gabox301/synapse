-- Enlaces para compartir (un owner genera un link con rol + vencimiento + usos).
-- El link NO otorga owner: solo editor/viewer. El token viaja en la URL:
-- en DB solo vive su hash SHA-256 (igual que tickets).
CREATE TABLE IF NOT EXISTS share_links (
  id TEXT PRIMARY KEY,
  document_id TEXT NOT NULL REFERENCES documents (id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL UNIQUE,
  role TEXT NOT NULL CHECK (role IN ('editor', 'viewer')),
  created_by TEXT REFERENCES users (id),
  expires_at TIMESTAMPTZ NOT NULL,
  max_uses INT,
  used_count INT NOT NULL DEFAULT 0,
  revoked_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS share_links_doc_idx ON share_links (document_id);
