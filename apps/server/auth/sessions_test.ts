// Sesiones en PG (Etapa 4 T1). Requiere `docker compose up -d postgres`.
import { assert, assertEquals } from "jsr:@std/assert";
import { hashPassword } from "./password.ts";
import { createSession, createUser, revokeSession, validateSession } from "./sessions.ts";
import { getPool } from "../realtime/persistence.ts";

async function pgUp(): Promise<boolean> {
  try {
    await getPool().query("SELECT 1");
    return true;
  } catch {
    return false;
  }
}

Deno.test("sessions: crear, validar, revocar y expiración", async (t) => {
  if (!await pgUp()) {
    console.log("SKIP: sin postgres (docker compose up -d postgres)");
    return;
  }
  const email = `t1-${Date.now()}@test.local`;
  const userId = `usr_${Math.random().toString(36).slice(2, 10)}`;
  await createUser({ id: userId, email, passwordHash: await hashPassword("clave-123") });

  await t.step("crea y valida", async () => {
    const { token } = await createSession(userId);
    assert(token.length >= 32);
    const found = await validateSession(token);
    assert(found !== null, "sesión válida rechazada");
    assertEquals(found!.userId, userId);
  });

  await t.step("token desconocido se rechaza", async () => {
    assertEquals(await validateSession("noexiste".repeat(8)), null);
  });

  await t.step("revocada se rechaza", async () => {
    const { token } = await createSession(userId);
    assert((await validateSession(token)) !== null);
    await revokeSession(token);
    assertEquals(await validateSession(token), null);
  });

  await t.step("expirada se rechaza", async () => {
    const { token } = await createSession(userId, { ttlMs: 50 });
    assert((await validateSession(token)) !== null);
    await new Promise((r) => setTimeout(r, 120));
    assertEquals(await validateSession(token), null);
  });

  await t.step("register duplica email", async () => {
    let dup = false;
    try {
      await createUser({ id: `usr_${Math.random().toString(36).slice(2, 10)}`, email, passwordHash: "x" });
    } catch {
      dup = true;
    }
    assert(dup, "email duplicado debió fallar");
  });

  await getPool().query("DELETE FROM users WHERE id = $1", [userId]);
});
