// Persistencia de documentos en PostgreSQL (Etapa 3).
// Un row por update (preserva author_id por update; combinar con Y.mergeUpdates
// queda como optimización futura de almacenamiento). Los BYTEA se copian al
// leer/escribir para evitar aliasing con el pool de Buffers de node-postgres.
import { Buffer } from "node:buffer";
import { Pool } from "npm:pg";
import type { PoolClient } from "npm:pg";

type PoolT = InstanceType<typeof Pool>;
type ClientT = PoolClient;

const DATABASE_URL = Deno.env.get("DATABASE_URL") ??
  "postgresql://synapse:synapse@localhost:5432/synapse";

let pool: PoolT | null = null;

export function getPool(): PoolT {
  if (!pool) {
    pool = new Pool({
      connectionString: DATABASE_URL,
      max: 5,
      connectionTimeoutMillis: 5000,
    });
  }
  return pool;
}

export async function closePool(): Promise<void> {
  if (pool) {
    const p = pool;
    pool = null;
    await p.end();
  }
}

function toBytes(col: unknown): Uint8Array {
  if (col instanceof Uint8Array) return new Uint8Array(col);
  throw new Error("columna BYTEA inesperada");
}

function toBuffer(data: Uint8Array): Uint8Array {
  return Buffer.from(data.buffer, data.byteOffset, data.byteLength);
}

export async function ensureDocument(
  documentId: string,
  opts?: { title?: string; authorId?: string | null },
): Promise<void> {
  await getPool().query(
    `INSERT INTO documents (id, title, created_by) VALUES ($1, $2, $3)
     ON CONFLICT (id) DO NOTHING`,
    [documentId, opts?.title ?? "Untitled", opts?.authorId ?? null],
  );
}

