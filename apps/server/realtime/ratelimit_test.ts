import { assert, assertEquals } from "jsr:@std/assert";
import { RateLimiter, TokenBucket } from "./ratelimit.ts";

Deno.test("bucket deja pasar el burst y luego corta", () => {
  let now = 0;
  const b = new TokenBucket({ capacity: 3, refillPerSec: 10 }, () => now);
  assert(b.take());
  assert(b.take());
  assert(b.take());
  assertEquals(b.take(), false);
  now += 200; // +2 tokens
  assert(b.take());
  assert(b.take());
  assertEquals(b.take(), false);
  now += 1000; // lleno de nuevo
  assert(b.take());
});

Deno.test("limiter aísla claves y olvida", () => {
  let now = 0;
  const l = new RateLimiter({ capacity: 1, refillPerSec: 0 }, () => now);
  assert(l.take("a"));
  assertEquals(l.take("a"), false);
  assert(l.take("b"), "otra clave no se ve afectada");
  l.forget("a");
  assert(l.take("a"), "tras forget vuelve a tener cupo");
});
