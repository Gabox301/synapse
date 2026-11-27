import { router } from "./app/router.ts";
import type { ConnState } from "./realtime/handler.ts";
import { handleBinary } from "./realtime/handler.ts";
import {
  applyRemoteAwareness,
  frameAwareness,
  handleAwarenessFrame,
  identityFor,
  inspectAwarenessUpdate,
  releaseConnection,
  releaseDocument,
  removeRemoteStates,
} from "./realtime/awareness.ts";
import { metrics } from "./realtime/metrics.ts";
import { RateLimiter } from "./realtime/ratelimit.ts";
import { resolveRole } from "./auth/access.ts";
import { getUserById } from "./auth/sessions.ts";
import { consumeTicket } from "./auth/tickets.ts";
import {
  enqueueUpdate,
  ensureLoaded,
  evictIfEmpty,
  resyncFromStore,
} from "./realtime/durability.ts";
import { applyClientUpdate, hasDoc } from "./realtime/documents.ts";
import { createBus } from "./realtime/bus.ts";
import type { BusMessage } from "./realtime/bus.ts";
import { createPresence } from "./realtime/presence.ts";
import {
  decodeFrame,
  FRAME_UPDATE,
} from "../../packages/protocol/frames.ts";
import { CLOSE_CODES } from "../../packages/protocol/errors.ts";
import { SUPPORTED_SCHEMA_VERSION } from "../../packages/protocol/schema.ts";

const PORT = Number(Deno.env.get("PORT") ?? "44100");
const ALLOWED_ORIGINS =
  (Deno.env.get("ALLOWED_ORIGINS") ?? "http://localhost:44100").split(",");

const MAX_MSG_BYTES = 64 * 1024;
const rooms = new Map<string, Set<WebSocket>>();
const sockets = new Set<WebSocket>();

// Rate limiting (Etapa 4 T5): por conexión y por usuario.
// Ráfagas cortas pasan; abuso acumulado cierra con 4429.
const connLimiter = new RateLimiter({ capacity: 100, refillPerSec: 50 });
const userLimiter = new RateLimiter({ capacity: 200, refillPerSec: 100 });
const RATE_CLOSE_AFTER_DROPS = 25;
let nextConnId = 0;

// Etapa 6: bus Redis entre instancias (canal por doc, instance-id, sin loops).
// Sin REDIS_URL queda deshabilitado y todo sigue local como antes.
const INSTANCE_ID = crypto.randomUUID();
const bus = createBus({
  instanceId: INSTANCE_ID,
  redisUrl: Deno.env.get("REDIS_URL"),
});
if (bus.enabled) {
  console.log(`[bus] redis activo (inst=${INSTANCE_ID.slice(0, 8)})`);
}

/** Updates remotos llegados antes de que el doc esté en memoria (van tras el load). */
const pendingRemote = new Map<string, Uint8Array[]>();

/**
 * Awareness publicado por otras instancias (Etapa 6 T3): doc -> instance-id de
 * origen -> clientIDs que publicó. Sirve para dar de baja los cursores
 * fantasma de una instancia que se cayó sin cerrar sus sesiones.
 */
const remoteAwareness = new Map<string, Map<string, Set<number>>>();

const FRAME_TYPE_AWARENESS = 0x04;

/** Los frames de awareness viajan por el bus con el prefijo SNP (0x04). */
function unframeRemote(payload: Uint8Array): Uint8Array | null {
  if (payload.length < 2 || payload[0] !== FRAME_TYPE_AWARENESS) return null;
  return payload.subarray(1);
}

/** Anota (o da de baja) los clientIDs que publicó una instancia en un doc. */
function trackRemoteAwareness(
  documentId: string,
  from: string,
  raw: Uint8Array,
): void {
  const change = inspectAwarenessUpdate(raw);
  let byInstance = remoteAwareness.get(documentId);
  if (!byInstance) {
    byInstance = new Map();
    remoteAwareness.set(documentId, byInstance);
  }
  const mine = byInstance.get(from) ?? new Set<number>();
  for (const id of change.added) mine.add(id);
  for (const id of change.updated) mine.add(id);
  for (const id of change.removed) mine.delete(id);
  if (mine.size > 0) byInstance.set(from, mine);
  else byInstance.delete(from);
  if (byInstance.size === 0) remoteAwareness.delete(documentId);
}

