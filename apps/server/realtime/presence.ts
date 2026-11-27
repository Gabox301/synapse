// Registro de instancias vivas (Etapa 6 T3): heartbeat con TTL en Redis.
// - Cada instancia publica `snp:inst:<id>` con expiración y se anota en el set `snp:inst`.
// - Si una instancia cae sin cleanup, su clave expira y las demás la dan por
//   muerta (poll) para limpiar su presencia fantasma.
// - Sin KEYS: solo SADD/SMEMBERS/EXISTS/SET/DEL/SREM (aptos para Upstash).
import { connect, parseURL } from "@db/redis";
import type { Redis } from "@db/redis";

const KEY_PREFIX = "snp:inst:";
const SET_KEY = "snp:inst";

export interface PresenceOptions {
  redisUrl: string;
  instanceId?: string;
  /** Segundos de vida del heartbeat (default 15). */
  ttlSec?: number;
  /** Cada cuántos segundos se late y se sondea (default 5). */
  beatSec?: number;
}

export interface Presence {
  readonly instanceId: string;
  start(): Promise<void>;
  stop(): Promise<void>;
  /** Cierra sin cleanup: simula una caída (la clave expira por TTL). */
  crash(): Promise<void>;
  isAlive(id: string): Promise<boolean>;
  list(): Promise<string[]>;
  onDead(cb: (id: string) => void): void;
  onRecovered(cb: () => void): void;
}

export function createPresence(opts: PresenceOptions): Presence {
  const instanceId = opts.instanceId ?? crypto.randomUUID();
  const ttlSec = opts.ttlSec ?? 15;
  const beatMs = (opts.beatSec ?? 5) * 1000;
  const parsed = parseURL(opts.redisUrl);
  let conn: Redis | null = null;
  let beatTimer: ReturnType<typeof setInterval> | null = null;
  let pollTimer: ReturnType<typeof setInterval> | null = null;
  let failures = 0;
  let started = false;
  const reported = new Set<string>();
  const deadCbs: Array<(id: string) => void> = [];
  const recoveredCbs: Array<() => void> = [];

  function noteSuccess(): void {
    if (failures > 0) {
      failures = 0;
      for (const cb of recoveredCbs) {
        try {
          cb();
        } catch (err) {
          console.error("[presence] onRecovered falló:", err);
        }
      }
    }
  }

  function noteFailure(err: unknown): void {
    failures += 1;
    console.error(`[presence] redis falló (${failures} seguidas):`, err);
  }

  async function beat(): Promise<void> {
    if (!conn) return;
    try {
      await conn.sadd(SET_KEY, instanceId);
      await conn.set(KEY_PREFIX + instanceId, "1", { ex: ttlSec });
      noteSuccess();
    } catch (err) {
      noteFailure(err);
    }
  }

  async function poll(): Promise<void> {
    if (!conn) return;
    let members: string[];
    try {
      members = await conn.smembers(SET_KEY);
      noteSuccess();
    } catch (err) {
      noteFailure(err);
      return;
    }
    for (const m of members) {
      if (m === instanceId) continue;
      let alive = false;
      try {
        alive = (await conn.exists(KEY_PREFIX + m)) === 1;
      } catch (err) {
        noteFailure(err);
        continue;
      }
      if (alive) {
        reported.delete(m);
      } else if (!reported.has(m)) {
        reported.add(m);
        // Limpieza best-effort del set para no acumular caídos.
        try {
          await conn.srem(SET_KEY, m);
        } catch { /* el próximo poll reintenta */ }
        for (const cb of deadCbs) {
          try {
            cb(m);
          } catch (err) {
            console.error("[presence] onDead falló:", err);
          }
        }
      }
    }
  }

  return {
    instanceId,
    async start(): Promise<void> {
      if (started) return;
      started = true;
      conn = await connect(parsed);
      await beat();
      beatTimer = setInterval(() => void beat(), beatMs);
      pollTimer = setInterval(() => void poll(), beatMs);
      await poll();
    },
    async stop(): Promise<void> {
      started = false;
      if (beatTimer !== null) clearInterval(beatTimer);
      if (pollTimer !== null) clearInterval(pollTimer);
      beatTimer = pollTimer = null;
      if (conn) {
        const c = conn;
        conn = null;
        try {
          await c.del(KEY_PREFIX + instanceId);
          await c.srem(SET_KEY, instanceId);
        } catch { /* best-effort */ }
        try {
          c.close();
        } catch { /* noop */ }
      }
    },
    async crash(): Promise<void> {
      started = false;
      if (beatTimer !== null) clearInterval(beatTimer);
      if (pollTimer !== null) clearInterval(pollTimer);
      beatTimer = pollTimer = null;
      if (conn) {
        const c = conn;
        conn = null;
        try {
          c.close();
        } catch { /* noop */ }
      }
    },
    async isAlive(id: string): Promise<boolean> {
      if (!conn) return false;
      try {
        return (await conn.exists(KEY_PREFIX + id)) === 1;
      } catch (err) {
        noteFailure(err);
        return false;
      }
    },
    async list(): Promise<string[]> {
      if (!conn) return [];
      try {
        return await conn.smembers(SET_KEY);
      } catch (err) {
        noteFailure(err);
        return [];
      }
    },
    onDead(cb: (id: string) => void): void {
      deadCbs.push(cb);
    },
    onRecovered(cb: () => void): void {
      recoveredCbs.push(cb);
    },
  };
}
