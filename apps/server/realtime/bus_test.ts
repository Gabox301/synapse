// Etapa 6 T2 (RED): bus Redis entre instancias (canal por doc, instance-id, sin loops).
import { assert, assertEquals } from "jsr:@std/assert";
import {
  channelFor,
  createBus,
  decodeBusMessage,
  encodeBusMessage,
} from "./bus.ts";
import type { BusMessage } from "./bus.ts";

Deno.test("bus: canal por documento", () => {
  assertEquals(channelFor("doc-1"), "snp:doc:doc-1");
});

Deno.test("bus: encode/decode roundtrip sin secreto", () => {
  const payload = new Uint8Array([0x03, 0x01, 0x02, 0xff]);
  const raw = encodeBusMessage({ from: "inst-a", kind: "update", payload });
  const back = decodeBusMessage(raw);
  assertEquals(back.from, "inst-a");
  assertEquals(back.kind, "update");
  assertEquals(back.payload, payload);
});

Deno.test("bus: ignora mensajes propios", async () => {
  const redisUrl = Deno.env.get("REDIS_URL");
  if (!redisUrl) {
    console.log("skip: sin REDIS_URL");
    return;
  }
  const bus = createBus({ instanceId: "inst-test", redisUrl });
  const received: string[] = [];
  await bus.ensureSubscribed("doc-spike", (msg: BusMessage) => {
    received.push(`${msg.from}:${msg.kind}`);
  });
  // Publicar como uno mismo: el handler local no debe verlo (se ignora por from).
  await bus.publishUpdate("doc-spike", new Uint8Array([0x03, 0x09]));
  await new Promise((r) => setTimeout(r, 800));
  assertEquals(received, []);
  await bus.close();
  assert(true);
});