function handleRemote(documentId: string, msg: BusMessage): void {
  const room = rooms.get(documentId);
  if (!room || room.size === 0) return;
  if (msg.kind === "awareness") {
    // El estado remoto se mantiene fresco para poder dar de baja al que lo
    // publicó si su instancia desaparece, y se anota su origen.
    const raw = unframeRemote(msg.payload);
    if (raw) {
      try {
        applyRemoteAwareness(documentId, raw);
        trackRemoteAwareness(documentId, msg.from, raw);
      } catch (err) {
        console.error(`[bus] awareness remoto ${documentId} inválido:`, err);
      }
    }
    for (const peer of room) {
      if (peer.readyState === WebSocket.OPEN) {
        peer.send(msg.payload.slice().buffer);
      }
    }
    return;
  }
  if (msg.kind !== "update") return;
  if (!hasDoc(documentId)) {
    const q = pendingRemote.get(documentId);
    if (q) q.push(msg.payload);
    else pendingRemote.set(documentId, [msg.payload]);
    return;
  }
  try {
    const frame = decodeFrame(msg.payload);
    if (frame.type !== FRAME_UPDATE) return;
    try {
      applyClientUpdate(documentId, 0, frame.payload);
    } catch {
      return;
    }
  } catch {
    return;
  }
  for (const peer of room) {
    if (peer.readyState === WebSocket.OPEN) {
      peer.send(msg.payload.slice().buffer);
    }
  }
}

/** Aplica lo encolado mientras se cargaba el doc (conmutan: el orden no importa). */
function drainPending(documentId: string): void {
  const q = pendingRemote.get(documentId);
  pendingRemote.delete(documentId);
  if (!q || q.length === 0) return;
  const room = rooms.get(documentId);
  for (const raw of q) {
    try {
      const frame = decodeFrame(raw);
      if (frame.type !== FRAME_UPDATE) continue;
      try {
        applyClientUpdate(documentId, 0, frame.payload);
      } catch {
        continue;
      }
    } catch {
      continue;
    }
    if (room) {
      for (const peer of room) {
        if (peer.readyState === WebSocket.OPEN) {
          peer.send(raw.slice().buffer);
        }
      }
    }
  }
}

/**
 * Una instancia murió (Etapa 6 T3): se dan de baja sus estados de awareness,
 * se difunde la remoción a la room local y por el bus, y se olvida su
 * tracking. Los clientIDs con owner local vivo no se tocan.
 */
async function dropInstanceAwareness(deadId: string): Promise<void> {
  for (const [documentId, byInstance] of [...remoteAwareness]) {
    const ids = byInstance.get(deadId);
    byInstance.delete(deadId);
    if (byInstance.size === 0) remoteAwareness.delete(documentId);
    if (!ids || ids.size === 0) continue;
    const removal = removeRemoteStates(documentId, [...ids]);
    if (!removal) continue;
    const framed = frameAwareness(removal);
    const room = rooms.get(documentId);
    if (room) {
      for (const peer of room) {
        if (peer.readyState === WebSocket.OPEN) {
          peer.send(framed.slice().buffer);
        }
      }
    }
    await bus.publishAwareness(documentId, framed).catch((err) =>
      console.error(`[bus] publish removal ${documentId} falló:`, err)
    );
  }
}

/**
 * Tras recuperar Redis (onRecovered) lo publicado mientras no había bus solo
 * está en PG: cada doc con sesiones se re-sincroniza completo (merge
 * idempotente; el cliente sigue mandando su state vector al reconectar).
 */
async function resyncOpenRooms(): Promise<void> {
  for (const documentId of [...rooms.keys()]) {
    try {
      await resyncFromStore(documentId);
    } catch (err) {
      console.error(`[bus] resync ${documentId} falló:`, err);
    }
  }
}

// Etapa 6 T3: registro de instancias vivas (heartbeat con TTL) y reacción a
// caídas y reconexiones. Sin REDIS_URL no hay bus y todo queda como antes.
const presence = bus.enabled
  ? createPresence({
    redisUrl: Deno.env.get("REDIS_URL") ?? "",
    instanceId: INSTANCE_ID,
    ttlSec: 15,
    beatSec: 5,
  })
  : null;

