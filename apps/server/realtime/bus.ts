// Bus Redis entre instancias (Etapa 6): canal por documento, instance-id, sin loops.
//
// - Canal: `snp:doc:<id>`; cada mensaje lleva el `instance-id` de origen y
//   cada instancia ignora los propios para evitar rebotes.
// - Sin REDIS_URL el bus queda deshabilitado (modo una instancia, como antes).
// - Pub/Sub no deja claves: no hay TTL que gestionar acá (el TTL entra en T3
//   con el heartbeat de awareness).
import { connect, parseURL } from "@db/redis";
import type { Redis } from "@db/redis";

export type BusKind = "update" | "awareness";

export interface BusMessage {
  from: string;
  kind: BusKind;
  payload: Uint8Array;
}

export interface BusOptions {
  instanceId?: string;
  redisUrl?: string;
}

export type RemoteHandler = (msg: BusMessage) => void;

export interface Bus {
  readonly instanceId: string;
  readonly enabled: boolean;
  ensureSubscribed(documentId: string, onRemote: RemoteHandler): Promise<void>;
  publishUpdate(documentId: string, payload: Uint8Array): Promise<void>;
  publishAwareness(documentId: string, payload: Uint8Array): Promise<void>;
  unsubscribe(documentId: string): Promise<void>;
  close(): void;
}

export function channelFor(documentId: string): string {
  return `snp:doc:${documentId}`;
}

function encodeBase64(bytes: Uint8Array): string {
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) {
    s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(s);
}

function decodeBase64(s: string): Uint8Array {
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export function encodeBusMessage(msg: BusMessage): string {
  return JSON.stringify({
    v: 1,
    from: msg.from,
    kind: msg.kind,
    payload: encodeBase64(msg.payload),
  });
}

export function decodeBusMessage(raw: string): BusMessage {
  const obj = JSON.parse(raw) as {
    v?: unknown;
    from?: unknown;
    kind?: unknown;
    payload?: unknown;
  };
  if (obj.v !== 1 || typeof obj.from !== "string" || typeof obj.payload !== "string") {
    throw new Error("BUS_MESSAGE_INVALID: forma desconocida");
  }
  if (obj.kind !== "update" && obj.kind !== "awareness") {
    throw new Error("BUS_MESSAGE_INVALID: kind desconocido");
  }
  return { from: obj.from, kind: obj.kind, payload: decodeBase64(obj.payload) };
}

interface SubEntry {
  channel: string;
  // deno-lint-ignore no-explicit-any
  sub: any;
}

function disabledBus(instanceId: string): Bus {
  const noop = async () => {};
  return {
    instanceId,
    enabled: false,
    ensureSubscribed: noop,
    publishUpdate: noop,
    publishAwareness: noop,
    unsubscribe: noop,
    close: () => {},
  };
}

export function createBus(opts: BusOptions = {}): Bus {
  const instanceId = opts.instanceId ?? crypto.randomUUID();
  const redisUrl = (opts.redisUrl ?? "").trim();
  if (!redisUrl) return disabledBus(instanceId);

  const parsed = parseURL(redisUrl);
  let pub: Redis | null = null;
  let subClient: Redis | null = null;
  let closed = false;
  const subs = new Map<string, SubEntry>();

  async function pubClient(): Promise<Redis> {
    if (!pub) pub = await connect(parsed);
    return pub;
  }

  async function subConn(): Promise<Redis> {
    if (!subClient) subClient = await connect(parsed);
    return subClient;
  }

  async function publish(documentId: string, kind: BusKind, payload: Uint8Array): Promise<void> {
    if (closed) return;
    const p = await pubClient();
    await p.publish(channelFor(documentId), encodeBusMessage({ from: instanceId, kind, payload }));
  }

  return {
    instanceId,
    enabled: true,
    async ensureSubscribed(documentId: string, onRemote: RemoteHandler): Promise<void> {
      if (closed || subs.has(documentId)) return;
      const channel = channelFor(documentId);
      const conn = await subConn();
      const sub = await conn.subscribe(channel);
      subs.set(documentId, { channel, sub });
      (async () => {
        try {
          for await (const msg of sub.receive()) {
            const raw = (msg as { message?: unknown }).message;
            if (typeof raw !== "string") continue;
            let decoded: BusMessage;
            try {
              decoded = decodeBusMessage(raw);
            } catch {
              continue;
            }
            if (decoded.from === instanceId) continue;
            try {
              onRemote(decoded);
            } catch (err) {
              console.error(`[bus] handler ${documentId} falló:`, err);
            }
          }
        } catch {
          // Suscripción cerrada (unsubscribe/close): se termina el loop.
        }
      })();
    },
    publishUpdate: (documentId, payload) => publish(documentId, "update", payload),
    publishAwareness: (documentId, payload) => publish(documentId, "awareness", payload),
    async unsubscribe(documentId: string): Promise<void> {
      const entry = subs.get(documentId);
      if (!entry) return;
      subs.delete(documentId);
      try {
        await entry.sub.unsubscribe(entry.channel);
      } catch { /* ya cerrada */ }
    },
    close(): void {
      closed = true;
      subs.clear();
      try {
        pub?.close();
      } catch { /* noop */ }
      try {
        subClient?.close();
      } catch { /* noop */ }
      pub = null;
      subClient = null;
    },
  };
}
