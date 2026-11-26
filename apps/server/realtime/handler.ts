// Ruteo de frames binarios SNP v1 (puro y testeable; el socket vive en server.ts).
import {
  FRAME_SYNC_STEP1,
  FRAME_SYNC_STEP2,
  FRAME_UPDATE,
  decodeFrame,
} from "../../../packages/protocol/frames.ts";
import { CLOSE_CODES } from "../../../packages/protocol/errors.ts";
import {
  applyClientUpdate,
  encodeSyncReply,
} from "./documents.ts";
import { relayUpdate } from "./documents.ts";

import type { Role } from "../auth/access.ts";

export interface ConnState {
  documentId: string;
  /** Mensajes desconocidos consecutivos (al tercero se cierra con 4400). */
  unknownCount: number;
  /** Fijado tras el handshake (Etapa 4); T3 lo exige por mensaje. */
  auth?: { userId: string; role: Role; name: string; color: string };
  /** clientIDs de awareness que pertenecen a esta conexión. */
  awarenessIds: Set<number>;
}

export interface RouteOutcome {
  replies: Uint8Array[];
  broadcast: Uint8Array[];
  errorJson: string | null;
  closeCode: number | null;
  /** UPDATE aplicado a memoria (para persistencia); null en el resto de casos. */
  appliedUpdate: { cseq: number; payload: Uint8Array } | null;
}

const MAX_UNKNOWN = 3;

function errorPayload(code: string, message: string): string {
  return JSON.stringify({ type: "document:error", payload: { code, message } });
}

export function handleBinary(data: Uint8Array, st: ConnState): RouteOutcome {
  const ok: RouteOutcome = { replies: [], broadcast: [], errorJson: null, closeCode: null, appliedUpdate: null };
  let frame;
  try {
    frame = decodeFrame(data);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const code = msg.startsWith("MESSAGE_TOO_LARGE") ? "MESSAGE_TOO_LARGE" : "UNKNOWN_MESSAGE";
    if (code === "UNKNOWN_MESSAGE") {
      st.unknownCount += 1;
      if (st.unknownCount >= MAX_UNKNOWN) ok.closeCode = CLOSE_CODES.PROTOCOL_VIOLATION;
    }
    ok.errorJson = errorPayload(code, msg);
    if (code === "MESSAGE_TOO_LARGE") ok.closeCode = CLOSE_CODES.MESSAGE_TOO_LARGE;
    return ok;
  }

  // Etapa 4: viewers solo leen (SYNC_STEP1) y mandan awareness; el resto
  // de escritura se descarta con READ_ONLY sin cerrar la conexión.
  // Sin auth (rutas internas/tests) se permite todo como antes.
  const readOnly = st.auth?.role === "viewer";

  switch (frame.type) {
    case FRAME_SYNC_STEP1: {
      try {
        ok.replies = encodeSyncReply(st.documentId, frame.payload);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        ok.errorJson = errorPayload("INVALID_UPDATE", msg);
      }
      return ok;
    }
    case FRAME_SYNC_STEP2: {
      if (readOnly) {
        ok.errorJson = errorPayload("READ_ONLY", "el rol viewer no puede enviar updates");
        return ok;
      }
      try {
        applyClientUpdate(st.documentId, -1, frame.payload);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        ok.errorJson = errorPayload("INVALID_UPDATE", msg);
      }
      return ok;
    }
    case FRAME_UPDATE: {
      if (readOnly) {
        ok.errorJson = errorPayload("READ_ONLY", "el rol viewer no puede enviar updates");
        return ok;
      }
      try {
        applyClientUpdate(st.documentId, frame.cseq ?? -1, frame.payload);
        ok.broadcast = [relayUpdate(frame.payload)];
        ok.appliedUpdate = { cseq: frame.cseq ?? -1, payload: frame.payload };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        ok.errorJson = errorPayload("INVALID_UPDATE", msg);
      }
      return ok;
    }
    default: {
      // Los frames de awareness (0x04) los rutea el server a awareness.ts.
      ok.errorJson = errorPayload("UNKNOWN_MESSAGE", "frame no ruteado");
      return ok;
    }
  }
}