if (presence) {
  presence.onDead((deadId) => {
    void dropInstanceAwareness(deadId).catch((err) =>
      console.error(`[presence] baja de ${deadId.slice(0, 8)} falló:`, err)
    );
  });
  presence.onRecovered(() => {
    void (async () => {
      try {
        await bus.resubscribeAll();
        await resyncOpenRooms();
      } catch (err) {
        console.error("[presence] resync tras reconexión falló:", err);
      }
    })();
  });
}

function isOriginAllowed(req: Request): boolean {
  const origin = req.headers.get("origin");
  if (!origin) return true; // curl / no-browser
  return ALLOWED_ORIGINS.includes(origin);
}

/** El guard de schema lanza con prefijo SCHEMA_UNSUPPORTED (ver durability.ts). */
function isSchemaUnsupported(err: unknown): boolean {
  return err instanceof Error && err.message.startsWith("SCHEMA_UNSUPPORTED");
}

/**
 * Guard de schema (Etapa 5): se rechaza la sesión sin cargar el doc en memoria.
 * Se usa el cierre 4415 para que el cliente sepa que debe actualizar la app.
 */
function rejectUnsupportedSchema(socket: WebSocket, err: unknown): void {
  metrics.inc("synapse_rejections_total", { reason: "schema_unsupported" });
  if (socket.readyState !== WebSocket.OPEN) return;
  socket.send(JSON.stringify({
    type: "document:error",
    payload: {
      code: "SCHEMA_UNSUPPORTED",
      message: err instanceof Error
        ? err.message
        : "schema del documento no soportado",
    },
  }));
  socket.close(CLOSE_CODES.SCHEMA_UPGRADE_REQUIRED);
}

