// Persistencia de documentos en PostgreSQL (Etapa 3).
// Un row por update (preserva author_id por update; combinar con Y.mergeUpdates
// queda como optimización futura de almacenamiento). Los BYTEA se copian al
// leer/escribir para evitar aliasing con el pool de Buffers de node-postgres.
import { Pool } from "npm:pg";

type PoolT = InstanceType<typeof Pool>;
type ClientT = Awaited<ReturnType<PoolT["connect"]>>;

const DATABASE_URL =
  Deno.env.get("DATABASE_URL") ?? "postgresql://synapse:synapse@localhost:5432/synapse";

let pool: PoolT | null = null;

export function getPool(): PoolT {
  if (!pool) {
    pool = new Pool({ connectionString: DATABASE_URL, max: 5, connectionTimeoutMillis: 5000 });
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
}

export async function loadDocument(documentId: string): Promise<LoadedDocument | null> {
  const pool = getPool();
  const { rows: docs } = await pool.query<{ last_seq: string }>(
    "SELECT last_seq FROM documents WHERE id = $1",
    [documentId],
  );
  if (docs.length === 0) return null;
  const lastSeq = Number(docs[0].last_seq);
  const { rows: snaps } = await pool.query<{ state: unknown; last_seq: string }>(
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
    [id, documentId, toBuffer(state), lastSeq, kind, opts?.label ?? null, opts?.authorId ?? null],
  );
  return id;
}

/** Borra updates con seq < corte. Devuelve cantidad borrada. */
export async function compactBefore(documentId: string, seqExclusive: number): Promise<number> {
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
    await client.query("SELECT pg_advisory_xact_lock(hashtext($1)::bigint)", [documentId]);
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
