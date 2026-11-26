// Awareness con identidad fijada por el servidor (Etapa 4).
// El servidor nunca confía en la identidad que envía el cliente: reescribe
// {id, name, color} con los de la sesión autenticada, registra qué clientIDs
// de awareness pertenecen a cada conexión y los elimina al cerrarla.
import * as Y from "yjs";
import {
  Awareness,
  applyAwarenessUpdate,
  encodeAwarenessUpdate,
  modifyAwarenessUpdate,
  removeAwarenessStates,
} from "y-protocols/awareness";
import { getOrCreateDoc } from "./documents.ts";

export interface ServerIdentity {
  userId: string;
  name: string;
  color: string;
}

interface DocAwareness {
  awareness: Awareness;
  /** awareness clientID -> conexión dueña */
  owners: Map<number, WebSocket>;
}

const FRAME_TYPE_AWARENESS = 0x04;

/** Envuelve un update binario de awareness en frame SNP (byte 0x04 + payload). */
export function frameAwareness(update: Uint8Array): Uint8Array {
  const out = new Uint8Array(update.length + 1);
  out[0] = FRAME_TYPE_AWARENESS;
  out.set(update, 1);
  return out;
}

/** Quita y valida el byte de frame SNP; null si el frame es inválido. */
function unframeAwareness(frame: Uint8Array): Uint8Array | null {
  if (frame.length < 1 || frame[0] !== FRAME_TYPE_AWARENESS) return null;
  return frame.slice(1);
}

const CURSOR_COLORS = [
  "#e6194b",
  "#3cb44b",
  "#0082c8",
  "#f58231",
  "#911eb4",
  "#46f0f0",
  "#f032e6",
  "#008080",
];

const registry = new Map<string, DocAwareness>();

/** Identidad estable derivada de la sesión (sin columna de perfil en v1). */
export function identityFor(userId: string, email: string): ServerIdentity {
  const name = email.split("@")[0] || userId;
  let hash = 0;
  for (let i = 0; i < userId.length; i++) hash = (hash * 31 + userId.charCodeAt(0 + i)) >>> 0;
  return { userId, name, color: CURSOR_COLORS[hash % CURSOR_COLORS.length] };
}

function docAwareness(documentId: string): DocAwareness {
  let entry = registry.get(documentId);
  if (!entry) {
    entry = { awareness: new Awareness(getOrCreateDoc(documentId)), owners: new Map() };
    registry.set(documentId, entry);
  }
  return entry;
}

/** Scratch para descubrir qué clientIDs trae un update (sin efectos). */
const scratchDoc = new Y.Doc();

function updateClientIds(frame: Uint8Array): { added: number[]; updated: number[]; removed: number[] } {
  const scratch = new Awareness(scratchDoc);
  let result: { added: number[]; updated: number[]; removed: number[] } = { added: [], updated: [], removed: [] };
  let seen = false;
  // Solo el primer evento (el destroy() posterior emite la remoción local).
  scratch.on("update", (change: { added: number[]; updated: number[]; removed: number[] }) => {
    if (!seen) {
      seen = true;
      result = change;
    }
  });
  applyAwarenessUpdate(scratch, frame, null);
  scratch.destroy();
  return result;
}

export interface AwarenessOutcome {
  /** Bytes a difundir (con identidad del servidor), o null si se descarta. */
  relay: Uint8Array | null;
  dropped: boolean;
  reason?: string;
}

/**
 * Valida propiedad, fija identidad y devuelve el frame a difundir.
 * Un frame con IDs de otra conexión viva se descarta completo (spoof).
 */
export function handleAwarenessFrame(
  documentId: string,
  conn: WebSocket,
  ownedIds: Set<number>,
  frame: Uint8Array,
  identity: ServerIdentity,
): AwarenessOutcome {
  const entry = docAwareness(documentId);
  const raw = unframeAwareness(frame);
  if (!raw) return { relay: null, dropped: true, reason: "sin prefijo 0x04" };
  let ids: { added: number[]; updated: number[]; removed: number[] };
  try {
    ids = updateClientIds(raw);
  } catch (err) {
    const head = Array.from(frame.slice(0, 8)).map((b) => b.toString(16).padStart(2, "0")).join(" ");
    return { relay: null, dropped: true, reason: `decode: ${(err as Error).message} len=${frame.length} head=[${head}]` };
  }
  const all = [...ids.added, ...ids.updated, ...ids.removed];
  for (const id of all) {
    const owner = entry.owners.get(id);
    if (owner !== undefined && owner !== conn) {
      return { relay: null, dropped: true, reason: `spoof ${id}` };
    }
  }
  for (const id of all) {
    entry.owners.set(id, conn);
    ownedIds.add(id);
  }
  const fixed = { id: identity.userId, name: identity.name, color: identity.color };
  let rewritten: Uint8Array;
  try {
    rewritten = modifyAwarenessUpdate(raw, (state: unknown) => {
      if (state === null || typeof state !== "object") return state;
      return { ...(state as Record<string, unknown>), user: fixed };
    });
  } catch (err) {
    return { relay: null, dropped: true, reason: `rewrite: ${(err as Error).message}` };
  }
  applyAwarenessUpdate(entry.awareness, rewritten, conn);
  return { relay: rewritten, dropped: false };
}

/**
 * Elimina los clientIDs de la conexión y devuelve el update de remoción
 * para difundir (null si no tenía ninguno).
 */
export function releaseConnection(documentId: string, conn: WebSocket): Uint8Array | null {
  const entry = registry.get(documentId);
  if (!entry) return null;
  const mine: number[] = [];
  for (const [id, owner] of entry.owners) {
    if (owner === conn) mine.push(id);
  }
  for (const id of mine) entry.owners.delete(id);
  if (mine.length === 0) return null;
  removeAwarenessStates(entry.awareness, mine, conn);
  return encodeAwarenessUpdate(entry.awareness, mine);
}

/** Olvida todo el estado de awareness de un documento (al evictar). */
export function releaseDocument(documentId: string): void {
  registry.delete(documentId);
}
