// Tickets de un solo uso para el handshake WS (Etapa 4 T2).
// El ticket viaja en la URL: en DB solo vive su hash SHA-256.
import { getPool } from "../realtime/persistence.ts";

export const TICKET_TTL_MS = 60 * 1000;

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

export async function issueTicket(
  userId: string,
  documentId: string,
  opts?: { ttlMs?: number },
): Promise<{ ticket: string; expiresAt: Date }> {
  const ticket = randomToken();
  const expiresAt = new Date(Date.now() + (opts?.ttlMs ?? TICKET_TTL_MS));
  await getPool().query(
    `INSERT INTO tickets (id, user_id, document_id, token_hash, expires_at)
     VALUES ($1, $2, $3, $4, $5)`,
    [randomId("tkt"), userId, documentId, await tokenHash(ticket), expiresAt.toISOString()],
  );
  return { ticket, expiresAt };
}

/** Consume atómicamente: un solo uso, mismo documento, sin expirar. */
export async function consumeTicket(
  token: string,
  documentId: string,
): Promise<{ userId: string; ticketId: string } | null> {
  if (!token) return null;
  const { rows } = await getPool().query<{ user_id: string; id: string }>(
    `UPDATE tickets SET used_at = now()
     WHERE token_hash = $1 AND document_id = $2
       AND used_at IS NULL AND expires_at > now()
     RETURNING user_id, id`,
    [await tokenHash(token), documentId],
  );
  if (rows.length === 0) return null;
  return { userId: rows[0].user_id, ticketId: rows[0].id };
}
