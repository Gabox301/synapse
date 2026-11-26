// SNP v1 — mensajes de control JSON (runtime-agnóstico).
import type { ErrorCode } from "./errors.ts";

export const PROTOCOL_VERSION = "snp.v1";

export interface DocumentJoined {
  type: "document:joined";
  payload: { documentId: string; clientId?: string; role: string; seq: number };
}

export interface DocumentAck {
  type: "document:ack";
  payload: { upTo: number; seq: number };
}

export interface DocumentError {
  type: "document:error";
  payload: { code: ErrorCode; message: string };
}

export interface DocumentAccessChanged {
  type: "document:access-changed";
  payload: { role: string };
}

export interface ConnectionPing {
  type: "connection:ping";
}

export interface ConnectionPong {
  type: "connection:pong";
}

export type ControlMessage =
  | DocumentJoined
  | DocumentAck
  | DocumentError
  | DocumentAccessChanged
  | ConnectionPing
  | ConnectionPong;

export function parseControlMessage(text: string): ControlMessage {
  let msg: { type?: unknown; payload?: unknown };
  try {
    msg = JSON.parse(text);
  } catch {
    throw new Error("UNKNOWN_MESSAGE: JSON inválido");
  }
  switch (msg.type) {
    case "document:joined":
    case "document:ack":
    case "document:error":
    case "document:access-changed":
    case "connection:ping":
    case "connection:pong":
      return msg as ControlMessage;
    default:
      throw new Error(`UNKNOWN_MESSAGE: tipo de control desconocido ${String(msg.type)}`);
  }
}
