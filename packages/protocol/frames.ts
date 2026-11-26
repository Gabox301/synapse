// SNP v1 — frames binarios (runtime-agnóstico, sin APIs de Deno/Node).

export const FRAME_SYNC_STEP1 = 0x01;
export const FRAME_SYNC_STEP2 = 0x02;
export const FRAME_UPDATE = 0x03;
export const FRAME_AWARENESS = 0x04;

export const KNOWN_FRAME_TYPES = [
  FRAME_SYNC_STEP1,
  FRAME_SYNC_STEP2,
  FRAME_UPDATE,
  FRAME_AWARENESS,
] as const;

export type FrameType = (typeof KNOWN_FRAME_TYPES)[number];

/** Límite de frame binario (Etapa 2; mismo orden que el límite WS de Etapa 1). */
export const MAX_FRAME_BYTES = 64 * 1024;

export interface DecodedFrame {
  type: FrameType;
  /** Solo presente en UPDATE: contador del cliente (u32 big-endian). */
  cseq: number | null;
  payload: Uint8Array;
}

function concat(prefix: Uint8Array, body: Uint8Array): Uint8Array {
  const out = new Uint8Array(prefix.length + body.length);
  out.set(prefix, 0);
  out.set(body, prefix.length);
  return out;
}

function checkSize(total: number): void {
  if (total > MAX_FRAME_BYTES) {
    throw new Error(`MESSAGE_TOO_LARGE: frame de ${total} bytes supera ${MAX_FRAME_BYTES}`);
  }
}

export function encodeSyncStep1(stateVector: Uint8Array): Uint8Array {
  checkSize(1 + stateVector.length);
  return concat(new Uint8Array([FRAME_SYNC_STEP1]), stateVector);
}

export function encodeSyncStep2(update: Uint8Array): Uint8Array {
  checkSize(1 + update.length);
  return concat(new Uint8Array([FRAME_SYNC_STEP2]), update);
}

export function encodeUpdate(cseq: number, update: Uint8Array): Uint8Array {
  if (!Number.isInteger(cseq) || cseq < 0 || cseq > 0xffffffff) {
    throw new Error(`INVALID_UPDATE: cseq fuera de rango u32: ${cseq}`);
  }
  checkSize(1 + 4 + update.length);
  const header = new Uint8Array(5);
  header[0] = FRAME_UPDATE;
  new DataView(header.buffer).setUint32(1, cseq, false);
  return concat(header, update);
}

export function encodeAwareness(update: Uint8Array): Uint8Array {
  checkSize(1 + update.length);
  return concat(new Uint8Array([FRAME_AWARENESS]), update);
}

export function decodeFrame(data: Uint8Array): DecodedFrame {
  if (data.length < 1) throw new Error("UNKNOWN_MESSAGE: frame vacío");
  if (data.length > MAX_FRAME_BYTES) {
    throw new Error(`MESSAGE_TOO_LARGE: frame de ${data.length} bytes supera ${MAX_FRAME_BYTES}`);
  }
  const type = data[0] as FrameType;
  if (!(KNOWN_FRAME_TYPES as readonly number[]).includes(type)) {
    throw new Error(`UNKNOWN_MESSAGE: tipo de frame desconocido 0x${type.toString(16)}`);
  }
  if (type === FRAME_UPDATE) {
    if (data.length < 5) throw new Error("INVALID_UPDATE: frame UPDATE sin cseq completo");
    const cseq = new DataView(data.buffer, data.byteOffset + 1, 4).getUint32(0, false);
    return { type, cseq, payload: data.slice(5) };
  }
  return { type, cseq: null, payload: data.slice(1) };
}
