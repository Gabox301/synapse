// resolveRole: directo, workspace, creador, extraño (Etapa 4 T2).
import { assertEquals } from "jsr:@std/assert";
import {
  addDocumentMember,
  createDocument,
  removeDocumentMember,
  resolveRole,
} from "./access.ts";
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

Deno.test("resolveRole respeta jerarquía de acceso", async (t) => {
  if (!await pgUp()) {
    console.log("SKIP: sin postgres");
    return;
  }
  const mkUser = async (tag: string) =>
    await createUser({ email: `${tag}-${Date.now()}@test.local`, passwordHash: await hashPassword("x".repeat(10)) });
  const creator = await mkUser("t2own");
  const member = await mkUser("t2mem");
  const stranger = await mkUser("t2str");
  const docId = await createDocument({ title: "t2", createdBy: creator });

  await t.step("creador es owner", async () => {
    assertEquals(await resolveRole(creator, docId), "owner");
  });

  await t.step("extraño no tiene rol", async () => {
    assertEquals(await resolveRole(stranger, docId), null);
  });

  await t.step("documento inexistente da null", async () => {
    assertEquals(await resolveRole(creator, "doc-que-no-existe"), null);
  });

  await t.step("miembro directo manda sobre defecto", async () => {
    await addDocumentMember(docId, member, "viewer");
    assertEquals(await resolveRole(member, docId), "viewer");
    await addDocumentMember(docId, member, "editor");
    assertEquals(await resolveRole(member, docId), "editor");
  });

  await t.step("miembro de workspace hereda rol", async () => {
    const wsId = `ws_${Date.now()}`;
    await getPool().query("INSERT INTO workspaces (id, name, owner_id) VALUES ($1, 't', $2)", [wsId, creator]);
    await getPool().query(
      "INSERT INTO workspace_members (workspace_id, user_id, role) VALUES ($1, $2, 'viewer')",
      [wsId, member],
    );
    const wdoc = await createDocument({ title: "wsdoc", createdBy: creator, workspaceId: wsId });
    // member ya es editor directo en docId, pero en wdoc solo hereda viewer.
    assertEquals(await resolveRole(member, wdoc), "viewer");
    assertEquals(await resolveRole(creator, wdoc), "owner");
    await getPool().query("DELETE FROM documents WHERE id = $1", [wdoc]);
    await getPool().query("DELETE FROM workspaces WHERE id = $1", [wsId]);
  });

  await t.step("revocar quita el acceso", async () => {
    await addDocumentMember(docId, member, "viewer");
    assertEquals(await resolveRole(member, docId), "viewer");
    await removeDocumentMember(docId, member);
    assertEquals(await resolveRole(member, docId), null);
  });

  await getPool().query("DELETE FROM documents WHERE id = $1", [docId]);
  for (const u of [creator, member, stranger]) {
    await getPool().query("DELETE FROM users WHERE id = $1", [u]);
  }
});
