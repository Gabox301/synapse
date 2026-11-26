// Durabilidad de updates (Etapa 3): cola por documento, flush por ventana,
// ack tras commit, carga desde store y persistencia al evictar.
// Regla: se difunde antes de persistir; el ack es la única promesa de durabilidad.
import * as Y from "yjs";

import { evictDoc, getOrCreateDoc, hasDoc } from "./documents.ts";
import { compactBefore, getSnapshot, loadDocument, saveBatch, saveSnapshot } from "./persistence.ts";

export interface QueuedUpdate {
  conn: WebSocket;
  cseq: number;
  update: Uint8Array;
}

interface DocState {
  queue: QueuedUpdate[];
  timer: ReturnType<typeof setTimeout> | null;
  persistedSeq: number;
  lastSnapshotSeq: number;
  flushing: boolean;
}

const states = new Map<string, DocState>();
let flushMs = 100;
let autoSnapshotEvery = 100;

/** Límite blando de tamaño de estado por documento (Etapa 5 endurece abuso). */
export const MAX_DOC_STATE_BYTES = 32 * 1024 * 1024;

export function setAutoSnapshotEvery(n: number): void {
  autoSnapshotEvery = n;
}

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
    st = { queue: [], timer: null, persistedSeq: 0, lastSnapshotSeq: 0, flushing: false };
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
  const dst = stateOf(documentId);
  dst.persistedSeq = stored.lastSeq;
  dst.lastSnapshotSeq = stored.snapshot?.lastSeq ?? 0;
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
    // Snapshot automático por umbral (nunca rompe el path de ack).
    await maybeAutoSnapshot(documentId);
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

/** Snapshot automático cuando el tail supera el umbral (best-effort, no falla el flush). */
async function maybeAutoSnapshot(documentId: string): Promise<void> {
  try {
    const st = states.get(documentId);
    if (!st || st.persistedSeq - st.lastSnapshotSeq < autoSnapshotEvery) return;
    const doc = getOrCreateDoc(documentId);
    const state = Y.encodeStateAsUpdate(doc);
    if (state.length > MAX_DOC_STATE_BYTES) {
      console.error(
        `[durability] doc ${documentId} supera el limite (${state.length} bytes): sin snapshot`,
      );
      return;
    }
    await saveSnapshot(documentId, state, st.persistedSeq, "auto");
    st.lastSnapshotSeq = st.persistedSeq;
  } catch (err) {
    console.error(`[durability] auto-snapshot ${documentId} falló:`, err);
  }
}

/** Snapshot nombrado del estado actual (hace flush primero). Devuelve el id. */
export async function createNamedSnapshot(
  documentId: string,
  label: string,
  authorId: string | null = null,
): Promise<string> {
  await flushDocument(documentId);
  const doc = getOrCreateDoc(documentId);
  const state = Y.encodeStateAsUpdate(doc);
  if (state.length > MAX_DOC_STATE_BYTES) {
    throw new Error(`documento excede el limite (${state.length} bytes)`);
  }
  const st = stateOf(documentId);
  const id = await saveSnapshot(documentId, state, st.persistedSeq, "named", {
    label,
    authorId,
  });
  st.lastSnapshotSeq = st.persistedSeq;
  return id;
}

/**
 * Restaura una versión: guarda backup nombrado del estado actual y reescribe
 * el contenido con el del snapshot como un update más (el CRDT solo crece).
 * Los nodos se RE-CREAN (relojes frescos): re-aplicar los mismos items no
 * funciona porque Yjs los recuerda como borrados (tombstones).
 * Engine-level: la coordinación con clientes en vivo llega en Etapa 4.
 */
export type RootKind = "text" | "array" | "map" | "xmlfragment";

export interface RootSchema {
  name: string;
  kind: RootKind;
}

export async function restoreSnapshot(
  documentId: string,
  snapshotId: string,
  opts?: { authorId?: string | null; roots?: RootSchema[] },
): Promise<{ restoreSeq: number; backupId: string }> {
  const snap = await getSnapshot(documentId, snapshotId);
  if (!snap) throw new Error(`snapshot ${snapshotId} no existe en ${documentId}`);
  await flushDocument(documentId);
  const { doc } = await ensureLoaded(documentId);
  const backupId = await createNamedSnapshot(
    documentId,
    `pre-restore ${new Date().toISOString()}`,
    opts?.authorId ?? null,
  );
  const schema = opts?.roots ?? inferRootKinds(doc);
  const svBefore = Y.encodeStateVector(doc);
  const tmp = new Y.Doc();
  Y.applyUpdate(tmp, snap.state);
  Y.transact(doc, () => {
    for (const { name, kind } of schema) clearRoot(doc, name, kind);
    for (const { name, kind } of schema) copyRoot(doc, tmp, name, kind);
  });
  const diff = Y.encodeStateAsUpdate(doc, svBefore);
  const [restoreSeq] = await saveBatch(documentId, [{
    data: diff,
    authorId: opts?.authorId ?? null,
  }]);
  stateOf(documentId).persistedSeq = restoreSeq;
  return { restoreSeq, backupId };
}

