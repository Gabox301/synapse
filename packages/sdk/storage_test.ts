// Persistencia local del cliente (Etapa 5 T3): hidratación antes del
// handshake, guardado throttled + al cerrar, y reconciliación offline.
import { assert, assertEquals } from "jsr:@std/assert";
import * as Y from "yjs";
import { SynapseClient } from "./client.ts";
import type { SynapseClientOptions } from "./client.ts";
import { memoryStorage } from "./storage.ts";
import type { SynapseStorage } from "./storage.ts";
import type { Transport } from "./transport.ts";
import { decodeFrame } from "../protocol/frames.ts";

class MockTransport implements Transport {
  sent: Array<string | Uint8Array> = [];
  closedWith: number | undefined;
  private openCb: (() => void) | null = null;
  private msgCb: ((data: string | Uint8Array | ArrayBuffer) => void) | null =
    null;
  private closeCb: ((code: number) => void) | null = null;

  send(data: string | Uint8Array): void {
    this.sent.push(data);
  }
  close(code?: number): void {
    this.closedWith = code;
    this.closeCb?.(code ?? 1000);
  }
  onOpen(cb: () => void): void {
    this.openCb = cb;
  }
  onMessage(cb: (data: string | Uint8Array | ArrayBuffer) => void): void {
    this.msgCb = cb;
  }
  onClose(cb: (code: number) => void): void {
    this.closeCb = cb;
  }
  emitOpen(): void {
    this.openCb?.();
  }
  emitMessage(data: string | Uint8Array | ArrayBuffer): void {
    this.msgCb?.(data);
  }
}

function frame(type: number, body: Uint8Array, cseq?: number): Uint8Array {
  const head = cseq === undefined ? new Uint8Array([type]) : new Uint8Array(5);
  if (cseq !== undefined) {
    head[0] = type;
    new DataView(head.buffer).setUint32(1, cseq, false);
  }
  const out = new Uint8Array(head.length + body.length);
  out.set(head, 0);
  out.set(body, head.length);
  return out;
}

const JOINED = JSON.stringify({
  type: "document:joined",
  payload: { documentId: "doc1", role: "editor", seq: 0 },
});

// Los tests instancian SynapseClient, cuyo Awareness (y-protocols) mantiene
// un setInterval propio: no es un leak del código bajo test, así que se
// desactiva el sanitizer como ya hace durability_test.ts en el servidor.
function sdkTest(name: string, fn: () => void | Promise<void>): void {
  Deno.test({ name, sanitizeOps: false, sanitizeResources: false, fn });
}

function setup(
  storage: SynapseStorage,
  extra?: Partial<SynapseClientOptions>,
) {
  const t = new MockTransport();
  const events: string[] = [];
  const client = new SynapseClient({
    documentId: "doc1",
    ticket: "prueba1234",
    baseUrl: "ws://localhost:44100",
    createTransport: () => t,
    awarenessThrottleMs: 0,
    storageThrottleMs: 0,
    storage,
    onJoined: (info) => events.push("joined:" + info.role),
    onError: (code, message) => events.push(`error:${code}:${message}`),
    ...extra,
  });
  return { t, events, client };
}

sdkTest("storage hidrata el doc antes del handshake SYNC_STEP1", async () => {
  const seed = new Y.Doc();
  seed.getText("t").insert(0, "hola");
  const snap = Y.encodeStateAsUpdate(seed);
  const storage = memoryStorage();
  storage.save("doc1", snap);

  const { t, client } = setup(storage);
  assertEquals(client.doc.getText("t").toString(), "");
  const p = client.connect();
  // Carga síncrona (memoria): el doc ya está hidratado antes del open.
  assertEquals(client.doc.getText("t").toString(), "hola");
  t.emitOpen();
  const first = t.sent[0] as Uint8Array;
  assertEquals(first[0], 0x01);
  // El STEP1 lleva un state vector no vacío (incluye el snapshot).
  assert(decodeFrame(first).payload.length > 0);
  t.emitMessage(JOINED);
  await p;
});

