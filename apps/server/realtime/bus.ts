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
  /** Re-suscribe todos los canales activos (cura suscripciones muertas tras
   * reconexión; los loops viejos se invalidan por generación). */
  resubscribeAll(): Promise<void>;
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
  /** Generación: un loop viejo (gen distinta a la vigente) se retira. */
  gen: number;
  onRemote: RemoteHandler;
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
    resubscribeAll: noop,
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

  function startLoop(documentId: string, entry: SubEntry): void {
    const sub = entry.sub;
    (async () => {
      try {
        // deno-lint-ignore no-explicit-any
        for await (const msg of (sub as any).receive()) {
          if (subs.get(documentId) !== entry) break;
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
            entry.onRemote(decoded);
          } catch (err) {
            console.error(`[bus] handler ${documentId} falló:`, err);
          }
        }
      } catch {
        // Suscripción cerrada o conexión caída: se termina el loop.
      }
    })();
  }

  return {
    instanceId,
    enabled: true,
    async ensureSubscribed(documentId: string, onRemote: RemoteHandler): Promise<void> {
      if (closed) return;
      const ex = subs.get(documentId);
      if (ex?.sub) return;
      const gen = (ex?.gen ?? -1) + 1;
      if (ex) subs.delete(documentId);
      const channel = channelFor(documentId);
      const conn = await subConn();
      const sub = await conn.subscribe(channel);
      const entry: SubEntry = { channel, sub, gen, onRemote };
      subs.set(documentId, entry);
      startLoop(documentId, entry);
    },
    async resubscribeAll(): Promise<void> {
      if (closed) return;
      // Conexión nueva: la vieja (sana, muerta o a medio morir) se cierra y
      // sus loops pendientes mueren; re-suscribir sobre la misma conexión no
      // entrega en este cliente. El servidor olvida las subs al cerrar el TCP.
      const stale = subClient;
      subClient = null;
      try {
        stale?.close();
      } catch { /* ya muerta */ }
      for (const [documentId, old] of [...subs]) {
        const entry: SubEntry = {
          channel: old.channel,
          sub: null,
          gen: old.gen + 1,
          onRemote: old.onRemote,
        };
        subs.set(documentId, entry);
        try {
          const conn = await subConn();
          entry.sub = await conn.subscribe(entry.channel);
        } catch (err) {
          console.error(`[bus] resubscribe ${documentId} falló:`, err);
          continue; // se reintenta en el próximo refresh/ensure
        }
        startLoop(documentId, entry);
      }
    },
    publishUpdate: (documentId, payload) => publish(documentId, "update", payload),
    publishAwareness: (documentId, payload) => publish(documentId, "awareness", payload),
    async unsubscribe(documentId: string): Promise<void> {
      const entry = subs.get(documentId);
      if (!entry) return;
      subs.delete(documentId);
      try {
        await entry.sub?.unsubscribe?.(entry.channel);
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
