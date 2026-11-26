// Tests de durability.ts (Etapa 3 T3): cola, flush, acks y load contra PG real.
// Requieren PG arriba; sin PG se saltean con aviso.
import * as Y from "yjs";
import { hasDoc, resetStore } from "./documents.ts";
import { loadDocument } from "./persistence.ts";
import { listSnapshots } from "./persistence.ts";
import {
  createNamedSnapshot,
  enforceRetention,
  ensureLoaded,
  enqueueUpdate,
  evictIfEmpty,
  flushDocument,
  persistedSeq,
  resetDurability,
  restoreSnapshot,
  setAutoSnapshotEvery,
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

Deno.test({
  name: "durability/snapshots/**",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn(t) {
    if (!await pgUp()) {
      console.log("SKIP: sin postgres (docker compose up -d postgres)");
      return;
    }

    await t.step("auto-snapshot al alcanzar el umbral", async () => {
      resetStore();
      resetDurability();
      setAutoSnapshotEvery(3);
      try {
        const id = freshId("t4-auto");
        const doc = new Y.Doc();
        for (let i = 0; i < 3; i++) {
          doc.getText("t").insert(i, String(i));
          enqueueUpdate(id, mockConn() as unknown as WebSocket, i + 1, Y.encodeStateAsUpdate(doc));
        }
        await flushDocument(id);
        const snaps = await listSnapshots(id);
        const auto = snaps.filter((s) => s.kind === "auto");
        if (auto.length !== 1) throw new Error(`esperaba 1 auto, hay ${auto.length}`);
        if (auto[0].lastSeq !== 3) throw new Error(`lastSeq=${auto[0].lastSeq}, esperaba 3`);
      } finally {
        setAutoSnapshotEvery(100);
      }
    });

    await t.step("named + restore revierte texto", async () => {
      resetStore();
      resetDurability();
      const id = freshId("t4-restore");
      const doc = await (async () => {
        const { doc } = await ensureLoaded(id);
        return doc;
      })();
      doc.getText("t").insert(0, "hello");
      enqueueUpdate(id, mockConn() as unknown as WebSocket, 1, Y.encodeStateAsUpdate(doc));
      await flushDocument(id);
      const v1 = await createNamedSnapshot(id, "v1");
      doc.getText("t").insert(5, " world");
      enqueueUpdate(id, mockConn() as unknown as WebSocket, 2, Y.encodeStateAsUpdate(doc));
      await flushDocument(id);
      const { restoreSeq } = await restoreSnapshot(id, v1, {
        roots: [{ name: "t", kind: "text" }],
      });
      if (restoreSeq <= 2) throw new Error(`restoreSeq=${restoreSeq}, esperaba > 2`);
      if (doc.getText("t").toString() !== "hello") {
        throw new Error("no revirtió: " + doc.getText("t").toString());
      }
      resetStore();
      const reloaded = await loadDocument(id);
      if (!reloaded) throw new Error("doc perdido tras restore");
      const replica = new Y.Doc();
      if (reloaded.snapshot) Y.applyUpdate(replica, reloaded.snapshot.state);
      for (const u of reloaded.updates) Y.applyUpdate(replica, u);
      if (replica.getText("t").toString() !== "hello") {
        throw new Error("reload no converge a hello: " + replica.getText("t").toString());
      }
      const snaps = await listSnapshots(id);
      if (!snaps.some((s) => s.kind === "named" && s.label === "v1")) {
        throw new Error("v1 no figura como named");
      }
      if (!snaps.some((s) => (s.label ?? "").startsWith("pre-restore"))) {
        throw new Error("falta backup pre-restore");
      }
    });

    await t.step("restore funciona con XmlFragment (forma del editor)", async () => {
      resetStore();
      resetDurability();
      const id = freshId("t4-xml");
      const { doc } = await ensureLoaded(id);
      const frag = doc.getXmlFragment("prosemirror");
      frag.insert(0, [new Y.XmlText("hi")]);
      enqueueUpdate(id, mockConn() as unknown as WebSocket, 1, Y.encodeStateAsUpdate(doc));
      await flushDocument(id);
      const v1 = await createNamedSnapshot(id, "v1");
      frag.insert(1, [new Y.XmlText(" there")]);
      enqueueUpdate(id, mockConn() as unknown as WebSocket, 2, Y.encodeStateAsUpdate(doc));
      await flushDocument(id);
      await restoreSnapshot(id, v1, { roots: [{ name: "prosemirror", kind: "xmlfragment" }] });
      const json = JSON.stringify(doc.getXmlFragment("prosemirror").toJSON());
      if (!json.includes("hi") || json.includes("there")) {
        throw new Error("restore xml incorrecto: " + json);
      }
    });

    await t.step("enforceRetention recorta con snapshot y ventana", async () => {
      resetStore();
      resetDurability();
      const id = freshId("t4-ret");
      const doc = new Y.Doc();
      const expected: string[] = [];
      for (let i = 0; i < 5; i++) {
        doc.getText("t").insert(i, String(i));
        expected.push(String(i));
        enqueueUpdate(id, mockConn() as unknown as WebSocket, i + 1, Y.encodeStateAsUpdate(doc));
      }
      await flushDocument(id);
      const want = expected.join("");
      // Sin snapshot previo: lo crea para dar cobertura y recorta a la ventana.
      const deleted = await enforceRetention(id, 2);
      if (deleted !== 3) throw new Error(`deleted=${deleted}, esperaba 3`);
      resetStore();
      const reloaded = await loadDocument(id);
      if (!reloaded) throw new Error("doc perdido tras compact");
      const replica = new Y.Doc();
      if (reloaded.snapshot) Y.applyUpdate(replica, reloaded.snapshot.state);
      for (const u of reloaded.updates) Y.applyUpdate(replica, u);
      if (replica.getText("t").toString() !== want) {
        throw new Error("reload no converge tras compact: " + replica.getText("t").toString());
      }
      // Con snapshot + keep amplio: no borra nada.
      await createNamedSnapshot(id, "full");
      const deleted2 = await enforceRetention(id, 10);
      if (deleted2 !== 0) throw new Error(`deleted=${deleted2}, esperaba 0`);
      // Con keep chico: conserva solo el último update.
      const deleted3 = await enforceRetention(id, 1);
      if (deleted3 !== 1) throw new Error(`deleted=${deleted3}, esperaba 1`);
      resetStore();
      const reloaded2 = await loadDocument(id);
      if (!reloaded2) throw new Error("doc perdido");
      const replica2 = new Y.Doc();
      if (reloaded2.snapshot) Y.applyUpdate(replica2, reloaded2.snapshot.state);
      for (const u of reloaded2.updates) Y.applyUpdate(replica2, u);
      if (replica2.getText("t").toString() !== want) {
        throw new Error("reload no converge tras 2do compact");
      }
    });

    resetDurability();
  },
});