sdkTest("storage asíncrono también hidrata antes del handshake", async () => {
  const seed = new Y.Doc();
  seed.getText("t").insert(0, "async");
  const snap = Y.encodeStateAsUpdate(seed);
  const asyncStorage: SynapseStorage = {
    load: (_id) => Promise.resolve(snap),
    save: (_id, _state) => Promise.resolve(),
  };
  const { t, client } = setup(asyncStorage);
  const p = client.connect();
  await new Promise((r) => setTimeout(r, 0));
  assertEquals(client.doc.getText("t").toString(), "async");
  t.emitOpen();
  assertEquals((t.sent[0] as Uint8Array)[0], 0x01);
  t.emitMessage(JOINED);
  await p;
});

sdkTest("edición offline persiste y reconcilia al reconectar", async () => {
  const storage = memoryStorage();

  // Cliente 1: online, edita "abc", cierra (guarda snapshot).
  const s1 = setup(storage);
  const p1 = s1.client.connect();
  s1.t.emitOpen();
  s1.t.emitMessage(JOINED);
  await p1;
  s1.client.doc.getText("t").insert(0, "abc");
  s1.client.close();

  // Mientras tanto el "servidor" avanzó con otro cliente: "XYZ".
  const serverDoc = new Y.Doc();
  serverDoc.getText("t").insert(0, "XYZ");

  // Cliente 2 (mismo storage, proceso "reiniciado"): hidrata "abc".
  const s2 = setup(storage);
  assertEquals(s2.client.doc.getText("t").toString(), "");
  const p2 = s2.client.connect();
  assertEquals(s2.client.doc.getText("t").toString(), "abc");
  s2.t.emitOpen();
  s2.t.emitMessage(JOINED);
  await p2;

  // Servidor envía su diff (STEP2) y pide el del cliente (STEP1).
  s2.t.emitMessage(frame(0x02, Y.encodeStateAsUpdate(serverDoc)));
  s2.t.emitMessage(frame(0x01, Y.encodeStateVector(serverDoc)));
  // El cliente responde con su STEP2: aplicarlo al servidor (vía red ideal).
  const replies = (s2.t.sent.filter((m) =>
    typeof m !== "string"
  ) as Uint8Array[])
    .filter((m) => m[0] === 0x02);
  assert(replies.length > 0);
  for (const r of replies) Y.applyUpdate(serverDoc, decodeFrame(r).payload);

  const serverText = serverDoc.getText("t").toString();
  const clientText = s2.client.doc.getText("t").toString();
  assertEquals(clientText, serverText);
  assert(clientText.includes("abc"));
  assert(clientText.includes("XYZ"));
  s2.client.close();
});

sdkTest("snapshot corrupto no rompe el connect", async () => {
  const storage = memoryStorage();
  storage.save("doc1", new Uint8Array([0x01, 0x02, 0x03]));
  const { t, events, client } = setup(storage);
  const p = client.connect();
  t.emitOpen();
  t.emitMessage(JOINED);
  await p;
  assert(events.some((e) => e.startsWith("error:INVALID_UPDATE")));
  assertEquals(client.doc.getText("t").toString(), "");
});

sdkTest("guardado con throttle + guardado final al cerrar", () => {
  let saves = 0;
  let lastSaved: Uint8Array | null = null;
  const base = memoryStorage();
  const counting: SynapseStorage = {
    load: (id) => base.load(id),
    save: (id, state) => {
      saves += 1;
      lastSaved = state;
      return base.save(id, state);
    },
  };
  const { t, client } = setup(counting, { storageThrottleMs: 60_000 });
  client.connect();
  t.emitOpen();
  t.emitMessage(JOINED);
  client.doc.getText("t").insert(0, "a");
  client.doc.getText("t").insert(1, "b");
  client.doc.getText("t").insert(2, "c");
  assertEquals(saves, 1);
  client.close();
  assertEquals(saves, 2);
  // El último snapshot guardado hidrata el texto completo.
  const probe = new Y.Doc();
  Y.applyUpdate(probe, lastSaved!);
  assertEquals(probe.getText("t").toString(), "abc");
});