async function handleWS(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const m = url.pathname.match(/^\/ws\/documents\/([^/]+)$/);
  if (!m) return new Response("not found", { status: 404 });

  const documentId = m[1];
  const ticket = url.searchParams.get("ticket");
  if (!isOriginAllowed(req)) {
    metrics.inc("synapse_rejections_total", { reason: "forbidden_origin" });
    return new Response("forbidden origin", { status: 403 });
  }
  if (!ticket) {
    metrics.inc("synapse_rejections_total", { reason: "missing_ticket" });
    return new Response("missing ticket", { status: 401 });
  }
  // Etapa 4: ticket real de un solo uso, atado al documento.
  const consumed = await consumeTicket(ticket, documentId).catch(() => null);
  if (!consumed) {
    metrics.inc("synapse_rejections_total", { reason: "invalid_ticket" });
    return new Response("invalid ticket", { status: 401 });
  }
  const role = await resolveRole(consumed.userId, documentId).catch(() => null);
  if (!role) {
    metrics.inc("synapse_rejections_total", { reason: "forbidden" });
    return new Response("forbidden", { status: 403 });
  }
  const user = await getUserById(consumed.userId).catch(() => null);
  if (!user) return new Response("forbidden", { status: 403 });
  const identity = identityFor(user.id, user.email);

  const proto = req.headers.get("sec-websocket-protocol") ?? "";
  if (!proto.split(",").map((s) => s.trim()).includes("snp.v1")) {
    metrics.inc("synapse_rejections_total", { reason: "unsupported_protocol" });
    return new Response("unsupported protocol", { status: 400 });
  }

  const { socket, response } = Deno.upgradeWebSocket(req, {
    protocol: "snp.v1",
  });

  socket.onopen = async () => {
    let room = rooms.get(documentId);
    if (!room) {
      room = new Set();
      rooms.set(documentId, room);
    }
    room.add(socket);
    // Etapa 6: suscribirse ANTES de cargar (si se carga primero, se pierden
    // los updates del intervalo; lo encolado se aplica tras el load).
    if (bus.enabled) {
      await bus
        .ensureSubscribed(documentId, (m) => handleRemote(documentId, m))
        .catch((err) => console.error(`[bus] subscribe ${documentId} falló:`, err));
    }
    // seq real persistido (Etapa 3); ante fallo de PG se rechaza con 1011.
    // Etapa 5: el schema_version desconocido se rechaza con 4415.
    let seq = 0;
    let schemaVersion = SUPPORTED_SCHEMA_VERSION;
    try {
      const loaded = await ensureLoaded(documentId);
      seq = loaded.seq;
      schemaVersion = loaded.schemaVersion;
    } catch (err) {
      if (isSchemaUnsupported(err)) {
        rejectUnsupportedSchema(socket, err);
        return;
      }
      console.error(`[ws] load ${documentId} falló:`, err);
      if (socket.readyState === WebSocket.OPEN) {
        socket.send(JSON.stringify({
          type: "document:error",
          payload: {
            code: "INTERNAL",
            message: "no se pudo cargar el documento",
          },
        }));
        socket.close(1011);
      }
      return;
    }
    if (socket.readyState !== WebSocket.OPEN) return;
    drainPending(documentId);
    socket.send(JSON.stringify({
      type: "document:joined",
      payload: { documentId, role, seq, schemaVersion },
    }));
    sockets.add(socket);
    metrics.set("synapse_ws_connections", sockets.size);
    metrics.set("synapse_documents_active", rooms.size);
    metrics.inc("synapse_joins_total");
  };

  const connKey = `${documentId}#${++nextConnId}`;
  const st: ConnState = {
    documentId,
    unknownCount: 0,
    awarenessIds: new Set<number>(),
    rateDrops: 0,
    auth: {
      userId: consumed.userId,
      role,
      name: identity.name,
      color: identity.color,
    },
  };

  socket.onmessage = async (ev) => {
    if (typeof ev.data !== "string") {
      // Etapa 3: el doc debe estar cargado ANTES de rutear (los mensajes pueden
      // llegar antes de que termine el ensureLoaded del onopen).
      try {
        await ensureLoaded(documentId);
      } catch (err) {
        if (isSchemaUnsupported(err)) {
          rejectUnsupportedSchema(socket, err);
          return;
        }
        console.error(`[ws] load ${documentId} falló:`, err);
        if (socket.readyState === WebSocket.OPEN) {
          socket.send(JSON.stringify({
            type: "document:error",
            payload: {
              code: "INTERNAL",
              message: "no se pudo cargar el documento",
            },
          }));
          socket.close(1011);
        }
        return;
      }
      // Etapa 2: frames binarios SNP v1 (SYNC_STEP1/2, UPDATE, AWARENESS).
      let bytes: Uint8Array | null = null;
      try {
        if (ev.data instanceof Blob) {
          bytes = new Uint8Array(await ev.data.arrayBuffer());
        } else if (ev.data instanceof ArrayBuffer) {
          bytes = new Uint8Array(ev.data);
        } else if (ArrayBuffer.isView(ev.data)) {
          bytes = new Uint8Array(
            ev.data.buffer as ArrayBuffer,
            ev.data.byteOffset,
            ev.data.byteLength,
          );
        }
      } catch {
        bytes = null;
      }
      if (!bytes) {
        socket.send(JSON.stringify({
          type: "document:error",
          payload: { code: "INTERNAL", message: "no se pudo leer el frame" },
        }));
        metrics.inc("synapse_rejections_total", { reason: "internal" });
        return;
      }
      const inKind = bytes.length === 0
        ? "empty"
        : bytes[0] === 0x01
        ? "sync_step1"
        : bytes[0] === 0x02
        ? "sync_step2"
        : bytes[0] === 0x03
        ? "update"
        : bytes[0] === 0x04
        ? "awareness"
        : "unknown";
      metrics.inc("synapse_messages_in_total", { kind: inKind });
      // Etapa 4: el rol se verifica en CADA mensaje, no solo al conectar.
      // Revocado => 4403. Cambio de rol => access-changed en caliente.
      // Ante error de DB se conserva el rol cacheado (fail-open acotado).
      if (st.auth) {
        try {
          const fresh = await resolveRole(st.auth.userId, documentId);
          if (!fresh) {
            metrics.inc("synapse_rejections_total", { reason: "revoked" });
            if (socket.readyState === WebSocket.OPEN) socket.close(4403);
            return;
          }
          if (fresh !== st.auth.role) {
            st.auth = { ...st.auth, role: fresh };
            if (socket.readyState === WebSocket.OPEN) {
              socket.send(JSON.stringify({
                type: "document:access-changed",
                payload: { role: fresh },
              }));
            }
          }
        } catch (err) {
          console.error(
            `[ws] resolveRole ${documentId} falló, se conserva rol:`,
            err,
          );
        }
      }
      // Etapa 4 T5: rate limiting por conexión y por usuario.
      // Ráfagas cortas pasan; abuso sostenido cierra con 4429.
      if (st.auth) {
        const okConn = connLimiter.take(connKey);
        const okUser = userLimiter.take(`user:${st.auth.userId}`);
        if (!okConn || !okUser) {
          st.rateDrops += 1;
          metrics.inc("synapse_rate_limited_total");
          metrics.inc("synapse_rejections_total", { reason: "rate_limited" });
          if (socket.readyState === WebSocket.OPEN) {
            socket.send(JSON.stringify({
              type: "document:error",
              payload: { code: "RATE_LIMITED", message: "demasiados mensajes" },
            }));
            if (st.rateDrops >= RATE_CLOSE_AFTER_DROPS) socket.close(4429);
          }
          return;
        }
      }
      // Awareness con identidad del servidor (Etapa 4): ruteo aparte con rewrite.
      if (bytes[0] === 0x04 && st.auth) {
        const out = handleAwarenessFrame(
          documentId,
          socket,
          st.awarenessIds,
          bytes,
          {
            userId: st.auth.userId,
            name: st.auth.name,
            color: st.auth.color,
          },
        );
        if (out.relay) {
          const framed = frameAwareness(out.relay);
          metrics.inc("synapse_messages_out_total", { kind: "awareness" });
          const room = rooms.get(documentId);
          if (room) {
            for (const peer of room) {
              if (peer !== socket && peer.readyState === WebSocket.OPEN) {
                peer.send(framed.slice().buffer);
              }
            }
          }
          if (bus.enabled) {
            void bus.publishAwareness(documentId, framed).catch((err) =>
              console.error(`[bus] publish awareness ${documentId} falló:`, err)
            );
          }
        } else {
          console.error(
            `[ws] awareness descartado ${documentId}: ${out.reason ?? "?"}`,
          );
        }
        return;
      }
      const out = handleBinary(bytes, st);
      if (out.replies.length > 0) {
        metrics.inc(
          "synapse_messages_out_total",
          { kind: "reply" },
          out.replies.length,
        );
      }
      for (const reply of out.replies) socket.send(reply.slice().buffer);
      if (out.errorJson) {
        socket.send(out.errorJson);
        metrics.inc("synapse_messages_out_total", { kind: "error" });
        try {
          const code =
            (JSON.parse(out.errorJson) as { payload?: { code?: string } })
              .payload?.code;
          if (code) metrics.inc("synapse_rejections_total", { reason: code });
        } catch { /* errorJson siempre es JSON válido interno */ }
      }
      if (out.appliedUpdate) {
        enqueueUpdate(
          documentId,
          socket,
          out.appliedUpdate.cseq,
          out.appliedUpdate.payload,
        );
      }
      if (out.broadcast.length > 0) {
        metrics.inc(
          "synapse_messages_out_total",
          { kind: "broadcast" },
          out.broadcast.length,
        );
        const room = rooms.get(documentId);
        if (room) {
          for (const peer of room) {
            if (peer !== socket && peer.readyState === WebSocket.OPEN) {
              for (const frame of out.broadcast) {
                peer.send(frame.slice().buffer);
              }
            }
          }
        }
        if (bus.enabled) {
          for (const frame of out.broadcast) {
            void bus.publishUpdate(documentId, frame).catch((err) =>
              console.error(`[bus] publish update ${documentId} falló:`, err)
            );
          }
        }
      }
      if (out.closeCode) {
        const reason = out.closeCode === 4400
          ? "protocol_violation"
          : out.closeCode === 4413
          ? "message_too_large"
          : "closed";
        metrics.inc("synapse_rejections_total", { reason });
        socket.close(out.closeCode);
      }
      return;
    }
    const text = ev.data;
    metrics.inc("synapse_messages_in_total", { kind: "text" });
    if (text.length > MAX_MSG_BYTES) {
      socket.send(JSON.stringify({
        type: "document:error",
        payload: { code: "MESSAGE_TOO_LARGE", message: "frame too large" },
      }));
      socket.close(4413);
      return;
    }
    let msg: { type?: string } | null = null;
    try {
      msg = JSON.parse(text);
    } catch {
      socket.send(JSON.stringify({
        type: "document:error",
        payload: { code: "UNKNOWN_MESSAGE", message: "invalid JSON" },
      }));
      return;
    }
    if (msg?.type === "connection:ping") {
      socket.send(JSON.stringify({ type: "connection:pong" }));
      metrics.inc("synapse_messages_out_total", { kind: "control" });
      return;
    }
    // Broadcast de texto a la room (control JSON; los binarios se rutean arriba).
    const room = rooms.get(documentId);
    if (!room) return;
    for (const peer of room) {
      if (peer !== socket && peer.readyState === WebSocket.OPEN) {
        peer.send(text);
      }
    }
  };

  const leave = () => {
    connLimiter.forget(connKey);
    sockets.delete(socket);
    metrics.set("synapse_ws_connections", sockets.size);
    const room = rooms.get(documentId);
    // La presencia de esta conexión se elimina y se difunde de inmediato.
    const removal = releaseConnection(documentId, socket);
    const finishEvict = (done: boolean) => {
      if (done) releaseDocument(documentId);
    };
    if (!room) {
      void evictIfEmpty(documentId, undefined).then(finishEvict).catch((err) =>
        console.error(`[ws] evict ${documentId} falló:`, err)
      );
      return;
    }
    room.delete(socket);
    metrics.set(
      "synapse_documents_active",
      rooms.size - (room.size === 0 ? 1 : 0),
    );
    if (removal && room.size > 0) {
      const framed = frameAwareness(removal);
      for (const peer of room) {
        if (peer !== socket && peer.readyState === WebSocket.OPEN) {
          peer.send(framed.slice().buffer);
        }
      }
      if (bus.enabled) {
        void bus.publishAwareness(documentId, framed).catch((err) =>
          console.error(`[bus] publish removal ${documentId} falló:`, err)
        );
      }
    }
    if (room.size === 0) {
      rooms.delete(documentId);
      pendingRemote.delete(documentId);
      remoteAwareness.delete(documentId);
      if (bus.enabled) {
        void bus.unsubscribe(documentId).catch((err) =>
          console.error(`[bus] unsubscribe ${documentId} falló:`, err)
        );
      }
    }
    // Persiste pendientes antes de liberar memoria (fire-and-forget;
    // ante caída, el cliente reenvía lo no confirmado por state vector).
    void evictIfEmpty(documentId, room).then(finishEvict).catch((err) =>
      console.error(`[ws] evict ${documentId} falló:`, err)
    );
  };
  socket.onclose = leave;
  socket.onerror = leave;

  return response;
}

// Etapa 6 T3: heartbeat al boot (TTL 15s, latido 5s) para que las demás
// instancias detecten la caída y limpien los cursores de esta. Es best-effort:
// un Redis caído no debe impedir que el servidor empiece a servir.
if (presence) {
  presence.start().catch((err) =>
    console.error("[presence] start falló:", err)
  );
}

// Anti-entropy (Etapa 6): el broker puede cerrar conexiones idle sin aviso y
// el cliente no re-suscribe solo: cada 60s se renuevan las suscripciones y se
// re-sincroniza desde PG lo que haya pasado en el intervalo (merge
// idempotente; el hueco de ms lo cubre el resync, no el bus at-most-once).
if (bus.enabled) {
  setInterval(() => {
    void (async () => {
      try {
        await bus.resubscribeAll();
        await resyncOpenRooms();
      } catch (err) {
        console.error("[bus] refresh anti-entropy falló:", err);
      }
    })();
  }, 60_000);
}

Deno.serve({ port: PORT }, (req) => {
  try {
    if (new URL(req.url).pathname.startsWith("/ws/")) return handleWS(req);
    return router.fetch(req);
  } catch (err) {
    console.error(err);
    return new Response("internal", { status: 500 });
  }
});
