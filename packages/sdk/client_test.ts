import { assertEquals } from "jsr:@std/assert";
import * as Y from "yjs";
import { SynapseClient } from "./client.ts";
import type { Transport } from "./transport.ts";

class MockTransport implements Transport {
  sent: Array<string | Uint8Array> = [];
  closedWith: number | undefined;
  private openCb: (() => void) | null = null;
  private msgCb: ((data: string | Uint8Array | ArrayBuffer) => void) | null = null;
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

function setup() {
  const t = new MockTransport();
  const events: string[] = [];
  const client = new SynapseClient({
    documentId: "doc1",
    ticket: "prueba1234",
    baseUrl: "ws://localhost:44100",
    createTransport: () => t,
    awarenessThrottleMs: 0,
    onJoined: (info) => events.push("joined:" + info.role + ":" + info.seq),
    onRemoteUpdate: () => events.push("remote-update"),
    onAck: (info) => events.push(`ack:${info.upTo}:${info.seq}`),
    onError: (code) => events.push("error:" + code),
  });
  return { t, events, client };
}

Deno.test("connect resuelve joined y abre con handshake SYNC_STEP1", async () => {
  const { t, events, client } = setup();
  const p = client.connect();
  t.emitOpen();
  // El cliente debe abrir con SYNC_STEP1 del state vector vacío
  const first = t.sent[0] as Uint8Array;
  assertEquals(first[0], 0x01);
  t.emitMessage(JSON.stringify({ type: "document:joined", payload: { documentId: "doc1", role: "editor", seq: 0 } }));
  const joined = await p;
  assertEquals(joined.role, "editor");
  assertEquals(events[0], "joined:editor:0");
});

Deno.test("sync: aplica STEP2 del servidor y responde STEP1 con STEP2 propio", () => {
  const { t, client } = setup();
  client.connect();
  t.emitOpen();
  t.emitMessage(JSON.stringify({ type: "document:joined", payload: { documentId: "doc1", role: "editor", seq: 0 } }));
  const serverDoc = new Y.Doc();
  serverDoc.getText("t").insert(0, "hola");
  const before = t.sent.length;
  // Servidor responde al STEP1 con [STEP2(diff), STEP1(su vector)]
  t.emitMessage(frame(0x02, Y.encodeStateAsUpdate(serverDoc)));
  assertEquals(client.doc.getText("t").toString(), "hola");
  t.emitMessage(frame(0x01, Y.encodeStateVector(serverDoc)));
  // El cliente debe responder con su STEP2 (puede ser vacío pero existe)
  const replies = t.sent.slice(before).filter((m) => typeof m !== "string") as Uint8Array[];
  assertEquals(replies.length, 1);
  assertEquals(replies[0][0], 0x02);
});

Deno.test("update local se envía con cseq incremental y queda pendiente", () => {
  const { t, client } = setup();
  client.connect();
  t.emitOpen();
  t.emitMessage(JSON.stringify({ type: "document:joined", payload: { documentId: "doc1", role: "editor", seq: 0 } }));
  client.doc.getText("t").insert(0, "a");
  client.doc.getText("t").insert(1, "b");
  const updates = (t.sent.filter((m) => typeof m !== "string") as Uint8Array[]).filter((m) => m[0] === 0x03);
  assertEquals(updates.length, 2);
  const cseqOf = (m: Uint8Array) => new DataView(m.buffer, m.byteOffset + 1, 4).getUint32(0, false);
  assertEquals(cseqOf(updates[0]), 1);
  assertEquals(cseqOf(updates[1]), 2);
  assertEquals(client.pendingCount, 2);
});

Deno.test("UPDATE remoto (cseq 0) se aplica y se emite sin reenviar", () => {
  const { t, events, client } = setup();
  client.connect();
  t.emitOpen();
  t.emitMessage(JSON.stringify({ type: "document:joined", payload: { documentId: "doc1", role: "editor", seq: 0 } }));
  const before = t.sent.length;
  const other = new Y.Doc();
  other.getText("t").insert(0, "remoto");
  t.emitMessage(frame(0x03, Y.encodeStateAsUpdate(other), 0));
  assertEquals(client.doc.getText("t").toString(), "remoto");
  assertEquals(events.includes("remote-update"), true);
  // Aplicar remoto no debe generar UPDATE saliente (origen interno)
  const after = (t.sent.slice(before).filter((m) => typeof m !== "string") as Uint8Array[]).filter((m) => m[0] === 0x03);
  assertEquals(after.length, 0);
});

Deno.test("reconnect ignora el close del transporte viejo", async () => {
  const transports: MockTransport[] = [];
  const events: string[] = [];
  const client = new SynapseClient({
    documentId: "doc1",
    ticket: "prueba1234",
    baseUrl: "ws://localhost:44100",
    createTransport: () => {
      const t = new MockTransport();
      transports.push(t);
      return t;
    },
    awarenessThrottleMs: 0,
    onJoined: (info) => events.push("joined:" + info.role),
  });
  const p1 = client.connect();
  transports[0].emitOpen();
  transports[0].emitMessage(JSON.stringify({ type: "document:joined", payload: { documentId: "doc1", role: "editor", seq: 0 } }));
  await p1;
  const p2 = client.reconnect();
  // El close del transporte viejo llega DESPUÉS de re-conectar: no debe matar el join nuevo.
  transports[0].close(); // close del transporte viejo tras re-conectar
  transports[1].emitOpen();
  transports[1].emitMessage(JSON.stringify({ type: "document:joined", payload: { documentId: "doc1", role: "editor", seq: 1 } }));
  const joined = await p2;
  assertEquals(joined.seq, 1);
  assertEquals(events, ["joined:editor", "joined:editor"]);
});

Deno.test("document:ack confirma pendientes y notifica onAck", () => {
  const { t, events, client } = setup();
  client.connect();
  t.emitOpen();
  t.emitMessage(JSON.stringify({ type: "document:joined", payload: { documentId: "doc1", role: "editor", seq: 0 } }));
  client.doc.getText("t").insert(0, "a");
  client.doc.getText("t").insert(1, "b");
  assertEquals(client.pendingCount, 2);
  t.emitMessage(JSON.stringify({ type: "document:ack", payload: { upTo: 1, seq: 10 } }));
  assertEquals(client.pendingCount, 1);
  t.emitMessage(JSON.stringify({ type: "document:ack", payload: { upTo: 2, seq: 11 } }));
  assertEquals(client.pendingCount, 0);
  assertEquals(events.slice(-2), ["ack:1:10", "ack:2:11"]);
});

Deno.test("frame desconocido emite error sin romper la conexión", () => {
  const { t, events, client } = setup();
  client.connect();
  t.emitOpen();
  t.emitMessage(JSON.stringify({ type: "document:joined", payload: { documentId: "doc1", role: "editor", seq: 0 } }));
  t.emitMessage(new Uint8Array([0xff, 0x01]).buffer);
  assertEquals(events.some((e) => e.startsWith("error:")), true);
  assertEquals(t.closedWith, undefined);
});

Deno.test("mensajes previos al open se encolan y salen en orden tras STEP1", async () => {
  const { t, client } = setup();
  const p = client.connect();
  client.doc.getText("t").insert(0, "x");
  assertEquals(t.sent.length, 0);
  t.emitOpen();
  assertEquals((t.sent[0] as Uint8Array)[0], 0x01);
  const updates = (t.sent.slice(1).filter((m) => typeof m !== "string") as Uint8Array[])
    .filter((m) => m[0] === 0x03);
  assertEquals(updates.length, 1);
  t.emitMessage(JSON.stringify({ type: "document:joined", payload: { documentId: "doc1", role: "editor", seq: 0 } }));
  await p;
});

Deno.test("awareness local viaja en frame 0x04", () => {
  const { t, client } = setup();
  client.connect();
  t.emitOpen();
  t.emitMessage(JSON.stringify({ type: "document:joined", payload: { documentId: "doc1", role: "editor", seq: 0 } }));
  const before = t.sent.length;
  client.setPresence({ cursor: 5 });
  const frames = t.sent.slice(before).filter((m) => typeof m !== "string") as Uint8Array[];
  assertEquals(frames.length, 1);
  assertEquals(frames[0][0], 0x04);
});
