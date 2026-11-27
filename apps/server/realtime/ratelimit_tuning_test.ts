// Etapa 7 T4: calibración medida del rate limiting (reloj simulado).
// Perfil legítimo: 1 pestaña = 5 updates/s + 16 awareness/s (throttle 60ms).
// Abuso: ráfaga sostenida muy por encima del refill.
import { assert, assertEquals } from "jsr:@std/assert";
import {
  AUTH_LIMIT,
  CLOSE_AFTER_DROPS,
  CONN_LIMIT,
  RateLimiter,
  USER_LIMIT,
} from "./ratelimit.ts";

function dropsFor(
  msgsPerSec: number,
  seconds: number,
  keys: { conn: string[]; user: string },
): { drops: number; closedAtSec: number | null } {
  let now = 0;
  const conn = new RateLimiter(CONN_LIMIT, () => now);
  const user = new RateLimiter(USER_LIMIT, () => now);
  let drops = 0;
  let closedAtSec: number | null = null;
  const step = 1000 / msgsPerSec;
  const total = Math.floor(msgsPerSec * seconds);
  for (let i = 0; i < total; i++) {
    now = i * step;
    let ok = true;
    for (const c of keys.conn) ok = conn.take(c) && ok;
    ok = user.take(keys.user) && ok;
    if (!ok) {
      drops++;
      if (drops >= CLOSE_AFTER_DROPS && closedAtSec === null) {
        closedAtSec = now / 1000;
      }
    }
  }
  return { drops, closedAtSec };
}

Deno.test("tuning: 1 pestaña legítima nunca pierde ni cierra (5 min)", () => {
  const r = dropsFor(21, 300, { conn: ["c1"], user: "u1" });
  assertEquals(r.drops, 0);
  assertEquals(r.closedAtSec, null);
});

Deno.test("tuning: 5 pestañas legítimas 10 min sin cierre", () => {
  const conns = ["c1", "c2", "c3", "c4", "c5"];
  let now = 0;
  const conn = new RateLimiter(CONN_LIMIT, () => now);
  const user = new RateLimiter(USER_LIMIT, () => now);
  let drops = 0;
  // 105 msg/s repartidos en 5 conexiones, 600 s.
  const total = 105 * 600;
  for (let i = 0; i < total; i++) {
    now = (i * 1000) / 105;
    let ok = conn.take(conns[i % 5]);
    ok = user.take("u1") && ok;
    if (!ok) drops++;
  }
  assertEquals(drops, 0);
});

Deno.test("tuning: abuso por conexión se cierra en <1s", () => {
  const r = dropsFor(200, 10, { conn: ["cX"], user: "uX" });
  assert(r.closedAtSec !== null && r.closedAtSec < 1, `cerró en ${r.closedAtSec}s`);
});

Deno.test("tuning: login frena fuerza bruta (5 intentos sí, 6° no)", () => {
  let now = 0;
  const auth = new RateLimiter(AUTH_LIMIT, () => now);
  for (let i = 0; i < 5; i++) assert(auth.take("login:1.2.3.4"), `intento ${i + 1} pasa`);
  assertEquals(auth.take("login:1.2.3.4"), false);
  now += 61_000; // +1 token por minuto
  assert(auth.take("login:1.2.3.4"), "tras 1 min pasa de nuevo");
});
