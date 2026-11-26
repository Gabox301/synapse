import { render } from "remix/middleware/render";
import { createController } from "remix/router";

import { hashPassword, verifyPassword } from "../../auth/password.ts";
import { metrics } from "../../realtime/metrics.ts";
import { RateLimiter } from "../../realtime/ratelimit.ts";
import {
  SESSION_COOKIE,
  createSession,
  createUser,
  findUserByEmail,
  getUserById,
  revokeSession,
  validateSession,
} from "../../auth/sessions.ts";
import { issueTicket } from "../../auth/tickets.ts";
import { createDocument, resolveRole } from "../../auth/access.ts";
import { assets } from "../assets.ts";
import { DocumentShell } from "../ui/document.tsx";
import { routes } from "../routes.ts";

function getSessionToken(req: Request): string | null {
  const header = req.headers.get("cookie");
  if (!header) return null;
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq === -1) continue;
    if (part.slice(0, eq).trim() === SESSION_COOKIE) {
      return decodeURIComponent(part.slice(eq + 1).trim());
    }
  }
  return null;
}

function sessionCookie(token: string, url: URL, maxAge = 604800): string {
  const secure = url.protocol === "https:" ? "; Secure" : "";
  return `${SESSION_COOKIE}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${secure}`;
}

function clientIp(req: Request): string {
  const fwd = req.headers.get("x-forwarded-for");
  if (fwd) return fwd.split(",")[0].trim() || "unknown";
  return "direct";
}

// Login/registro: 20 intentos por minuto por IP (anti fuerza bruta básico).
const authLimiter = new RateLimiter({ capacity: 20, refillPerSec: 20 / 60 });

async function readCredentials(
  req: Request,
): Promise<{ email: string; password: string } | Response> {
  let email = "";
  let password = "";
  try {
    const ct = req.headers.get("content-type") ?? "";
    if (ct.includes("application/json")) {
      const body = await req.json() as { email?: unknown; password?: unknown };
      email = String(body.email ?? "");
      password = String(body.password ?? "");
    } else {
      const form = await req.formData();
      email = String(form.get("email") ?? "");
      password = String(form.get("password") ?? "");
    }
  } catch {
    return Response.json({ error: "INVALID_BODY" }, { status: 400 });
  }
  email = email.trim();
  if (!email.includes("@") || password.length === 0) {
    return Response.json({ error: "INVALID_CREDENTIALS" }, { status: 400 });
  }
  return { email, password };
}

export default createController(routes, {
  // El middleware de render también vive en el router (runtime global);
  // aquí está para que las actions tengan `context.render` tipado.
  middleware: [render({ assets })],
  actions: {
    home() {
      return new Response("synapse ok", {
        headers: { "Content-Type": "text/plain" },
      });
    },
    health() {
      return Response.json({ ok: true, service: "synapse", ws: "/ws/documents/:id" });
    },
    async register(context) {
      if (!authLimiter.take(`reg:${clientIp(context.request)}`)) {
        return Response.json({ error: "RATE_LIMITED" }, { status: 429 });
      }
      const creds = await readCredentials(context.request);
      if (creds instanceof Response) return creds;
      if (creds.password.length < 8) {
        return Response.json({ error: "WEAK_PASSWORD" }, { status: 400 });
      }
      if (await findUserByEmail(creds.email)) {
        return Response.json({ error: "EMAIL_TAKEN" }, { status: 409 });
      }
      const id = await createUser({
        email: creds.email,
        passwordHash: await hashPassword(creds.password),
      });
      const { token } = await createSession(id);
      const url = new URL(context.request.url);
      return Response.json({ id, email: creds.email }, {
        status: 201,
        headers: { "Set-Cookie": sessionCookie(token, url) },
      });
    },
    async login(context) {
      if (!authLimiter.take(`login:${clientIp(context.request)}`)) {
        return Response.json({ error: "RATE_LIMITED" }, { status: 429 });
      }
      const creds = await readCredentials(context.request);
      if (creds instanceof Response) return creds;
      const user = await findUserByEmail(creds.email);
      if (!user || !(await verifyPassword(creds.password, user.passwordHash))) {
        return Response.json({ error: "INVALID_LOGIN" }, { status: 401 });
      }
      const { token } = await createSession(user.id);
      const url = new URL(context.request.url);
      return Response.json({ id: user.id, email: creds.email }, {
        headers: { "Set-Cookie": sessionCookie(token, url) },
      });
    },
    async logout(context) {
      const token = getSessionToken(context.request);
      if (token) await revokeSession(token).catch(() => {});
      const url = new URL(context.request.url);
      return Response.json({ ok: true }, {
        headers: { "Set-Cookie": sessionCookie("revoked", url, 0) },
      });
    },
    async me(context) {
      const token = getSessionToken(context.request);
      const session = token ? await validateSession(token) : null;
      if (!session) return Response.json({ error: "UNAUTHENTICATED" }, { status: 401 });
      const user = await getUserById(session.userId);
      if (!user) return Response.json({ error: "UNAUTHENTICATED" }, { status: 401 });
      return Response.json(user);
    },
    async metrics() {
      return new Response(metrics.render(), {
        headers: { "Content-Type": "text/plain; version=0.0.4" },
      });
    },
    async createDocument(context) {
      const token = getSessionToken(context.request);
      const session = token ? await validateSession(token) : null;
      if (!session) return Response.json({ error: "UNAUTHENTICATED" }, { status: 401 });
      let title = "Untitled";
      try {
        const ct = context.request.headers.get("content-type") ?? "";
        if (ct.includes("application/json")) {
          const body = await context.request.json() as { title?: unknown };
          if (typeof body.title === "string" && body.title.trim()) title = body.title.trim();
        } else {
          const form = await context.request.formData();
          const t = form.get("title");
          if (typeof t === "string" && t.trim()) title = t.trim();
        }
      } catch {
        return Response.json({ error: "INVALID_BODY" }, { status: 400 });
      }
      const id = await createDocument({ title, createdBy: session.userId });
      return Response.json({ id, title }, { status: 201 });
    },
    async wsTicket(context) {
      const token = getSessionToken(context.request);
      const session = token ? await validateSession(token) : null;
      if (!session) return Response.json({ error: "UNAUTHENTICATED" }, { status: 401 });
      const documentId: string = context.params.id;
      const role = await resolveRole(session.userId, documentId).catch(() => null);
      if (!role) return Response.json({ error: "NOT_FOUND" }, { status: 404 });
      const { ticket } = await issueTicket(session.userId, documentId);
      return Response.json({ ticket });
    },
    async editDocument(context) {
      // Etapa 4: requiere sesión y acceso; el ticket es real y de un solo uso.
      const token = getSessionToken(context.request);
      const session = token ? await validateSession(token) : null;
      if (!session) return new Response("login required", { status: 401 });
      const documentId: string = context.params.id;
      const authRole = await resolveRole(session.userId, documentId).catch(() => null);
      if (!authRole) return new Response("not found", { status: 404 });
      const issued = await issueTicket(session.userId, documentId);
      const url = new URL(context.request.url);
      const baseUrl = `${url.protocol === "https:" ? "wss" : "ws"}://${url.host}`;
      const entry = await assets.getScriptEntry("apps/server/app/actions/public/entry.ts");
      return context.render(
        <DocumentShell
          docId={documentId}
          ticket={issued.ticket}
          baseUrl={baseUrl}
          entry={entry}
        />,
      );
    },
  },
});
