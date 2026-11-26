import { router } from "./app/router.ts";
import type { ConnState } from "./realtime/handler.ts";
import { handleBinary } from "./realtime/handler.ts";
import { frameAwareness, handleAwarenessFrame, identityFor, releaseConnection, releaseDocument } from "./realtime/awareness.ts";
import { resolveRole } from "./auth/access.ts";
import { getUserById } from "./auth/sessions.ts";
import { consumeTicket } from "./auth/tickets.ts";
import { enqueueUpdate, ensureLoaded, evictIfEmpty } from "./realtime/durability.ts";

const PORT = Number(Deno.env.get("PORT") ?? "44100");
const ALLOWED_ORIGINS = (Deno.env.get("ALLOWED_ORIGINS") ?? "http://localhost:44100").split(",");

const MAX_MSG_BYTES = 64 * 1024;
const rooms = new Map<string, Set<WebSocket>>();

function isOriginAllowed(req: Request): boolean {
  const origin = req.headers.get("origin");
  if (!origin) return true; // curl / no-browser
  return ALLOWED_ORIGINS.includes(origin);
}

async function handleWS(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const m = url.pathname.match(/^\/ws\/documents\/([^/]+)$/);
  if (!m) return new Response("not found", { status: 404 });

  const documentId = m[1];
  const ticket = url.searchParams.get("ticket");
  if (!isOriginAllowed(req)) return new Response("forbidden origin", { status: 403 });
  if (!ticket) {
    return new Response("missing ticket", { status: 401 });
  }
  // Etapa 4: ticket real de un solo uso, atado al documento.
  const consumed = await consumeTicket(ticket, documentId).catch(() => null);
  if (!consumed) return new Response("invalid ticket", { status: 401 });
  const role = await resolveRole(consumed.userId, documentId).catch(() => null);
  if (!role) return new Response("forbidden", { status: 403 });
  const user = await getUserById(consumed.userId).catch(() => null);
  if (!user) return new Response("forbidden", { status: 403 });
  const identity = identityFor(user.id, user.email);

  const proto = req.headers.get("sec-websocket-protocol") ?? "";
  if (!proto.split(",").map((s) => s.trim()).includes("snp.v1")) {
    return new Response("unsupported protocol", { status: 400 });
  }

  const { socket, response } = Deno.upgradeWebSocket(req, { protocol: "snp.v1" });

  socket.onopen = async () => {
    let room = rooms.get(documentId);
    if (!room) {
      room = new Set();
      rooms.set(documentId, room);
    }
    room.add(socket);
    // seq real persistido (Etapa 3); ante fallo de PG se rechaza con 1011.
    let seq = 0;
    try {
      seq = (await ensureLoaded(documentId)).seq;
    } catch (err) {
      console.error(`[ws] load ${documentId} falló:`, err);
      if (socket.readyState === WebSocket.OPEN) {
        socket.send(JSON.stringify({
          type: "document:error",
          payload: { code: "INTERNAL", message: "no se pudo cargar el documento" },
        }));
        socket.close(1011);
      }
      return;
    }
    if (socket.readyState !== WebSocket.OPEN) return;
    socket.send(JSON.stringify({
      type: "document:joined",
      payload: { documentId, role, seq },
    }));
  };

  const st: ConnState = {
    documentId,
    unknownCount: 0,
    awarenessIds: new Set<number>(),
    auth: { userId: consumed.userId, role, name: identity.name, color: identity.color },
  };

  socket.onmessage = async (ev) => {
    if (typeof ev.data !== "string") {
      // Etapa 3: el doc debe estar cargado ANTES de rutear (los mensajes pueden
      // llegar antes de que termine el ensureLoaded del onopen).
      try {
        await ensureLoaded(documentId);
      } catch (err) {
        console.error(`[ws] load ${documentId} falló:`, err);
        if (socket.readyState === WebSocket.OPEN) {
          socket.send(JSON.stringify({
            type: "document:error",
            payload: { code: "INTERNAL", message: "no se pudo cargar el documento" },
          }));
          socket.close(1011);
        }
        return;
      }
      // Etapa 2: frames binarios SNP v1 (SYNC_STEP1/2, UPDATE, AWARENESS).
      let bytes: Uint8Array | null = null;
      try {
        if (ev.data instanceof Blob) bytes = new Uint8Array(await ev.data.arrayBuffer());
        else if (ev.data instanceof ArrayBuffer) bytes = new Uint8Array(ev.data);
        else if (ArrayBuffer.isView(ev.data)) {
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
        return;
      }
      // Etapa 4: el rol se verifica en CADA mensaje, no solo al conectar.
      // Revocado => 4403. Cambio de rol => access-changed en caliente.
      // Ante error de DB se conserva el rol cacheado (fail-open acotado).
      if (st.auth) {
        try {
          const fresh = await resolveRole(st.auth.userId, documentId);
          if (!fresh) {
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
          console.error(`[ws] resolveRole ${documentId} falló, se conserva rol:`, err);
        }
      }
      // Awareness con identidad del servidor (Etapa 4): ruteo aparte con rewrite.
      if (bytes[0] === 0x04 && st.auth) {
        const out = handleAwarenessFrame(documentId, socket, st.awarenessIds, bytes, {
          userId: st.auth.userId,
          name: st.auth.name,
          color: st.auth.color,
        });
        if (out.relay) {
          const framed = frameAwareness(out.relay);
          const room = rooms.get(documentId);
          if (room) {
            for (const peer of room) {
              if (peer !== socket && peer.readyState === WebSocket.OPEN) {
                peer.send(framed.slice().buffer);
              }
            }
          }
        } else {
          console.error(`[ws] awareness descartado ${documentId}: ${out.reason ?? "?"}`);
        }
        return;
      }
      const out = handleBinary(bytes, st);
      for (const reply of out.replies) socket.send(reply.slice().buffer);
      if (out.errorJson) socket.send(out.errorJson);
      if (out.appliedUpdate) {
        enqueueUpdate(documentId, socket, out.appliedUpdate.cseq, out.appliedUpdate.payload);
      }
      if (out.broadcast.length > 0) {
        const room = rooms.get(documentId);
        if (room) {
          for (const peer of room) {
            if (peer !== socket && peer.readyState === WebSocket.OPEN) {
              for (const frame of out.broadcast) peer.send(frame.slice().buffer);
            }
          }
        }
      }
      if (out.closeCode) socket.close(out.closeCode);
      return;
    }
    const text = ev.data;
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
    if (removal && room.size > 0) {
      const framed = frameAwareness(removal);
      for (const peer of room) {
        if (peer !== socket && peer.readyState === WebSocket.OPEN) {
          peer.send(framed.slice().buffer);
        }
      }
    }
    if (room.size === 0) rooms.delete(documentId);
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

Deno.serve({ port: PORT }, (req) => {
  try {
    if (new URL(req.url).pathname.startsWith("/ws/")) return handleWS(req);
    return router.fetch(req);
  } catch (err) {
    console.error(err);
    return new Response("internal", { status: 500 });
  }
});
