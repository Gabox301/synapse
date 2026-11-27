// Fuzzing de convergencia CRDT (Etapa 5 T2): N clientes editan concurrentemente
// a través del pipeline real (frames SNP + handleBinary + relay), con retrasos,
// pérdidas, duplicados y reordenamientos. Determinista: PRNG con semilla fija.
import { assertEquals } from "jsr:@std/assert";
import * as Y from "yjs";
import {
  decodeFrame,
  encodeSyncStep1,
  encodeSyncStep2,
  encodeUpdate,
} from "../../../packages/protocol/frames.ts";
import { handleBinary } from "./handler.ts";
import type { ConnState } from "./handler.ts";
import { getOrCreateDoc, resetStore } from "./documents.ts";

/** PRNG determinista (mulberry32). */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

interface SimClient {
  doc: Y.Doc;
  cseq: number;
  inbox: Array<{ at: number; frame: Uint8Array }>;
  pendingOut: Uint8Array[];
}

interface ServerMsg {
  at: number;
  kind: "to-server" | { to: number };
  frame: Uint8Array;
}

function makeState(docId: string): ConnState {
  return {
    documentId: docId,
    unknownCount: 0,
    awarenessIds: new Set<number>(),
    rateDrops: 0,
  };
}

function randomEdit(rng: () => number, doc: Y.Doc): void {
  const t = doc.getText("t");
  if (t.length === 0 || rng() < 0.65) {
    const ch = String.fromCharCode(97 + Math.floor(rng() * 26));
    const pos = Math.floor(rng() * (t.length + 1));
    t.insert(pos, ch);
  } else {
    const pos = Math.floor(rng() * t.length);
    const len = Math.min(t.length - pos, 1 + Math.floor(rng() * 3));
    t.delete(pos, len);
  }
}

interface FuzzOpts {
  seed: number;
  clients: number;
  ops: number;
  maxDelay: number;
  dropProb: number;
  dupProb: number;
}

function runScenario(docId: string, o: FuzzOpts): string[] {
  resetStore();
  const rng = mulberry32(o.seed);
  const serverDoc = getOrCreateDoc(docId);
  const serverSt = makeState(docId);
  const clients: SimClient[] = [];
  for (let i = 0; i < o.clients; i++) {
    const doc = new Y.Doc();
    const c: SimClient = { doc, cseq: 0, inbox: [], pendingOut: [] };
    doc.on("update", (u: Uint8Array) => c.pendingOut.push(u));
    clients.push(c);
  }

  // Sincronización inicial de cada cliente contra el servidor.
  for (const c of clients) {
    const r = handleBinary(
      encodeSyncStep1(Y.encodeStateVector(c.doc)),
      serverSt,
    );
    for (const f of r.replies) {
      const d = decodeFrame(f);
      if (d.type === 0x02) Y.applyUpdate(c.doc, d.payload);
    }
  }

  const net: ServerMsg[] = [];
  const send = (at: number, to: ServerMsg["kind"], frame: Uint8Array) => {
    if (rng() < o.dropProb) return; // pérdida
    let when = at;
    if (rng() < 0.5) when += Math.floor(rng() * (o.maxDelay + 1)); // retraso/reorden
    net.push({ at: when, kind: to, frame });
    if (rng() < o.dupProb) {
      net.push({
        at: when + Math.floor(rng() * (o.maxDelay + 1)),
        kind: to,
        frame,
      }); // duplicado
    }
  };

  // Fase de caos: ediciones concurrentes.
  for (let tick = 0; tick < o.ops; tick++) {
    const ci = Math.floor(rng() * o.clients);
    const c = clients[ci];
    randomEdit(rng, c.doc);
    for (const u of c.pendingOut.splice(0)) {
      c.cseq += 1;
      send(tick, "to-server", encodeUpdate(c.cseq, u));
    }
    // Entregar lo vencido.
    net.sort((a, b) => a.at - b.at);
    while (net.length > 0 && net[0].at <= tick) {
      const m = net.shift()!;
      if (m.kind === "to-server") {
        const out = handleBinary(m.frame, serverSt);
        for (const b of out.broadcast) {
          clients.forEach((cc, idx) => {
            if (cc !== clients[ci]) send(tick, { to: idx }, b);
          });
        }
      } else {
        const cc = clients[(m.kind as { to: number }).to];
        const d = decodeFrame(m.frame);
        if (d.type === 0x03) Y.applyUpdate(cc.doc, d.payload);
      }
    }
  }

  // Drenar sin más caos: todo lo pendiente se entrega (idempotente).
  net.sort((a, b) => a.at - b.at);
  while (net.length > 0) {
    const m = net.shift()!;
    if (m.kind === "to-server") {
      const out = handleBinary(m.frame, serverSt);
      for (const b of out.broadcast) {
        const d = decodeFrame(b);
        if (d.type === 0x03) {
          for (const cc of clients) Y.applyUpdate(cc.doc, d.payload);
        }
      }
    } else {
      const cc = clients[(m.kind as { to: number }).to];
      const d = decodeFrame(m.frame);
      if (d.type === 0x03) Y.applyUpdate(cc.doc, d.payload);
    }
  }

  // Resync final por state vector (confiable). Se repite hasta punto fijo:
  // el push de un cliente (rama 0x01) aterriza en el servidor DESPUÉS de que
  // los clientes anteriores ya se sincronizaron, así que una sola pasada no
  // converge cuando hubo pérdidas de subida. Acotado: 2 rondas bastan
  // (ronda 1: todos los pushes llegan al servidor; ronda 2: todos pull).
  for (let round = 0; round < 10; round++) {
    for (const [idx, c] of clients.entries()) {
      const svBefore = Y.encodeStateVector(c.doc);
      const r = handleBinary(encodeSyncStep1(svBefore), serverSt);
      for (const f of r.replies) {
        const d = decodeFrame(f);
        if (d.type === 0x02) {
          Y.applyUpdate(c.doc, d.payload);
        } else if (d.type === 0x01) {
          const back = encodeSyncStep2(Y.encodeStateAsUpdate(c.doc, d.payload));
          const rr = handleBinary(back, serverSt);
          if (rr.errorJson) {
            throw new Error(`resync push rechazado c${idx}: ${rr.errorJson}`);
          }
        }
      }
    }
    const synced = [serverDoc, ...clients.map((c) => c.doc)]
      .map((d) => d.getText("t").toString());
    if (synced.every((t) => t === synced[0])) break;
  }
  return [serverDoc, ...clients.map((c) => c.doc)].map((d) =>
    d.getText("t").toString()
  );
}

Deno.test("convergencia: 2 clientes, 60 ops, caos moderado", () => {
  const texts = runScenario("fuzz-a", {
    seed: 42,
    clients: 2,
    ops: 60,
    maxDelay: 5,
    dropProb: 0.15,
    dupProb: 0.05,
  });
  for (const t of texts) assertEquals(t, texts[0]);
});

Deno.test("convergencia: 4 clientes, 200 ops, caos alto + reorden", () => {
  const texts = runScenario("fuzz-b", {
    seed: 1337,
    clients: 4,
    ops: 200,
    maxDelay: 12,
    dropProb: 0.25,
    dupProb: 0.08,
  });
  for (const t of texts) assertEquals(t, texts[0]);
});

Deno.test("convergencia: 6 clientes, 120 ops, pérdidas severas", () => {
  const texts = runScenario("fuzz-c", {
    seed: 7,
    clients: 6,
    ops: 120,
    maxDelay: 8,
    dropProb: 0.4,
    dupProb: 0.1,
  });
  for (const t of texts) assertEquals(t, texts[0]);
});
