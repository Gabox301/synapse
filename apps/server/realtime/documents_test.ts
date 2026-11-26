import { assertEquals, assertThrows } from "jsr:@std/assert";
import * as Y from "yjs";
import {
  applyClientUpdate,
  encodeSyncReply,
  evictDoc,
  getOrCreateDoc,
  hasDoc,
  relayUpdate,
  resetStore,
} from "./documents.ts";
import { decodeFrame } from "../../../packages/protocol/frames.ts";

Deno.test("setup: store limpio por test", () => {
  resetStore();
  const doc = getOrCreateDoc("doc1");
  assertEquals(doc instanceof Y.Doc, true);
});

Deno.test("update de cliente converge al doc del servidor", () => {
  resetStore();
  const client = new Y.Doc();
  client.getText("t").insert(0, "hola");
  const update = Y.encodeStateAsUpdate(client);

  const stored = getOrCreateDoc("doc1");
  applyClientUpdate("doc1", 1, update);

  const diff = Y.encodeStateAsUpdate(stored);
  const replica = new Y.Doc();
  Y.applyUpdate(replica, diff);
  assertEquals(replica.getText("t").toString(), "hola");
});

Deno.test("update inválido se descarta sin corromper el doc", () => {
  resetStore();
  getOrCreateDoc("doc1");
  assertThrows(
    () => applyClientUpdate("doc1", 2, new Uint8Array([255, 255, 255])),
    Error,
    "INVALID_UPDATE",
  );
  const stored = getOrCreateDoc("doc1");
  assertEquals(stored.getText("t").toString(), "");
});

Deno.test("SYNC_STEP1 del cliente genera reply SYNC_STEP2 válido", () => {
  resetStore();
  const serverDoc = getOrCreateDoc("doc1");
  serverDoc.getText("t").insert(0, "abc");
  const newcomer = new Y.Doc();
  const sv = Y.encodeStateVector(newcomer);
  const replies = encodeSyncReply("doc1", sv);
  assertEquals(replies.length, 2);
  for (const frame of replies) {
    const decoded = decodeFrame(frame);
    const fresh = new Y.Doc();
    // Ningún reply puede romper un doc: ambos payloads son updates/vectores aplicables o vector propio
    if (decoded.type === 0x02) Y.applyUpdate(fresh, decoded.payload);
  }
  // El diff del servidor aplicado al newcomer lo pone al día
  const step2 = decodeFrame(replies[0]);
  Y.applyUpdate(newcomer, step2.payload);
  assertEquals(newcomer.getText("t").toString(), "abc");
});

Deno.test("relay re-emite UPDATE con cseq en cero (forma servidor→cliente)", () => {
  const payload = new Uint8Array([10, 20, 30]);
  const frame = relayUpdate(payload);
  const decoded = decodeFrame(frame);
  assertEquals(decoded.type, 0x03);
  assertEquals(decoded.cseq, 0);
  assertEquals(decoded.payload, payload);
});

Deno.test("evictDoc libera el doc cuando la room queda vacía", () => {
  resetStore();
  getOrCreateDoc("doc1").getText("t").insert(0, "x");
  assertEquals(hasDoc("doc1"), true);
  evictDoc("doc1");
  assertEquals(hasDoc("doc1"), false);
  assertEquals(getOrCreateDoc("doc1").getText("t").toString(), "");
});
