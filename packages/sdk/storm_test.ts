// Storm de frames inválidos (Etapa 5 T3): el cliente no cae, no cierra,
// reporta códigos fieles y sigue operativo. Sin sanitizers por el intervalo
// propio de Awareness (igual que storage_test.ts).
import { assert, assertEquals } from "jsr:@std/assert";
import * as Y from "yjs";
import { SynapseClient } from "./client.ts";
import type { Transport } from "./transport.ts";

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

function setup() {
  const t = new MockTransport();
  const events: string[] = [];
  const client = new SynapseClient({
    documentId: "doc1",
    ticket: "prueba1234",
    baseUrl: "ws://localhost:44100",
    createTransport: () => t,
    awarenessThrottleMs: 0,
    onRemoteUpdate: () => events.push("remote-update"),
    onError: (code) => events.push("error:" + code),
  });
  return { t, events, client };
}

Deno.test("close libera el intervalo de Awareness (pasa con sanitizers)", () => {
  const { t, client } = setup();
  client.connect();
  t.emitOpen();
  t.emitMessage(JOINED);
  client.doc.getText("t").insert(0, "x");
  client.close();
});

Deno.test("reconnect tras close recrea Awareness y sigue sincronizando presencia", async () => {
  const { t, client } = setup();
  client.connect();
  t.emitOpen();
  t.emitMessage(JOINED);
  client.close();
  const p = client.reconnect();
  t.emitOpen();
  t.emitMessage(JOINED);
  await p;
  const before = t.sent.length;
  client.setPresence({ cursor: 3 });
  const frames =
    (t.sent.slice(before).filter((m) => typeof m !== "string") as Uint8Array[])
      .filter((m) => m[0] === 0x04);
  assertEquals(frames.length, 1);
  client.close();
});

Deno.test("storm de frames inválidos no tumba la conexión ni el doc", () => {
  const { t, events, client } = setup();
  client.connect();
  t.emitOpen();
  t.emitMessage(JOINED);
  client.doc.getText("t").insert(0, "base");

  const big = new Uint8Array(65537);
  big[0] = 0x03;
  const garbage = new Uint8Array(32);
  for (let i = 0; i < garbage.length; i++) garbage[i] = (i * 37 + 11) & 0xff;

  t.emitMessage(new Uint8Array([0xff, 0x01])); // tipo desconocido
  t.emitMessage(new Uint8Array([0x03, 0x00])); // UPDATE truncado
  t.emitMessage(new Uint8Array(0)); // vacío
  t.emitMessage(big); // excede 65536
  t.emitMessage(frame(0x03, garbage, 0)); // payload Y inválido
  t.emitMessage("{ esto no es json"); // control inválido

  assert(
    events.some((e) => e.startsWith("error:UNKNOWN_MESSAGE")),
    `faltan UNKNOWN: ${events}`,
  );
  assert(
    events.some((e) => e.startsWith("error:MESSAGE_TOO_LARGE")),
    `faltan TOO_LARGE: ${events}`,
  );
  assert(
    events.some((e) => e.startsWith("error:INVALID_UPDATE")),
    `faltan INVALID: ${events}`,
  );
  assertEquals(t.closedWith, undefined);
  assertEquals(client.doc.getText("t").toString(), "base");

  // El cliente sigue operativo: un STEP2 válido se aplica normal.
  const other = new Y.Doc();
  other.getText("t").insert(0, "ok");
  t.emitMessage(frame(0x02, Y.encodeStateAsUpdate(other)));
  const text = client.doc.getText("t").toString();
  assert(text.includes("base") && text.includes("ok"), text);
  client.close();
});

Deno.test("update local gigante no revienta el editor", () => {
  const { t, events, client } = setup();
  client.connect();
  t.emitOpen();
  t.emitMessage(JOINED);
  // El insert local entra al doc Yjs; lo que falla es el framing, sin lanzar.
  client.doc.getText("t").insert(0, "x".repeat(70000));
  assert(
    events.some((e) => e.startsWith("error:MESSAGE_TOO_LARGE")),
    `eventos: ${events}`,
  );
  assertEquals(client.pendingCount, 0);
  // El siguiente update chico sale normal y no hereda el cseq del fallido.
  client.doc.getText("t").insert(0, "a");
  const updates = (
    t.sent.filter((m) => typeof m !== "string") as Uint8Array[]
  ).filter((m) => m[0] === 0x03);
  assertEquals(updates.length, 1);
  assertEquals(
    new DataView(updates[0].buffer, updates[0].byteOffset + 1, 4).getUint32(
      0,
      false,
    ),
    1,
  );
  assertEquals(client.pendingCount, 1);
  client.close();
});
