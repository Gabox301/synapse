// Test de integración de infra PG (Etapa 3 T1). Requiere `docker compose up -d`;
// si no hay Postgres alcanzable, se saltea con aviso (T5 lo corre con PG arriba).
import { Client } from "npm:pg";

const DATABASE_URL =
  Deno.env.get("DATABASE_URL") ?? "postgresql://synapse:synapse@localhost:5432/synapse";

async function tryConnect(): Promise<InstanceType<typeof Client> | null> {
  const client = new Client({ connectionString: DATABASE_URL, connectionTimeoutMillis: 3000 });
  try {
    await client.connect();
    return client;
  } catch {
    await client.end().catch(() => {});
    return null;
  }
}

Deno.test("schema v1 aplicado y documents escribe/lee", async () => {
  const client = await tryConnect();
  if (!client) {
    console.log("SKIP: sin postgres (docker compose up -d postgres)");
    return;
  }
  try {
    const { rows: mig } = await client.query<{ version: string }>(
      "SELECT version FROM schema_migrations WHERE version = '0001_init'",
    );
    if (mig.length !== 1) throw new Error("falta migración 0001_init (deno task migrate)");

    const { rows: tables } = await client.query<{ name: string }>(
      `SELECT tablename AS name FROM pg_tables WHERE schemaname = 'public'`,
    );
    const names = new Set(tables.map((t: { name: string }) => t.name));
    for (
      const expected of [
        "users",
        "workspaces",
        "workspace_members",
        "documents",
        "document_updates",
        "document_snapshots",
      ]
    ) {
      if (!names.has(expected)) throw new Error(`falta tabla ${expected}`);
    }

    const docId = `t1-doc-${Date.now()}`;
    await client.query("INSERT INTO documents (id, title) VALUES ($1, 't1')", [docId]);
    const { rows } = await client.query<{ last_seq: string }>(
      "SELECT last_seq FROM documents WHERE id = $1",
      [docId],
    );
    if (rows[0]?.last_seq !== "0") throw new Error("last_seq inicial distinto de 0");
    await client.query("DELETE FROM documents WHERE id = $1", [docId]);
  } finally {
    await client.end();
  }
});
