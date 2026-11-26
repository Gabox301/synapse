// Sesiones opacas en PostgreSQL: el token viaja en cookie httpOnly;
// en DB solo vive su hash SHA-256. Expiración y revocación explícitas.
import { getPool } from "../realtime/persistence.ts";

const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;
export const SESSION_COOKIE = "synapse_session";

function randomToken(): string {
  return [...crypto.getRandomValues(new Uint8Array(32))]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

async function tokenHash(token: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function randomId(prefix: string): string {
  return `${prefix}_${crypto.randomUUID().replaceAll("-", "").slice(0, 16)}`;
}

export async function createUser(opts: { id?: string; email: string; passwordHash: string }): Promise<string> {
  const id = opts.id ?? randomId("usr");
  await getPool().query(
    "INSERT INTO users (id, email, password_hash) VALUES ($1, $2, $3)",
    [id, opts.email, opts.passwordHash],
  );
  return id;
}

export async function findUserByEmail(email: string): Promise<{ id: string; passwordHash: string } | null> {
  const { rows } = await getPool().query<{ id: string; password_hash: string }>(
    "SELECT id, password_hash FROM users WHERE email = $1",
    [email],
  );
  if (rows.length === 0) return null;
  return { id: rows[0].id, passwordHash: rows[0].password_hash };
}

export async function createSession(
  userId: string,
  opts?: { ttlMs?: number },
): Promise<{ id: string; token: string; expiresAt: Date }> {
  const token = randomToken();
  const id = randomId("ses");
  const expiresAt = new Date(Date.now() + (opts?.ttlMs ?? SESSION_TTL_MS));
  await getPool().query(
    `INSERT INTO sessions (id, user_id, token_hash, expires_at)
     VALUES ($1, $2, $3, $4)`,
    [id, userId, await tokenHash(token), expiresAt.toISOString()],
  );
  return { id, token, expiresAt };
}

export async function validateSession(token: string): Promise<{ userId: string; sessionId: string } | null> {
  if (!token) return null;
  const { rows } = await getPool().query<{ user_id: string; id: string }>(
    `SELECT id, user_id FROM sessions
     WHERE token_hash = $1 AND revoked_at IS NULL AND expires_at > now()`,
    [await tokenHash(token)],
  );
  if (rows.length === 0) return null;
  return { userId: rows[0].user_id, sessionId: rows[0].id };
}

export async function getUserById(id: string): Promise<{ id: string; email: string } | null> {
  const { rows } = await getPool().query<{ id: string; email: string }>(
    "SELECT id, email FROM users WHERE id = $1",
    [id],
  );
  if (rows.length === 0) return null;
  return { id: rows[0].id, email: rows[0].email };
}

export async function revokeSession(token: string): Promise<void> {
  await getPool().query(
    "UPDATE sessions SET revoked_at = now() WHERE token_hash = $1",
    [await tokenHash(token)],
  );
}

export async function revokeAllForUser(userId: string): Promise<void> {
  await getPool().query(
    "UPDATE sessions SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL",
    [userId],
  );
}
