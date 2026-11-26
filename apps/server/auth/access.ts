// Autorización por documento (Etapa 4): roles y membresías.
// Orden: miembro directo → miembro del workspace → creador (owner) → null.
import { getPool } from "../realtime/persistence.ts";

export type Role = "owner" | "editor" | "viewer";

function randomId(prefix: string): string {
  return `${prefix}_${crypto.randomUUID().replaceAll("-", "").slice(0, 16)}`;
}

export async function resolveRole(userId: string, documentId: string): Promise<Role | null> {
  const pool = getPool();
  const direct = await pool.query<{ role: Role }>(
    `SELECT role FROM document_members WHERE document_id = $1 AND user_id = $2`,
    [documentId, userId],
  );
  if (direct.rows.length > 0) return direct.rows[0].role;

  const viaWorkspace = await pool.query<{ role: Role }>(
    `SELECT m.role FROM workspace_members m
     JOIN documents d ON d.workspace_id = m.workspace_id
     WHERE d.id = $1 AND m.user_id = $2`,
    [documentId, userId],
  );
  if (viaWorkspace.rows.length > 0) return viaWorkspace.rows[0].role;

  const created = await pool.query<{ created_by: string | null; workspace_id: string | null }>(
    `SELECT created_by, workspace_id FROM documents WHERE id = $1`,
    [documentId],
  );
  if (created.rows.length === 0) return null;
  if (created.rows[0].created_by === userId) return "owner";
  if (created.rows[0].workspace_id) {
    const owner = await pool.query<{ owner_id: string | null }>(
      `SELECT owner_id FROM workspaces WHERE id = $1`,
      [created.rows[0].workspace_id],
    );
    if (owner.rows.length > 0 && owner.rows[0].owner_id === userId) return "owner";
  }
  return null;
}

export async function createDocument(opts: {
  id?: string;
  workspaceId?: string | null;
  title?: string;
  createdBy: string;
}): Promise<string> {
  const id = opts.id ?? `doc_${crypto.randomUUID().replaceAll("-", "").slice(0, 12)}`;
  await getPool().query(
    `INSERT INTO documents (id, workspace_id, title, created_by)
     VALUES ($1, $2, $3, $4)`,
    [id, opts.workspaceId ?? null, opts.title ?? "Untitled", opts.createdBy],
  );
  await addDocumentMember(id, opts.createdBy, "owner");
  return id;
}

export async function addDocumentMember(
  documentId: string,
  userId: string,
  role: Role,
): Promise<void> {
  await getPool().query(
    `INSERT INTO document_members (document_id, user_id, role)
     VALUES ($1, $2, $3)
     ON CONFLICT (document_id, user_id) DO UPDATE SET role = EXCLUDED.role`,
    [documentId, userId, role],
  );
}

export async function removeDocumentMember(documentId: string, userId: string): Promise<void> {
  await getPool().query(
    "DELETE FROM document_members WHERE document_id = $1 AND user_id = $2",
    [documentId, userId],
  );
}
