// Share links: un owner genera un enlace con rol + vencimiento + usos.
// Quien lo abre (registrado o no) se registra/entrar y accede al doc.
import { assert, assertEquals } from "jsr:@std/assert";
import {
  createShareLink,
  joinViaLink,
  listShareLinks,
  revokeShareLink,
} from "./sharelinks.ts";
import { createDocument, resolveRole } from "./access.ts";
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

Deno.test("share links de punta a punta", async (t) => {
  if (!await pgUp()) {
    console.log("SKIP: sin postgres");
    return;
  }
  const mkUser = async (tag: string) =>
    await createUser({ email: `${tag}-${Date.now()}@test.local`, passwordHash: await hashPassword("x".repeat(10)) });
  const owner = await mkUser("sh-own");
  const guest = await mkUser("sh-gst");
  const stranger = await mkUser("sh-str");
  const docId = await createDocument({ title: "sh", createdBy: owner });

  await t.step("solo owner crea links y solo editor/viewer", async () => {
    try {
      await createShareLink(docId, stranger, { role: "editor" });
      throw new Error("debió fallar");
    } catch (e) {
      assertEquals(String((e as Error).message).split(":")[0], "FORBIDDEN");
    }
    try {
      await createShareLink(docId, owner, { role: "owner" });
      throw new Error("debió fallar");
    } catch (e) {
      assertEquals(String((e as Error).message).split(":")[0], "INVALID_ROLE");
    }
  });

  await t.step("unirse por link otorga el rol", async () => {
    const { token } = await createShareLink(docId, owner, { role: "viewer" });
    const joined = await joinViaLink(token, guest);
    assert(joined && joined.documentId === docId && joined.role === "viewer");
    assertEquals(await resolveRole(guest, docId), "viewer");
  });

  await t.step("unirse dos veces no quema usos", async () => {
    const fresh = await mkUser("sh-dbl");
    const { token, id } = await createShareLink(docId, owner, { role: "editor", maxUses: 5 });
    await joinViaLink(token, fresh);
    await joinViaLink(token, fresh);
    const listed = await listShareLinks(docId, owner);
    const entry = listed.find((l) => l.id === id);
    assertEquals(entry?.usedCount, 1);
  });

  await t.step("agotado, vencido o revocado no entran", async () => {
    const one = await createShareLink(docId, owner, { role: "viewer", maxUses: 1 });
    const fresh = await mkUser("sh-new");
    assert(await joinViaLink(one.token, fresh));
    assertEquals(await joinViaLink(one.token, await mkUser("sh-new2")), null);
    const exp = await createShareLink(docId, owner, { role: "viewer", expiresInHours: 0 });
    assertEquals(await joinViaLink(exp.token, await mkUser("sh-new3")), null);
    const rev = await createShareLink(docId, owner, { role: "viewer" });
    await revokeShareLink(docId, rev.id, stranger).catch(() => "forbidden-ok");
    try {
      await revokeShareLink(docId, rev.id, stranger);
      throw new Error("debió fallar");
    } catch {
      assert(true);
    }
    await revokeShareLink(docId, rev.id, owner);
    assertEquals(await joinViaLink(rev.token, await mkUser("sh-new4")), null);
  });

  await t.step("listar no expone tokens", async () => {
    const listed = await listShareLinks(docId, owner);
    assert(listed.length > 0);
    for (const l of listed) {
      assert(!("token" in l) && !("tokenHash" in l), "fuga de token");
    }
    try {
      await listShareLinks(docId, stranger);
      throw new Error("debió fallar");
    } catch (e) {
      assertEquals(String((e as Error).message).split(":")[0], "FORBIDDEN");
    }
  });

  await getPool().query("DELETE FROM documents WHERE id = $1", [docId]);
  const { rows } = await getPool().query<{ id: string }>(
    "SELECT id FROM users WHERE email LIKE 'sh-%@test.local'",
  );
  for (const r of rows) await getPool().query("DELETE FROM users WHERE id = $1", [r.id]);
});
