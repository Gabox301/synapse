import { render } from "remix/middleware/render";
import { createController } from "remix/router";

import { hashPassword, verifyPassword } from "../../auth/password.ts";
import { metrics } from "../../realtime/metrics.ts";
import { AUTH_LIMIT, RateLimiter } from "../../realtime/ratelimit.ts";
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
import { LoginShell } from "../ui/login.tsx";
import { DocsShell } from "../ui/documents.tsx";
import { listDocumentMembers, listDocumentsForUser, recentActivity } from "../../realtime/persistence.ts";
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

/** Los forms HTML esperan redirects; la API JSON mantiene sus respuestas. */
function wantsJson(req: Request): boolean {
  return (req.headers.get("content-type") ?? "").includes("application/json");
}

function redirect(path: string, headers?: HeadersInit): Response {
  return new Response(null, { status: 303, headers: { Location: path, ...headers } });
}

function loginRedirect(code: string, email: string): Response {
  const q = new URLSearchParams({ error: code, email });
  return redirect(`/login?${q}`);
}

// Login/registro: 5 intentos + 1/min por IP (ver AUTH_LIMIT).
const authLimiter = new RateLimiter(AUTH_LIMIT);

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
    async loginPage(context) {
      const token = getSessionToken(context.request);
      if (token && await validateSession(token).catch(() => null)) {
        return redirect("/documents");
      }
      const q = new URL(context.request.url).searchParams;
      return context.render(
        <LoginShell error={q.get("error") ?? undefined} email={q.get("email") ?? undefined} />,
      );
    },
    async documentsPage(context) {
      const token = getSessionToken(context.request);
      const session = token ? await validateSession(token).catch(() => null) : null;
      if (!session) return redirect("/login");
      const q = new URL(context.request.url).searchParams;
      try {
        const user = await getUserById(session.userId);
        const docs = await listDocumentsForUser(session.userId);
        return context.render(
          <DocsShell email={user?.email ?? ""} docs={docs} error={q.get("error") ?? undefined} />,
        );
      } catch (err) {
        console.error("[ui] documentsPage falló:", err);
        const user = await getUserById(session.userId).catch(() => null);
        return context.render(
          <DocsShell email={user?.email ?? ""} docs={[]} error="INTERNAL" />,
        );
      }
    },
    async register(context) {
      const form = !wantsJson(context.request);
      if (!authLimiter.take(`reg:${clientIp(context.request)}`)) {
        if (form) return loginRedirect("RATE_LIMITED", "");
        return Response.json({ error: "RATE_LIMITED" }, { status: 429 });
      }
      const creds = await readCredentials(context.request);
      if (creds instanceof Response) {
        if (form) return loginRedirect("INVALID_BODY", "");
        return creds;
      }
      if (creds.password.length < 8) {
        if (form) return loginRedirect("WEAK_PASSWORD", creds.email);
        return Response.json({ error: "WEAK_PASSWORD" }, { status: 400 });
      }
      if (await findUserByEmail(creds.email)) {
        if (form) return loginRedirect("EMAIL_TAKEN", creds.email);
        return Response.json({ error: "EMAIL_TAKEN" }, { status: 409 });
      }
      const id = await createUser({
        email: creds.email,
        passwordHash: await hashPassword(creds.password),
      });
      const { token } = await createSession(id);
      const url = new URL(context.request.url);
      const cookie = sessionCookie(token, url);
      if (form) return redirect("/documents", { "Set-Cookie": cookie });
      return Response.json({ id, email: creds.email }, {
        status: 201,
        headers: { "Set-Cookie": cookie },
      });
    },
    async login(context) {
      const form = !wantsJson(context.request);
      if (!authLimiter.take(`login:${clientIp(context.request)}`)) {
        if (form) return loginRedirect("RATE_LIMITED", "");
        return Response.json({ error: "RATE_LIMITED" }, { status: 429 });
      }
      const creds = await readCredentials(context.request);
      if (creds instanceof Response) {
        if (form) return loginRedirect("INVALID_BODY", "");
        return creds;
      }
      const user = await findUserByEmail(creds.email);
      if (!user || !(await verifyPassword(creds.password, user.passwordHash))) {
        if (form) return loginRedirect("INVALID_LOGIN", creds.email);
        return Response.json({ error: "INVALID_LOGIN" }, { status: 401 });
      }
      const { token } = await createSession(user.id);
      const url = new URL(context.request.url);
      const cookie = sessionCookie(token, url);
      if (form) return redirect("/documents", { "Set-Cookie": cookie });
      return Response.json({ id: user.id, email: creds.email }, {
        headers: { "Set-Cookie": cookie },
      });
    },
    async logout(context) {
      const token = getSessionToken(context.request);
      if (token) await revokeSession(token).catch(() => {});
      const url = new URL(context.request.url);
      const cookie = sessionCookie("revoked", url, 0);
      if (!wantsJson(context.request)) return redirect("/login", { "Set-Cookie": cookie });
      return Response.json({ ok: true }, {
        headers: { "Set-Cookie": cookie },
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
      const form = !wantsJson(context.request);
      if (!session) {
        if (form) return redirect("/login");
        return Response.json({ error: "UNAUTHENTICATED" }, { status: 401 });
      }
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
        if (form) return redirect("/documents?error=INVALID_BODY");
        return Response.json({ error: "INVALID_BODY" }, { status: 400 });
      }
      const id = await createDocument({ title, createdBy: session.userId });
      if (form) return redirect(`/documents/${id}`);
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
      if (!session) return redirect("/login");
      const documentId: string = context.params.id;
      const authRole = await resolveRole(session.userId, documentId).catch(() => null);
      if (!authRole) return new Response("not found", { status: 404 });
      const issued = await issueTicket(session.userId, documentId);
      const url = new URL(context.request.url);
      const baseUrl = `${url.protocol === "https:" ? "wss" : "ws"}://${url.host}`;
      const user = await getUserById(session.userId).catch(() => null);
      const allDocs = await listDocumentsForUser(session.userId).catch(() => []);
      const q = new URL(context.request.url).searchParams.get("q")?.trim() ?? "";
      const docs = q
        ? allDocs.filter((d) => (d.title || d.id).toLowerCase().includes(q.toLowerCase()))
        : allDocs;
      const members = await listDocumentMembers(documentId).catch(() => []);
      const activity = await recentActivity(documentId, 8).catch(() => []);
      const title = allDocs.find((d) => d.id === documentId)?.title || documentId;
      return context.render(
        <DocumentShell
          docId={documentId}
          title={title}
          ticket={issued.ticket}
          baseUrl={baseUrl}
          email={user?.email ?? ""}
          role={authRole}
          docs={docs}
          q={q}
          members={members}
          activity={activity}
        />,
      );
    },
  },
});