/** Guarda un lote en UNA transacción; el UPDATE de last_seq serializa escritores. */
export async function saveBatch(
  documentId: string,
  updates: Array<{ data: Uint8Array; authorId?: string | null }>,
): Promise<number[]> {
  if (updates.length === 0) return [];
  await ensureDocument(documentId);
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    const { rows } = await client.query<{ last_seq: string }>(
      `UPDATE documents SET last_seq = last_seq + $2, updated_at = now()
       WHERE id = $1 RETURNING last_seq`,
      [documentId, updates.length],
    );
    const last = Number(rows[0].last_seq);
    const base = last - updates.length;
    const values: unknown[] = [];
    const placeholders: string[] = [];
    updates.forEach((u, i) => {
      const seq = base + i + 1;
      const k = i * 4;
      placeholders.push(`($${k + 1}, $${k + 2}, $${k + 3}, $${k + 4})`);
      values.push(documentId, seq, toBuffer(u.data), u.authorId ?? null);
    });
    await client.query(
      `INSERT INTO document_updates (document_id, seq, update_data, author_id)
       VALUES ${placeholders.join(", ")}`,
      values,
    );
    await client.query("COMMIT");
    return updates.map((_, i) => base + i + 1);
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

export interface LoadedDocument {
  snapshot: { state: Uint8Array; lastSeq: number } | null;
  updates: Uint8Array[];
  lastSeq: number;
  /** Schema TipTap persistido en `documents.schema_version` (default 1). */
  schemaVersion: number;
}

export async function loadDocument(
  documentId: string,
): Promise<LoadedDocument | null> {
  const pool = getPool();
  const { rows: docs } = await pool.query<
    { last_seq: string; schema_version: number | null }
  >(
    "SELECT last_seq, schema_version FROM documents WHERE id = $1",
    [documentId],
  );
  if (docs.length === 0) return null;
  const lastSeq = Number(docs[0].last_seq);
  const schemaVersion = Number(docs[0].schema_version ?? 1);
  const { rows: snaps } = await pool.query<
    { state: unknown; last_seq: string }
  >(
    `SELECT state, last_seq FROM document_snapshots
     WHERE document_id = $1 ORDER BY last_seq DESC LIMIT 1`,
    [documentId],
  );
  const snapLast = snaps.length > 0 ? Number(snaps[0].last_seq) : 0;
  const { rows: tail } = await pool.query<{ update_data: unknown }>(
    `SELECT update_data FROM document_updates
     WHERE document_id = $1 AND seq > $2 ORDER BY seq`,
    [documentId, snapLast],
  );
  return {
    snapshot: snaps.length > 0
      ? { state: toBytes(snaps[0].state), lastSeq: snapLast }
      : null,
    updates: tail.map((r: { update_data: unknown }) => toBytes(r.update_data)),
    lastSeq,
    schemaVersion,
  };
}

export async function saveSnapshot(
  documentId: string,
  state: Uint8Array,
  lastSeq: number,
  kind: "auto" | "named",
  opts?: { label?: string; authorId?: string | null },
): Promise<string> {
  const id = `snp_${crypto.randomUUID().replaceAll("-", "").slice(0, 16)}`;
  await getPool().query(
    `INSERT INTO document_snapshots
       (id, document_id, state, last_seq, kind, label, created_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [
      id,
      documentId,
      toBuffer(state),
      lastSeq,
      kind,
      opts?.label ?? null,
      opts?.authorId ?? null,
    ],
  );
  return id;
}

/** Borra updates con seq < corte. Devuelve cantidad borrada. */
export interface SnapshotMeta {
  id: string;
  kind: string;
  label: string | null;
  lastSeq: number;
  createdAt: string;
}

export async function getSnapshot(
  documentId: string,
  snapshotId: string,
): Promise<{ state: Uint8Array; lastSeq: number; kind: string } | null> {
  const { rows } = await getPool().query<
    { state: unknown; last_seq: string; kind: string }
  >(
    `SELECT state, last_seq, kind FROM document_snapshots
     WHERE document_id = $1 AND id = $2`,
    [documentId, snapshotId],
  );
  if (rows.length === 0) return null;
  return {
    state: toBytes(rows[0].state),
    lastSeq: Number(rows[0].last_seq),
    kind: rows[0].kind,
  };
}

export async function listSnapshots(
  documentId: string,
): Promise<SnapshotMeta[]> {
  const { rows } = await getPool().query<{
    id: string;
    kind: string;
    label: string | null;
    last_seq: string;
    created_at: string;
  }>(
    `SELECT id, kind, label, last_seq, created_at FROM document_snapshots
     WHERE document_id = $1 ORDER BY last_seq`,
    [documentId],
  );
  return rows.map((
    r: {
      id: string;
      kind: string;
      label: string | null;
      last_seq: string;
      created_at: string;
    },
  ) => ({
    id: r.id,
    kind: r.kind,
    label: r.label,
    lastSeq: Number(r.last_seq),
    createdAt: r.created_at,
  }));
}

export async function compactBefore(
  documentId: string,
  seqExclusive: number,
): Promise<number> {
  const { rowCount } = await getPool().query(
    "DELETE FROM document_updates WHERE document_id = $1 AND seq < $2",
    [documentId, seqExclusive],
  );
  return rowCount ?? 0;
}

/** Ejecuta fn en transacción bajo lock de asesoramiento por documento. */
export async function withDocLock<T>(
  documentId: string,
  fn: (client: ClientT) => Promise<T>,
): Promise<T> {
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock(hashtext($1)::bigint)", [
      documentId,
    ]);
    const out = await fn(client);
    await client.query("COMMIT");
    return out;
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

export async function setCodeLanguage(documentId: string, language: string): Promise<void> {
  const lang = language.trim().slice(0, 32) || "typescript";
  await getPool().query(
    "UPDATE documents SET code_language = $2, updated_at = now() WHERE id = $1 AND kind = 'code'",
    [documentId, lang],
  );
}

export interface ListedDocument {
  id: string;
  title: string;
  role: string;
  updatedAt: string;
  /** true si el usuario lo creó. */
  mine: boolean;
  kind: string;
  codeLanguage: string | null;
}

/**
 * Documentos visibles para un usuario (miembro, creador o vía workspace),
 * sin borrados, ordenados por actividad. El rol es el de miembro, `owner`
 * si lo creó, o `viewer` si solo lo ve por workspace.
 */
export async function listDocumentsForUser(userId: string): Promise<ListedDocument[]> {
  const { rows } = await getPool().query<{
    id: string;
    title: string;
    role: string | null;
    created_by: string | null;
    updated_at: Date | string;
    kind: string;
    code_language: string | null;
  }>(
    `SELECT d.id, d.title, m.role, d.created_by, d.updated_at, d.kind, d.code_language
     FROM documents d
     LEFT JOIN document_members m
       ON m.document_id = d.id AND m.user_id = $1
     LEFT JOIN workspace_members w
       ON w.workspace_id = d.workspace_id AND w.user_id = $1
     WHERE d.deleted_at IS NULL
       AND (m.user_id IS NOT NULL OR d.created_by = $1 OR w.user_id IS NOT NULL)
     ORDER BY d.updated_at DESC`,
    [userId],
  );
  return rows.map((r) => ({
    id: r.id,
    title: r.title,
    role: r.role ?? (r.created_by === userId ? "owner" : "viewer"),
    updatedAt: r.updated_at instanceof Date ? r.updated_at.toISOString() : String(r.updated_at),
    mine: r.created_by === userId,
    kind: r.kind,
    codeLanguage: r.code_language,
  }));
}

export interface DocumentMember {
  userId: string;
  email: string;
  role: string;
}

/** Miembros del documento con email, ordenados. */
export async function listDocumentMembers(documentId: string): Promise<DocumentMember[]> {
  const { rows } = await getPool().query<{
    user_id: string;
    email: string;
    role: string;
  }>(
    `SELECT m.user_id, u.email, m.role
     FROM document_members m
     JOIN users u ON u.id = m.user_id
     WHERE m.document_id = $1
     ORDER BY u.email`,
    [documentId],
  );
  return rows.map((r) => ({ userId: r.user_id, email: r.email, role: r.role }));
}

export interface DocActivity {
  seq: number;
  email: string | null;
  at: string;
}

/** Últimos commits persistidos del documento (los más nuevos primero). */
export async function recentActivity(documentId: string, limit = 8): Promise<DocActivity[]> {
  const { rows } = await getPool().query<{
    seq: string;
    email: string | null;
    created_at: Date | string;
  }>(
    `SELECT u.seq, e.email, u.created_at
     FROM document_updates u
     LEFT JOIN users e ON e.id = u.author_id
     WHERE u.document_id = $1
     ORDER BY u.seq DESC
     LIMIT $2`,
    [documentId, limit],
  );
  return rows.map((r) => ({
    seq: Number(r.seq),
    email: r.email,
    at: r.created_at instanceof Date ? r.created_at.toISOString() : String(r.created_at),
  }));
}
