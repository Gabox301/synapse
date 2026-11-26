import { assertEquals } from "jsr:@std/assert";
import * as Y from "yjs";
import { encodeSyncStep1, encodeSyncStep2, encodeUpdate } from "../../../packages/protocol/frames.ts";
import { decodeFrame } from "../../../packages/protocol/frames.ts";
import { getOrCreateDoc, resetStore } from "./documents.ts";
import { handleBinary } from "./handler.ts";

function state(docId = "doc1") {
  return { documentId: docId, unknownCount: 0, awarenessIds: new Set<number>() };
}

Deno.test("UPDATE se aplica y se difunde con cseq cero", () => {
  resetStore();
  const client = new Y.Doc();
  client.getText("t").insert(0, "hola");
  const incoming = encodeUpdate(41, Y.encodeStateAsUpdate(client));
  const out = handleBinary(incoming, state());
  assertEquals(out.errorJson, null);
  assertEquals(out.replies.length, 0);
  assertEquals(out.broadcast.length, 1);
  const relayed = decodeFrame(out.broadcast[0]);
  assertEquals(relayed.cseq, 0);
  assertEquals(getOrCreateDoc("doc1").getText("t").toString(), "hola");
});

Deno.test("SYNC_STEP1 responde dos frames sin error", () => {
  resetStore();
  getOrCreateDoc("doc1").getText("t").insert(0, "abc");
  const out = handleBinary(encodeSyncStep1(Y.encodeStateVector(new Y.Doc())), state());
  assertEquals(out.errorJson, null);
  assertEquals(out.replies.length, 2);
  assertEquals(out.broadcast.length, 0);
});

Deno.test("tercer mensaje desconocido cierra con 4400", () => {
  resetStore();
  const st = state();
  let out = handleBinary(new Uint8Array([0xff]), st);
  assertEquals(out.closeCode, null);
  out = handleBinary(new Uint8Array([0xfe]), st);
  assertEquals(out.closeCode, null);
  out = handleBinary(new Uint8Array([0xfd]), st);
  assertEquals(out.closeCode, 4400);
  assertEquals((JSON.parse(out.errorJson!).payload.code), "UNKNOWN_MESSAGE");
});

Deno.test("UPDATE inválido responde INVALID_UPDATE sin difundir", () => {
  resetStore();
  getOrCreateDoc("doc1");
  const bad = encodeUpdate(3, new Uint8Array([255, 255, 255, 255]));
  const out = handleBinary(bad, state());
  assertEquals(out.broadcast.length, 0);
  assertEquals(JSON.parse(out.errorJson!).payload.code, "INVALID_UPDATE");
});

function vstate(docId = "doc1", role: "owner" | "editor" | "viewer" = "viewer") {
  return {
    documentId: docId,
    unknownCount: 0,
    awarenessIds: new Set<number>(),
    auth: { userId: "u1", role, name: "u1", color: "#000" },
  };
}

Deno.test("viewer UPDATE se descarta con READ_ONLY sin difundir", () => {
  resetStore();
  getOrCreateDoc("doc1");
  const client = new Y.Doc();
  client.getText("t").insert(0, "x");
  const out = handleBinary(encodeUpdate(1, Y.encodeStateAsUpdate(client)), vstate());
  assertEquals(JSON.parse(out.errorJson!).payload.code, "READ_ONLY");
  assertEquals(out.broadcast.length, 0);
  assertEquals(out.appliedUpdate, null);
  assertEquals(getOrCreateDoc("doc1").getText("t").toString(), "");
});

Deno.test("viewer SYNC_STEP2 se rechaza; SYNC_STEP1 pasa; awareness va por awareness.ts", () => {
  resetStore();
  getOrCreateDoc("doc1").getText("t").insert(0, "abc");
  const step2 = handleBinary(encodeSyncStep2(new Uint8Array([1, 2, 3])), vstate());
  assertEquals(JSON.parse(step2.errorJson!).payload.code, "READ_ONLY");
  assertEquals(step2.broadcast.length, 0);
  const step1 = handleBinary(encodeSyncStep1(Y.encodeStateVector(new Y.Doc())), vstate());
  assertEquals(step1.replies.length, 2);
  const routed = handleBinary(new Uint8Array([0x04, 9, 9]), vstate());
  assertEquals(JSON.parse(routed.errorJson!).payload.code, "UNKNOWN_MESSAGE");
  assertEquals(routed.broadcast.length, 0);
});

Deno.test("editor UPDATE funciona con auth puesta", () => {
  resetStore();
  const client = new Y.Doc();
  client.getText("t").insert(0, "ok");
  const out = handleBinary(encodeUpdate(1, Y.encodeStateAsUpdate(client)), vstate("doc1", "editor"));
  assertEquals(out.errorJson, null);
  assertEquals(out.broadcast.length, 1);
});
