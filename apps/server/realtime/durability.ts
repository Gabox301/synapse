// Durabilidad de updates (Etapa 3): cola por documento, flush por ventana,
// ack tras commit, carga desde store y persistencia al evictar.
// Regla: se difunde antes de persistir; el ack es la única promesa de durabilidad.
import * as Y from "yjs";

import { evictDoc, getOrCreateDoc, hasDoc } from "./documents.ts";
import { loadDocument, saveBatch } from "./persistence.ts";

export interface QueuedUpdate {
  conn: WebSocket;
  cseq: number;
  update: Uint8Array;
}

interface DocState {
  queue: QueuedUpdate[];
  timer: ReturnType<typeof setTimeout> | null;
  persistedSeq: number;
  flushing: boolean;
}

const states = new Map<string, DocState>();
let flushMs = 100;

export function setFlushMs(ms: number): void {
  flushMs = ms;
}

/** Limpia colas y timers (tests). No toca memoria de docs ni PG. */
export function resetDurability(): void {
  for (const st of states.values()) {
    if (st.timer !== null) clearTimeout(st.timer);
  }
  states.clear();
}

function stateOf(documentId: string): DocState {
  let st = states.get(documentId);
  if (!st) {
    st = { queue: [], timer: null, persistedSeq: 0, flushing: false };
    states.set(documentId, st);
  }
  return st;
}

export function persistedSeq(documentId: string): number {
  return states.get(documentId)?.persistedSeq ?? 0;
}

/** Devuelve el Y.Doc en memoria, cargándolo del store si es necesario. */
const loading = new Map<string, Promise<{ doc: Y.Doc; seq: number }>>();

/** Carga el doc a memoria (una sola vez ante llamadas concurrentes). */
export function ensureLoaded(
  documentId: string,
): Promise<{ doc: Y.Doc; seq: number }> {
  const inFlight = loading.get(documentId);
  if (inFlight) return inFlight;
  const p = loadIntoMemory(documentId).finally(() => {
    if (loading.get(documentId) === p) loading.delete(documentId);
  });
  loading.set(documentId, p);
  return p;
}

async function loadIntoMemory(
  documentId: string,
): Promise<{ doc: Y.Doc; seq: number }> {
  if (hasDoc(documentId)) {
    return { doc: getOrCreateDoc(documentId), seq: persistedSeq(documentId) };
  }
  const stored = await loadDocument(documentId);
  const doc = getOrCreateDoc(documentId);
  if (!stored) {
    stateOf(documentId);
    return { doc, seq: 0 };
  }
  if (stored.snapshot) Y.applyUpdate(doc, stored.snapshot.state);
  for (const u of stored.updates) Y.applyUpdate(doc, u);
  stateOf(documentId).persistedSeq = stored.lastSeq;
  return { doc, seq: stored.lastSeq };
}

export function enqueueUpdate(
  documentId: string,
  conn: WebSocket,
  cseq: number,
  update: Uint8Array,
): void {
  const st = stateOf(documentId);
  st.queue.push({ conn, cseq, update });
  if (st.timer === null && !st.flushing) {
    st.timer = setTimeout(() => {
      st.timer = null;
      flushDocument(documentId).catch((err) => {
        console.error(`[durability] flush ${documentId} falló, reintenta:`, err);
        st.timer = setTimeout(() => {
          st.timer = null;
          flushDocument(documentId).catch((e) => console.error(`[durability] reintento ${documentId} falló:`, e));
        }, 1000);
      });
    }, flushMs);
  }
}

/** Persiste la cola pendiente y emite document:ack por conexión. */
export async function flushDocument(documentId: string): Promise<void> {
  const st = states.get(documentId);
  if (!st || st.flushing || st.queue.length === 0) return;
  st.flushing = true;
  const batch = st.queue;
  st.queue = [];
  try {
    // author_id real llega en Etapa 4 (tickets con identidad); hoy es desconocido.
    const seqs = await saveBatch(
      documentId,
      batch.map((e) => ({ data: e.update, authorId: null })),
    );
    const lastSeq = seqs[seqs.length - 1] ?? st.persistedSeq;
    st.persistedSeq = lastSeq;
    const upToByConn = new Map<WebSocket, number>();
    for (const entry of batch) {
      const prev = upToByConn.get(entry.conn) ?? 0;
      if (entry.cseq > prev) upToByConn.set(entry.conn, entry.cseq);
    }
    for (const [conn, upTo] of upToByConn) {
      if (conn.readyState !== WebSocket.OPEN) continue;
      conn.send(JSON.stringify({ type: "document:ack", payload: { upTo, seq: lastSeq } }));
    }
  } catch (err) {
    // Sin commit no hay ack: se reencola al frente para el próximo flush.
    st.queue.unshift(...batch);
    throw err;
  } finally {
    st.flushing = false;
  }
  if (st.queue.length > 0) {
    st.timer = setTimeout(() => {
      st.timer = null;
      flushDocument(documentId).catch((err) =>
        console.error(`[durability] flush ${documentId} falló:`, err)
      );
    }, 0);
  }
}

/**
 * Si la room quedó vacía: persiste pendientes, libera memoria y olvida estado.
 * Devuelve true cuando evictó.
 */
export async function evictIfEmpty(
  documentId: string,
  room: Set<WebSocket> | undefined,
): Promise<boolean> {
  if (room && room.size > 0) return false;
  await flushDocument(documentId);
  evictDoc(documentId);
  const st = states.get(documentId);
  if (st?.timer != null) clearTimeout(st.timer);
  states.delete(documentId);
  return true;
}
