// Runner de migraciones (Etapa 3): aplica *.sql pendientes en orden, una vez cada uno.
// Uso: DATABASE_URL=... deno task migrate   (default: postgres local del compose)
import { Client } from "npm:pg";

const DATABASE_URL =
  Deno.env.get("DATABASE_URL") ?? "postgresql://synapse:synapse@localhost:5432/synapse";
const MIGRATIONS_DIR = new URL("../../../infrastructure/postgres/migrations/", import.meta.url);

async function appliedVersions(client: InstanceType<typeof Client>): Promise<Set<string>> {
  await client.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version TEXT PRIMARY KEY,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);
  const { rows } = await client.query<{ version: string }>(
    "SELECT version FROM schema_migrations ORDER BY version",
  );
  return new Set(rows.map((r) => r.version));
}

async function main(): Promise<void> {
  const client = new Client({ connectionString: DATABASE_URL });
  await client.connect();
  try {
    const applied = await appliedVersions(client);
    const files: string[] = [];
    for await (const entry of Deno.readDir(MIGRATIONS_DIR)) {
      if (entry.isFile && entry.name.endsWith(".sql")) files.push(entry.name);
    }
    files.sort();
    let ran = 0;
    for (const file of files) {
      const version = file.replace(/\.sql$/, "");
      if (applied.has(version)) continue;
      const sql = await Deno.readTextFile(new URL(`./${file}`, MIGRATIONS_DIR));
      console.log(`applying ${version}...`);
      await client.query("BEGIN");
      try {
        await client.query(sql);
        await client.query("INSERT INTO schema_migrations (version) VALUES ($1)", [version]);
        await client.query("COMMIT");
      } catch (err) {
        await client.query("ROLLBACK");
        throw err;
      }
      ran++;
    }
    console.log(ran === 0 ? "already up to date" : `applied ${ran} migration(s)`);
  } finally {
    await client.end();
  }
}

await main();
