import { assertEquals, assertThrows } from "jsr:@std/assert";
import {
  FRAME_AWARENESS,
  FRAME_SYNC_STEP1,
  FRAME_SYNC_STEP2,
  FRAME_UPDATE,
  decodeFrame,
  encodeAwareness,
  encodeSyncStep1,
  encodeSyncStep2,
  encodeUpdate,
} from "./frames.ts";
import { CLOSE_CODES, ERROR_CODES } from "./errors.ts";

Deno.test("UPDATE roundtrip preserva cseq y payload", () => {
  const payload = new Uint8Array([1, 2, 3, 250]);
  const frame = encodeUpdate(7, payload);
  assertEquals(frame[0], FRAME_UPDATE);
  const decoded = decodeFrame(frame);
  assertEquals(decoded.type, FRAME_UPDATE);
  assertEquals(decoded.cseq, 7);
  assertEquals(decoded.payload, payload);
});

Deno.test("SYNC_STEP1/2 y AWARENESS roundtrip", () => {
  const sv = new Uint8Array([0, 1, 2]);
  assertEquals(decodeFrame(encodeSyncStep1(sv)).type, FRAME_SYNC_STEP1);
  assertEquals(decodeFrame(encodeSyncStep1(sv)).payload, sv);
  const diff = new Uint8Array([9, 9]);
  assertEquals(decodeFrame(encodeSyncStep2(diff)).type, FRAME_SYNC_STEP2);
  const aw = new Uint8Array([5, 6, 7]);
  const decAw = decodeFrame(encodeAwareness(aw));
  assertEquals(decAw.type, FRAME_AWARENESS);
  assertEquals(decAw.payload, aw);
});

Deno.test("decodeFrame rechaza byte de tipo desconocido", () => {
  assertThrows(() => decodeFrame(new Uint8Array([0xff, 0, 1])), Error, "UNKNOWN_MESSAGE");
});

Deno.test("decodeFrame rechaza UPDATE sin cseq", () => {
  assertThrows(() => decodeFrame(new Uint8Array([FRAME_UPDATE, 0, 1])), Error);
});

Deno.test("byte de SYNC_STEP1 es 0x01", () => {
  assertEquals(FRAME_SYNC_STEP1, 0x01);
  assertEquals(FRAME_SYNC_STEP2, 0x02);
  assertEquals(FRAME_UPDATE, 0x03);
  assertEquals(FRAME_AWARENESS, 0x04);
});

Deno.test("catálogo de errores y cierres SNP v1", () => {
  for (const code of ["READ_ONLY", "INVALID_UPDATE", "UNKNOWN_MESSAGE"] as const) {
    assertEquals((ERROR_CODES as readonly string[]).includes(code), true);
  }
  assertEquals(CLOSE_CODES.PROTOCOL_VIOLATION, 4400);
  assertEquals(CLOSE_CODES.MESSAGE_TOO_LARGE, 4413);
});