/** Infiere el schema desde tipos reales; falla ante placeholders sin tipo conocido. */
export function inferRootKinds(doc: Y.Doc): RootSchema[] {
  const out: RootSchema[] = [];
  doc.share.forEach((type, name) => {
    if (type instanceof Y.XmlElement) {
      throw new Error(`restore no soporta raíz XmlElement '${name}'`);
    } else if (type instanceof Y.Text) out.push({ name, kind: "text" });
    else if (type instanceof Y.Array) out.push({ name, kind: "array" });
    else if (type instanceof Y.Map) out.push({ name, kind: "map" });
    else if (type instanceof Y.XmlFragment) out.push({ name, kind: "xmlfragment" });
    else {
      throw new Error(
        `restore necesita schema explícito para '${name}' (tipo desconocido: ${type.constructor.name})`,
      );
    }
  });
  return out;
}

function clearRoot(doc: Y.Doc, name: string, kind: RootKind): void {
  switch (kind) {
    case "text":
      doc.getText(name).delete(0, doc.getText(name).length);
      break;
    case "array": {
      const a = doc.getArray(name);
      a.delete(0, a.length);
      break;
    }
    case "map": {
      const m = doc.getMap(name);
      for (const key of Array.from(m.keys())) m.delete(key);
      break;
    }
    case "xmlfragment": {
      const f = doc.getXmlFragment(name);
      f.delete(0, f.length);
      break;
    }
  }
}

function copyRoot(live: Y.Doc, snap: Y.Doc, name: string, kind: RootKind): void {
  switch (kind) {
    case "text":
      live.getText(name).insert(0, snap.getText(name).toString());
      break;
    case "array":
      live.getArray(name).push(snap.getArray(name).toArray().map(cloneValue));
      break;
    case "map": {
      const dst = live.getMap(name);
      for (const [k, v] of snap.getMap(name).entries()) dst.set(k, cloneValue(v));
      break;
    }
    case "xmlfragment":
      live.getXmlFragment(name).insert(0, cloneXmlChildren(snap.getXmlFragment(name)));
      break;
  }
}

function cloneValue(value: unknown): unknown {
  if (value instanceof Y.Text) {
    const t = new Y.Text();
    t.insert(0, value.toString());
    return t;
  }
  if (value instanceof Y.Array) {
    const a = new Y.Array();
    a.push(value.toArray().map(cloneValue));
    return a;
  }
  if (value instanceof Y.Map) {
    const m = new Y.Map<unknown>();
    for (const [k, v] of value.entries()) m.set(k, cloneValue(v));
    return m;
  }
  if (value instanceof Y.XmlElement) return cloneXmlElement(value);
  if (value instanceof Y.XmlText) return cloneXmlText(value);
  if (value instanceof Y.XmlFragment) {
    const f = new Y.XmlFragment();
    f.insert(0, cloneXmlChildren(value));
    return f;
  }
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map(cloneValue);
  if (value.constructor === Object) {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, cloneValue(v)]));
  }
  throw new Error(`restore no soporta valor ${value.constructor.name}`);
}

function cloneXmlChildren(frag: Y.XmlFragment): Array<Y.XmlElement | Y.XmlText> {
  return frag.toArray().map((node) => {
    if (node instanceof Y.XmlElement) return cloneXmlElement(node);
    if (node instanceof Y.XmlText) return cloneXmlText(node);
    throw new Error(`restore no soporta nodo ${node.constructor.name}`);
  });
}

function cloneXmlElement(el: Y.XmlElement): Y.XmlElement {
  const fresh = new Y.XmlElement(el.nodeName);
  for (const [k, v] of Object.entries(el.getAttributes())) {
    if (v !== undefined) fresh.setAttribute(k, v);
  }
  fresh.insert(0, cloneXmlChildren(el as unknown as Y.XmlFragment));
  return fresh;
}

function cloneXmlText(t: Y.XmlText): Y.XmlText {
  const fresh = new Y.XmlText();
  let i = 0;
  for (const op of t.toDelta() as Array<{ insert: unknown; attributes?: Record<string, unknown> }>) {
    if (typeof op.insert !== "string") {
      throw new Error("restore no soporta embeds en XmlText");
    }
    fresh.insert(i, op.insert, op.attributes ?? {});
    i += op.insert.length;
  }
  return fresh;
}

/**
 * Retención: conserva los últimos `keepLast` updates y todo lo posterior al
 * último snapshot; compacta lo anterior. Devuelve filas borradas.
 */
export async function enforceRetention(documentId: string, keepLast: number): Promise<number> {
  await flushDocument(documentId);
  const loaded = await loadDocument(documentId);
  if (!loaded) return 0;
  let snapSeq = loaded.snapshot?.lastSeq ?? 0;
  if (snapSeq < loaded.lastSeq - keepLast) {
    // Sin cobertura: snapshot automático primero; nunca se borra sin snapshot.
    const tmp = new Y.Doc();
    if (loaded.snapshot) Y.applyUpdate(tmp, loaded.snapshot.state);
    for (const u of loaded.updates) Y.applyUpdate(tmp, u);
    await saveSnapshot(documentId, Y.encodeStateAsUpdate(tmp), loaded.lastSeq, "auto");
    snapSeq = loaded.lastSeq;
    const st = stateOf(documentId);
    if (snapSeq > st.lastSnapshotSeq) st.lastSnapshotSeq = snapSeq;
  }
  const cutoff = Math.min(snapSeq, loaded.lastSeq - keepLast);
  if (cutoff <= 0) return 0;
  return await compactBefore(documentId, cutoff + 1);
}
