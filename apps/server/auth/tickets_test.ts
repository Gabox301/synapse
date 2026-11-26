// Tickets: emisión, consumo único, TTL y atadura a documento (Etapa 4 T2).
import { assert, assertEquals } from "jsr:@std/assert";
import { consumeTicket, issueTicket } from "./tickets.ts";
import { createUser } from "./sessions.ts";
import { getPool } from "../realtime/persistence.ts";
import { hashPassword } from "./password.ts";

async function pgUp(): Promise<boolean> {
  try {
    await getPool().query("SELECT 1");
    return true;
  } catch {
    return false;
  }
}

Deno.test("tickets: emiten, consumen una vez y expiran", async (t) => {
  if (!await pgUp()) {
    console.log("SKIP: sin postgres");
    return;
  }
  const email = `t2-${Date.now()}@test.local`;
  const userId = await createUser({ email, passwordHash: await hashPassword("x".repeat(10)) });
  const docId = `t2doc-${Date.now()}`;
  await getPool().query("INSERT INTO documents (id, title) VALUES ($1, 't')", [docId]);

  await t.step("issue + consume ok, segundo consume falla", async () => {
    const { ticket } = await issueTicket(userId, docId);
    assert(ticket.length >= 32);
    const first = await consumeTicket(ticket, docId);
    assert(first !== null, "primer consumo debió aceptar");
    assertEquals(first!.userId, userId);
    assertEquals(await consumeTicket(ticket, docId), null);
  });

  await t.step("expirado se rechaza", async () => {
    const { ticket } = await issueTicket(userId, docId, { ttlMs: 50 });
    await new Promise((r) => setTimeout(r, 120));
    assertEquals(await consumeTicket(ticket, docId), null);
  });

  await t.step("documento equivocado se rechaza", async () => {
    const { ticket } = await issueTicket(userId, docId);
    assertEquals(await consumeTicket(ticket, "otro-doc"), null);
  });

  await t.step("token desconocido se rechaza", async () => {
    assertEquals(await consumeTicket("noexiste".repeat(8), docId), null);
  });

  await getPool().query("DELETE FROM documents WHERE id = $1", [docId]);
  await getPool().query("DELETE FROM users WHERE id = $1", [userId]);
});
