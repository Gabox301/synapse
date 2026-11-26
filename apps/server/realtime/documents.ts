// Document Engine en memoria (Etapa 2): un Y.Doc por documento activo.
import * as Y from "yjs";
import {
  encodeSyncStep1,
  encodeSyncStep2,
  encodeUpdate,
} from "../../../packages/protocol/frames.ts";

const docs = new Map<string, Y.Doc>();

export function resetStore(): void {
  docs.forEach((doc) => doc.destroy());
  docs.clear();
}

export function getOrCreateDoc(documentId: string): Y.Doc {
  let doc = docs.get(documentId);
  if (!doc) {
    doc = new Y.Doc();
    docs.set(documentId, doc);
  }
  return doc;
}

export function hasDoc(documentId: string): boolean {
  return docs.has(documentId);
}

/** Aplica un UPDATE de cliente; el update inválido se descarta sin tocar el doc. */
export function applyClientUpdate(
  documentId: string,
  _cseq: number,
  update: Uint8Array,
): void {
  const doc = getOrCreateDoc(documentId);
  try {
    Y.applyUpdate(doc, update);
  } catch {
    throw new Error("INVALID_UPDATE: el update no se pudo decodificar o aplicar");
  }
}

/**
 * Responde al SYNC_STEP1 del cliente con [SYNC_STEP2(diff), SYNC_STEP1(vector propio)].
 * El orden respeta el handshake de la sección 4 del proyecto.
 */
export function encodeSyncReply(documentId: string, stateVector: Uint8Array): Uint8Array[] {
  const doc = getOrCreateDoc(documentId);
  let diff: Uint8Array;
  try {
    diff = Y.encodeStateAsUpdate(doc, stateVector);
  } catch {
    throw new Error("INVALID_UPDATE: state vector inválido");
  }
  return [encodeSyncStep2(diff), encodeSyncStep1(Y.encodeStateVector(doc))];
}

/** Re-emite un update hacia los peers con cseq en cero (forma servidor→cliente). */
export function relayUpdate(update: Uint8Array): Uint8Array {
  return encodeUpdate(0, update);
}

/** Evicta el doc de memoria (se usa al quedar sin conexiones; Etapa 3 lo persistirá antes). */
export function evictDoc(documentId: string): void {
  const doc = docs.get(documentId);
  if (doc) {
    doc.destroy();
    docs.delete(documentId);
  }
}
