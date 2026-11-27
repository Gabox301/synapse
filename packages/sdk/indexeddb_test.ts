// Backend IndexedDB real (Etapa 5): roundtrip, cross-instancia (recarga) y clear.
// fake-indexeddb emula el browser; por sus timers propios va sin sanitizers.
import "npm:fake-indexeddb/auto";
import { assert, assertEquals } from "jsr:@std/assert";
import * as Y from "yjs";
import { indexedDbStorage } from "./indexeddb.ts";

function freshDb(): string {
  return `t5-idb-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
}

function sdkTest(name: string, fn: () => void | Promise<void>): void {
  Deno.test({ name, sanitizeOps: false, sanitizeResources: false, fn });
}

sdkTest("roundtrip guarda y recupera el snapshot", async () => {
  const db = freshDb();
  const doc = new Y.Doc();
  doc.getText("t").insert(0, "persistente");
  await indexedDbStorage(db).save("doc1", Y.encodeStateAsUpdate(doc));
  const loaded = await indexedDbStorage(db).load("doc1");
  assert(loaded);
  const probe = new Y.Doc();
  Y.applyUpdate(probe, loaded);
  assertEquals(probe.getText("t").toString(), "persistente");
});

sdkTest(
  "una instancia nueva lee lo de la anterior (simula recarga)",
  async () => {
    const db = freshDb();
    const doc = new Y.Doc();
    doc.getText("t").insert(0, "sobrevive");
    await indexedDbStorage(db).save("doc1", Y.encodeStateAsUpdate(doc));
    // Nueva instancia, misma DB: lo único que compartiría con un reload real.
    const loaded = await indexedDbStorage(db).load("doc1");
    assert(loaded);
    const probe = new Y.Doc();
    Y.applyUpdate(probe, loaded);
    assertEquals(probe.getText("t").toString(), "sobrevive");
  },
);

sdkTest("doc ausente devuelve null y clear borra", async () => {
  const db = freshDb();
  const storage = indexedDbStorage(db);
  assertEquals(await storage.load("nadie"), null);
  const doc = new Y.Doc();
  doc.getText("t").insert(0, "tmp");
  await storage.save("doc1", Y.encodeStateAsUpdate(doc));
  assert(await storage.load("doc1") !== null);
  if (storage.clear) await storage.clear("doc1");
  assertEquals(await storage.load("doc1"), null);
});
