// Tests de integración de persistence.ts (Etapa 3 T2). Requieren PG arriba
// (`docker compose up -d`); sin PG se saltean con aviso, igual que migrate_test.
import * as Y from "yjs";
import {
  closePool,
  compactBefore,
  ensureDocument,
  listDocumentsForUser,
  loadDocument,
  saveBatch,
  saveSnapshot,
  withDocLock,
} from "./persistence.ts";
import { createUser } from "../auth/sessions.ts";
import { addDocumentMember, createDocument } from "../auth/access.ts";

const SKIP_MSG = "SKIP: sin postgres (docker compose up -d postgres)";
let skipped = false;

async function pgUp(): Promise<boolean> {
  try {
    await ensureDocument(`probe-${Date.now()}`);
    return true;
  } catch {
    return false;
  }
}

async function freshDoc(prefix: string): Promise<string> {
  const id = `${prefix}-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
  await ensureDocument(id, { title: prefix });
  return id;
}

function updatesOf(doc: Y.Doc, count: number, from = 0): Uint8Array[] {
  const out: Uint8Array[] = [];
  for (let i = 0; i < count; i++) {
    doc.getText("t").insert(from + i, String(i));
    out.push(Y.encodeStateAsUpdate(doc));
  }
  return out;
}

Deno.test({
  name: "persistence/**",
  ignore: false,
  async fn(t) {
    if (!await pgUp()) {
      console.log(SKIP_MSG);
      skipped = true;
      return;
    }

    await t.step("saveBatch asigna seqs contiguos desde 1", async () => {
      const id = await freshDoc("t2-seq");
      const doc = new Y.Doc();
      const seqs = await saveBatch(id, updatesOf(doc, 3).map((data) => ({ data })));
      assertSeqs(seqs, [1, 2, 3]);
      const loaded = await loadDocument(id);
      if (!loaded) throw new Error("doc no encontrado tras saveBatch");
      if (loaded.lastSeq !== 3) throw new Error(`lastSeq=${loaded.lastSeq}, esperaba 3`);
      await compactBefore(id, 1000);
    });

    await t.step("batches concurrentes no duplican seq", async () => {
      const id = await freshDoc("t2-conc");
      const doc = new Y.Doc();
      const mk = () => updatesOf(doc, 2).map((data) => ({ data }));
      const [a, b] = await Promise.all([saveBatch(id, mk()), saveBatch(id, mk())]);
      const all = [...a, ...b].sort((x, y) => x - y);
      assertSeqs(all, [1, 2, 3, 4]);
      await compactBefore(id, 1000);
    });

    await t.step("loadDoc: snapshot + tail convergen", async () => {
      const id = await freshDoc("t2-load");
      const doc = new Y.Doc();
      doc.getText("t").insert(0, "hola");
      await saveBatch(id, [{ data: Y.encodeStateAsUpdate(doc) }]);
      await saveSnapshot(id, Y.encodeStateAsUpdate(doc), 1, "auto");
      doc.getText("t").insert(4, " mundo");
      await saveBatch(id, [{ data: Y.encodeStateAsUpdate(doc) }]);

      const loaded = await loadDocument(id);
      if (!loaded || !loaded.snapshot) throw new Error("snapshot no encontrado");
      if (loaded.snapshot.lastSeq !== 1) throw new Error("snapshot.lastSeq != 1");
      if (loaded.updates.length !== 1) throw new Error(`tail=${loaded.updates.length}, esperaba 1`);

      const replica = new Y.Doc();
      Y.applyUpdate(replica, loaded.snapshot.state);
      for (const u of loaded.updates) Y.applyUpdate(replica, u);
      if (replica.getText("t").toString() !== "hola mundo") {
        throw new Error("no converge: " + replica.getText("t").toString());
      }
      await compactBefore(id, 1000);
    });

    await t.step("compactBefore borra solo lo anterior al corte", async () => {
      const id = await freshDoc("t2-compact");
      const doc = new Y.Doc();
      await saveBatch(id, updatesOf(doc, 4).map((data) => ({ data })));
      const deleted = await compactBefore(id, 3);
      if (deleted !== 2) throw new Error(`deleted=${deleted}, esperaba 2`);
      const loaded = await loadDocument(id);
      if (!loaded || loaded.updates.length !== 2) throw new Error("tail incorrecta tras compact");
      await compactBefore(id, 1000);
    });

    await t.step("withDocLock ejecuta la fn bajo lock", async () => {
      const id = await freshDoc("t2-lock");
      const got = await withDocLock(id, async () => "ok");
      if (got !== "ok") throw new Error("withDocLock no devolvió el valor");
      const [r1, r2] = await Promise.all([
        withDocLock(id, async () => 1),
        withDocLock(id, async () => 2),
      ]);
      if (r1 + r2 !== 3) throw new Error("locks concurrentes fallaron");
      await compactBefore(id, 1000);
    });

    await closePool();
    if (skipped) throw new Error("unreachable");
  },
});

function assertSeqs(actual: number[], expected: number[]): void {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`seqs=${JSON.stringify(actual)}, esperaba ${JSON.stringify(expected)}`);
  }
}

Deno.test("persistence/list-mine", async (t) => {
  if (!await pgUp()) {
    console.log(SKIP_MSG);
    return;
  }

  await t.step("lista solo docs visibles con rol", async () => {
    const ts = Date.now();
    const u1 = await createUser({ email: `mine-a-${ts}@x.test`, passwordHash: "x" });
    const u2 = await createUser({ email: `mine-b-${ts}@x.test`, passwordHash: "x" });
    const own = await createDocument({ title: "propio", createdBy: u1 });
    const shared = await createDocument({ title: "compartido", createdBy: u2 });
    await addDocumentMember(shared, u1, "editor");
    const alien = await createDocument({ title: "ajeno", createdBy: u2 });
    const mine = await listDocumentsForUser(u1);
    const ids = mine.map((d) => d.id);
    if (!ids.includes(own) || !ids.includes(shared)) {
      throw new Error(`faltan propios: ${JSON.stringify(ids)}`);
    }
    if (ids.includes(alien)) throw new Error("doc ajeno listado");
    const roles = Object.fromEntries(mine.map((d) => [d.id, d.role]));
    if (roles[own] !== "owner" || roles[shared] !== "editor") {
      throw new Error(`roles mal: ${JSON.stringify(roles)}`);
    }
  });

  await closePool();
});
