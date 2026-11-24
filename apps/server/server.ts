import { router } from "./app/router.ts";

const PORT = Number(Deno.env.get("PORT") ?? "44100");
const ALLOWED_ORIGINS = (Deno.env.get("ALLOWED_ORIGINS") ?? "http://localhost:44100").split(",");

const MAX_MSG_BYTES = 64 * 1024;
const rooms = new Map<string, Set<WebSocket>>();

function isOriginAllowed(req: Request): boolean {
  const origin = req.headers.get("origin");
  if (!origin) return true; // curl / no-browser
  return ALLOWED_ORIGINS.includes(origin);
}

function handleWS(req: Request): Response {
  const url = new URL(req.url);
  const m = url.pathname.match(/^\/ws\/documents\/([^/]+)$/);
  if (!m) return new Response("not found", { status: 404 });

  const documentId = m[1];
  const ticket = url.searchParams.get("ticket");
  if (!isOriginAllowed(req)) return new Response("forbidden origin", { status: 403 });
  if (!ticket) {
    return new Response("missing ticket", { status: 401 });
  }
  // Etapa 1: ticket con forma final pero de prueba (Etapa 4 lo vuelve real).
  // Por ahora solo se exige presencia y longitud mínima.
  if (ticket.length < 8) return new Response("invalid ticket", { status: 401 });

  const proto = req.headers.get("sec-websocket-protocol") ?? "";
  if (!proto.split(",").map((s) => s.trim()).includes("snp.v1")) {
    return new Response("unsupported protocol", { status: 400 });
  }

  const { socket, response } = Deno.upgradeWebSocket(req, { protocol: "snp.v1" });

  socket.onopen = () => {
    let room = rooms.get(documentId);
    if (!room) {
      room = new Set();
      rooms.set(documentId, room);
    }
    room.add(socket);
    socket.send(JSON.stringify({
      type: "document:joined",
      payload: { documentId, role: "editor", seq: 0 },
    }));
  };

  socket.onmessage = (ev) => {
    const text = typeof ev.data === "string" ? ev.data : "";
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
    // Etapa 1: broadcast de texto a la room (los frames binarios SNP llegan en Etapa 2).
    const room = rooms.get(documentId);
    if (!room) return;
    for (const peer of room) {
      if (peer !== socket && peer.readyState === WebSocket.OPEN) {
        peer.send(text);
      }
    }
  };

  const leave = () => rooms.get(documentId)?.delete(socket);
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
