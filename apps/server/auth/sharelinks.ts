// Share links (Etapa UI): un owner genera un enlace con rol + vencimiento +
// usos. Quien lo abre se registra/entra y accede al doc con ese rol.
// El token viaja en la URL: en DB solo vive su hash SHA-256 (igual que tickets).
// Por seguridad los links NUNCA otorgan owner (se transfiere manualmente).
import { getPool } from "../realtime/persistence.ts";
import {
  addDocumentMember,
  resolveRole,
  type Role,
} from "./access.ts";

export type ShareRole = Extract<Role, "editor" | "viewer">;

function isShareRole(role: string): role is ShareRole {
  return role === "editor" || role === "viewer";
}

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

async function requireOwner(documentId: string, actorUserId: string): Promise<void> {
  const role = await resolveRole(actorUserId, documentId);
  if (role !== "owner") throw new Error("FORBIDDEN: solo un owner gestiona enlaces");
}

export interface ShareLinkOpts {
  role: string;
  /** Horas de vida (default 168 = 7 días). 0 = ya vencido (útil en tests). */
  expiresInHours?: number;
  /** Usos máximos (default 10). null = ilimitado. */
  maxUses?: number | null;
}

export async function createShareLink(
  documentId: string,
  actorUserId: string,
  opts: ShareLinkOpts,
): Promise<{ id: string; token: string }> {
  if (!isShareRole(opts.role)) throw new Error(`INVALID_ROLE: los links solo dan editor/viewer`);
  await requireOwner(documentId, actorUserId);
  const token = randomToken();
  const id = randomId("shl");
  const expiresAt = new Date(Date.now() + (opts.expiresInHours ?? 168) * 3600_1000);
  await getPool().query(
    `INSERT INTO share_links (id, document_id, token_hash, role, created_by, expires_at, max_uses)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [id, documentId, await tokenHash(token), opts.role, actorUserId, expiresAt.toISOString(), opts.maxUses ?? 10],
  );
  return { id, token };
}

export interface ShareLinkMeta {
  id: string;
  role: ShareRole;
  expiresAt: string;
  maxUses: number | null;
  usedCount: number;
  revoked: boolean;
  createdAt: string;
}

/** Metadata sin tokens (para listar y revocar). */
export async function listShareLinks(documentId: string, actorUserId: string): Promise<ShareLinkMeta[]> {
  await requireOwner(documentId, actorUserId);
  const { rows } = await getPool().query<{
    id: string;
    role: ShareRole;
    expires_at: Date | string;
    max_uses: number | null;
    used_count: string;
    revoked_at: Date | string | null;
    created_at: Date | string;
  }>(
    `SELECT id, role, expires_at, max_uses, used_count, revoked_at, created_at
     FROM share_links WHERE document_id = $1 ORDER BY created_at DESC`,
    [documentId],
  );
  const iso = (v: Date | string | null): string => (v instanceof Date ? v.toISOString() : String(v ?? ""));
  return rows.map((r) => ({
    id: r.id,
    role: r.role,
    expiresAt: iso(r.expires_at),
    maxUses: r.max_uses,
    usedCount: Number(r.used_count),
    revoked: r.revoked_at !== null,
    createdAt: iso(r.created_at),
  }));
}

export async function revokeShareLink(documentId: string, linkId: string, actorUserId: string): Promise<void> {
  await requireOwner(documentId, actorUserId);
  await getPool().query(
    "UPDATE share_links SET revoked_at = now() WHERE id = $1 AND document_id = $2",
    [linkId, documentId],
  );
}

/**
 * Unirse por link: valida (revocado/vencido/usos) y agrega como miembro.
 * Idempotente: si ya tiene acceso no quema usos.
 */
export async function joinViaLink(token: string, userId: string): Promise<{ documentId: string; role: Role } | null> {
  if (!token) return null;
  const { rows } = await getPool().query<{
    id: string;
    document_id: string;
    role: ShareRole;
    expires_at: Date | string;
    max_uses: number | null;
    used_count: string;
    revoked_at: Date | string | null;
  }>(
    `SELECT id, document_id, role, expires_at, max_uses, used_count, revoked_at
     FROM share_links WHERE token_hash = $1`,
    [await tokenHash(token)],
  );
  if (rows.length === 0) return null;
  const l = rows[0];
  if (l.revoked_at !== null) return null;
  if (new Date(l.expires_at).getTime() <= Date.now()) return null;
  if (l.max_uses !== null && Number(l.used_count) >= l.max_uses) return null;
  const existing = await resolveRole(userId, l.document_id);
  if (existing) return { documentId: l.document_id, role: existing };
  const claimed = await getPool().query(
    `UPDATE share_links SET used_count = used_count + 1
     WHERE id = $1 AND revoked_at IS NULL AND expires_at > now()
       AND (max_uses IS NULL OR used_count < max_uses)`,
    [l.id],
  );
  if (claimed.rowCount === 0) return null;
  await addDocumentMember(l.document_id, userId, l.role);
  return { documentId: l.document_id, role: l.role };
}

export interface ShareLinkPeek {
  documentId: string;
  title: string;
  role: ShareRole;
  valid: boolean;
  reason?: "NOT_FOUND" | "REVOKED" | "EXPIRED" | "USED_UP";
  expiresAt: string;
  maxUses: number | null;
  usedCount: number;
}

/** Info pública del link para la página de join (sin consumir usos). */
export async function peekShareLink(token: string): Promise<ShareLinkPeek | null> {
  if (!token) return null;
  const { rows } = await getPool().query<{
    id: string;
    document_id: string;
    title: string | null;
    role: ShareRole;
    expires_at: Date | string;
    max_uses: number | null;
    used_count: string;
    revoked_at: Date | string | null;
  }>(
    `SELECT l.id, l.document_id, d.title, l.role, l.expires_at, l.max_uses,
            l.used_count, l.revoked_at
     FROM share_links l JOIN documents d ON d.id = l.document_id
     WHERE l.token_hash = $1`,
    [await tokenHash(token)],
  );
  if (rows.length === 0) return null;
  const l = rows[0];
  const iso = (v: Date | string): string => (v instanceof Date ? v.toISOString() : String(v));
  const base = {
    documentId: l.document_id,
    title: l.title ?? l.document_id,
    role: l.role,
    expiresAt: iso(l.expires_at),
    maxUses: l.max_uses,
    usedCount: Number(l.used_count),
  };
  if (l.revoked_at !== null) return { ...base, valid: false, reason: "REVOKED" };
  if (new Date(l.expires_at).getTime() <= Date.now()) return { ...base, valid: false, reason: "EXPIRED" };
  if (l.max_uses !== null && Number(l.used_count) >= l.max_uses) return { ...base, valid: false, reason: "USED_UP" };
  return { ...base, valid: true };
}
