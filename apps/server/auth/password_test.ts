import { assert, assertEquals } from "jsr:@std/assert";
import { hashPassword, verifyPassword } from "./password.ts";

Deno.test("hashPassword genera hash verificable y distinto por sal", async () => {
  const a = await hashPassword("secreto-123");
  const b = await hashPassword("secreto-123");
  assert(a !== b, "cada hash debe usar sal distinta");
  assertEquals(await verifyPassword("secreto-123", a), true);
  assertEquals(await verifyPassword("otra-clave", a), false);
  assertEquals(await verifyPassword("", a), false);
});
