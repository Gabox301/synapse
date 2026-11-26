import { assertEquals } from "jsr:@std/assert";
import * as Y from "yjs";
import { encodeSyncStep1, encodeUpdate } from "../../../packages/protocol/frames.ts";
import { decodeFrame } from "../../../packages/protocol/frames.ts";
import { getOrCreateDoc, resetStore } from "./documents.ts";
import { handleBinary } from "./handler.ts";

function state(docId = "doc1") {
  return { documentId: docId, unknownCount: 0 };
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
