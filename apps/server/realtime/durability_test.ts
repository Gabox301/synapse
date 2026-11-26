// Tests de durability.ts (Etapa 3 T3): cola, flush, acks y load contra PG real.
// Requieren PG arriba; sin PG se saltean con aviso.
import * as Y from "yjs";
import { hasDoc, resetStore } from "./documents.ts";
import { loadDocument } from "./persistence.ts";
import {
  enqueueUpdate,
  ensureLoaded,
  evictIfEmpty,
  flushDocument,
  persistedSeq,
  resetDurability,
  setFlushMs,
} from "./durability.ts";

interface MockConn {
  sent: string[];
  readyState: number;
  send(data: string | Uint8Array): void;
}

function mockConn(): MockConn {
  return {
    sent: [],
    readyState: 1,
    send(data: string | Uint8Array): void {
      if (typeof data === "string") this.sent.push(data);
    },
  };
}

function lastAck(conn: MockConn): { upTo: number; seq: number } | null {
  const raw = conn.sent.filter((s) => s.includes("document:ack")).pop();
  if (!raw) return null;
  return JSON.parse(raw).payload as { upTo: number; seq: number };
}

async function pgUp(): Promise<boolean> {
  try {
    await ensureLoaded(`probe-${Date.now()}`);
    return true;
  } catch {
    return false;
  }
}

function freshId(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
}

Deno.test({
  name: "durability/**",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn(t) {
    if (!await pgUp()) {
      console.log("SKIP: sin postgres (docker compose up -d postgres)");
      return;
    }

    await t.step("flush confirma el lote y hace ack por conexión", async () => {
      resetStore();
      resetDurability();
      const id = freshId("t3-flush");
      const c1 = mockConn();
      const c2 = mockConn();
      const doc = new Y.Doc();
      doc.getText("t").insert(0, "a");
      const u1 = Y.encodeStateAsUpdate(doc);
      doc.getText("t").insert(1, "b");
      const u2 = Y.encodeStateAsUpdate(doc);
      enqueueUpdate(id, c1 as unknown as WebSocket, 1, u1);
      enqueueUpdate(id, c2 as unknown as WebSocket, 2, u2);
      await flushDocument(id);
      const a1 = lastAck(c1);
      const a2 = lastAck(c2);
      if (!a1 || a1.upTo !== 1) throw new Error("ack c1 mal: " + JSON.stringify(a1));
      if (!a2 || a2.upTo !== 2) throw new Error("ack c2 mal: " + JSON.stringify(a2));
      if (a1.seq !== 2 || a2.seq !== 2) throw new Error("seq final != 2");
      if (persistedSeq(id) !== 2) throw new Error("persistedSeq != 2");
      const loaded = await loadDocument(id);
      if (!loaded || loaded.updates.length !== 2) throw new Error("DB sin 2 updates");
    });

    await t.step("ensureLoaded trae snapshot+tail a memoria", async () => {
      resetStore();
      resetDurability();
      const id = freshId("t3-load");
      const doc = new Y.Doc();
      doc.getText("t").insert(0, "hola");
      enqueueUpdate(id, mockConn() as unknown as WebSocket, 1, Y.encodeStateAsUpdate(doc));
      await flushDocument(id);
      resetStore();
      const { doc: mem, seq } = await ensureLoaded(id);
      if (seq !== 1) throw new Error(`seq=${seq}, esperaba 1`);
      if (mem.getText("t").toString() !== "hola") throw new Error("memoria no convergió");
      if (!hasDoc(id)) throw new Error("doc no quedó en memoria");
    });

    await t.step("auto-flush por ventana drena la cola", async () => {
      resetStore();
      resetDurability();
      setFlushMs(10);
      try {
        const id = freshId("t3-auto");
        const c = mockConn();
        const doc = new Y.Doc();
        doc.getText("t").insert(0, "x");
        enqueueUpdate(id, c as unknown as WebSocket, 1, Y.encodeStateAsUpdate(doc));
        await new Promise((r) => setTimeout(r, 300));
        if (persistedSeq(id) !== 1) throw new Error("no hubo auto-flush");
        if (!lastAck(c)) throw new Error("sin ack tras auto-flush");
      } finally {
        setFlushMs(100);
      }
    });

    await t.step("evictIfEmpty persiste pendientes y libera memoria", async () => {
      resetStore();
      resetDurability();
      const id = freshId("t3-evict");
      await ensureLoaded(id);
      const doc = new Y.Doc();
      doc.getText("t").insert(0, "z");
      enqueueUpdate(id, mockConn() as unknown as WebSocket, 1, Y.encodeStateAsUpdate(doc));
      const room = new Set<WebSocket>();
      const evicted = await evictIfEmpty(id, room);
      if (!evicted) throw new Error("debió evictar con room vacía");
      if (hasDoc(id)) throw new Error("sigue en memoria");
      const loaded = await loadDocument(id);
      if (!loaded || loaded.updates.length !== 1) throw new Error("no persistió al evictar");
      const kept = await evictIfEmpty(id, new Set([{} as WebSocket]));
      if (kept) throw new Error("evictó con room ocupada");
    });

    resetDurability();
  },
});
