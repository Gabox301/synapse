// Etapa 6 T3 (RED): registro de instancias con heartbeat y TTL.
// Sin REDIS_URL se saltea (igual que bus_test).
import { assert, assertEquals } from "jsr:@std/assert";
import { createPresence } from "./presence.ts";

function needUrl(): string | null {
  const u = Deno.env.get("REDIS_URL");
  if (!u) console.log("skip: sin REDIS_URL");
  return u ?? null;
}

Deno.test("presence: heartbeat visible y expira al morir", async () => {
  const redisUrl = needUrl();
  if (!redisUrl) return;
  const ttlSec = 2;
  const a = createPresence({ redisUrl, instanceId: `a-${Date.now()}`, ttlSec, beatSec: 1 });
  const b = createPresence({ redisUrl, instanceId: `b-${Date.now()}`, ttlSec, beatSec: 1 });
  const dead: string[] = [];
  b.onDead((id) => dead.push(id));
  await a.start();
  await b.start();
  assert(await b.isAlive(a.instanceId), "a visible para b");
  // a muere sin cleanup (caída): su clave debe expirar y b debe notarlo.
  await a.crash();
  const t0 = Date.now();
  while (dead.length === 0 && Date.now() - t0 < 8000) {
    await new Promise((r) => setTimeout(r, 250));
  }
  assertEquals(dead, [a.instanceId]);
  assert(!(await b.isAlive(a.instanceId)), "a ya no visible");
  await b.stop();
});
