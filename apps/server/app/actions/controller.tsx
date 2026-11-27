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
import { createDocument, removeMemberGuarded, resolveRole, setMemberRole } from "../../auth/access.ts";
import { createShareLink, joinViaLink, listShareLinks, peekShareLink, revokeShareLink } from "../../auth/sharelinks.ts";
import { assets } from "../assets.ts";
import { DocumentShell } from "../ui/document.tsx";
import { JoinShell } from "../ui/join.tsx";
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

/** Une al usuario vía link de invitación (null si no hay o ya no vale). */
async function joinWithInvite(
  invite: string | undefined,
  userId: string,
): Promise<{ documentId: string; role: string } | null> {
  if (!invite) return null;
  try {
    return await joinViaLink(invite, userId);
  } catch {
    return null;
  }
}

// Login/registro: 5 intentos + 1/min por IP (ver AUTH_LIMIT).
const authLimiter = new RateLimiter(AUTH_LIMIT);

async function readCredentials(
  req: Request,
): Promise<{ email: string; password: string; invite?: string } | Response> {
  let email = "";
  let password = "";
  let invite: string | undefined;
  try {
    const ct = req.headers.get("content-type") ?? "";
    if (ct.includes("application/json")) {
      const body = await req.json() as { email?: unknown; password?: unknown; invite?: unknown };
      email = String(body.email ?? "");
      password = String(body.password ?? "");
      if (typeof body.invite === "string" && body.invite) invite = body.invite;
    } else {
      const form = await req.formData();
      email = String(form.get("email") ?? "");
      password = String(form.get("password") ?? "");
      const inv = form.get("invite");
      if (typeof inv === "string" && inv) invite = inv;
    }
  } catch {
    return Response.json({ error: "INVALID_BODY" }, { status: 400 });
  }
  email = email.trim();
  if (!email.includes("@") || password.length === 0) {
    return Response.json({ error: "INVALID_CREDENTIALS" }, { status: 400 });
  }
  return { email, password, invite };
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
      const joined = await joinWithInvite(creds.invite, id);
      if (form) {
        if (joined) return redirect(`/documents/${joined.documentId}`, { "Set-Cookie": cookie });
        if (creds.invite) return redirect("/documents?error=INVITE_INVALID", { "Set-Cookie": cookie });
        return redirect("/documents", { "Set-Cookie": cookie });
      }
      return Response.json({ id, email: creds.email, joined }, {
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
      const joined = await joinWithInvite(creds.invite, user.id);
      if (form) {
        if (joined) return redirect(`/documents/${joined.documentId}`, { "Set-Cookie": cookie });
        if (creds.invite) return redirect("/documents?error=INVITE_INVALID", { "Set-Cookie": cookie });
        return redirect("/documents", { "Set-Cookie": cookie });
      }
      return Response.json({ id: user.id, email: creds.email, joined }, {
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
    async membersUpsert(context) {
      const form = !wantsJson(context.request);
      const back = (code?: string) => {
        const id: string = context.params.id;
        return code ? redirect(`/documents/${id}?error=${code}`) : redirect(`/documents/${id}`);
      };
      const token = getSessionToken(context.request);
      const session = token ? await validateSession(token).catch(() => null) : null;
      if (!session) {
        if (form) return redirect("/login");
        return Response.json({ error: "UNAUTHENTICATED" }, { status: 401 });
      }
      const documentId: string = context.params.id;
      let email = "";
      let role = "";
      try {
        const ct = context.request.headers.get("content-type") ?? "";
        if (ct.includes("application/json")) {
          const body = await context.request.json() as { email?: unknown; role?: unknown };
          email = String(body.email ?? "");
          role = String(body.role ?? "");
        } else {
          const f = await context.request.formData();
          email = String(f.get("email") ?? "");
          role = String(f.get("role") ?? "");
        }
      } catch {
        if (form) return back("INVALID_BODY");
        return Response.json({ error: "INVALID_BODY" }, { status: 400 });
      }
      const target = await findUserByEmail(email.trim().toLowerCase()).catch(() => null);
      if (!target) {
        if (form) return back("EMAIL_NOT_FOUND");
        return Response.json({ error: "EMAIL_NOT_FOUND" }, { status: 404 });
      }
      try {
        await setMemberRole(documentId, target.id, role, session.userId);
      } catch (err) {
        const code = String((err as Error).message).split(":")[0];
        const status = code === "FORBIDDEN" ? 403 : code === "LAST_OWNER" ? 409 : 400;
        if (form) return back(code);
        return Response.json({ error: code }, { status });
      }
      if (form) return back();
      return Response.json({ ok: true, userId: target.id, role });
    },
    async membersRemove(context) {
      const form = !wantsJson(context.request);
      const back = (code?: string) => {
        const id: string = context.params.id;
        return code ? redirect(`/documents/${id}?error=${code}`) : redirect(`/documents/${id}`);
      };
      const token = getSessionToken(context.request);
      const session = token ? await validateSession(token).catch(() => null) : null;
      if (!session) {
        if (form) return redirect("/login");
        return Response.json({ error: "UNAUTHENTICATED" }, { status: 401 });
      }
      const documentId: string = context.params.id;
      let userId = "";
      try {
        const ct = context.request.headers.get("content-type") ?? "";
        if (ct.includes("application/json")) {
          const body = await context.request.json() as { userId?: unknown };
          userId = String(body.userId ?? "");
        } else {
          const f = await context.request.formData();
          userId = String(f.get("userId") ?? "");
        }
      } catch {
        if (form) return back("INVALID_BODY");
        return Response.json({ error: "INVALID_BODY" }, { status: 400 });
      }
      try {
        await removeMemberGuarded(documentId, userId, session.userId);
      } catch (err) {
        const code = String((err as Error).message).split(":")[0];
        const status = code === "FORBIDDEN" ? 403 : code === "LAST_OWNER" ? 409 : 400;
        if (form) return back(code);
        return Response.json({ error: code }, { status });
      }
      if (form) return back();
      return Response.json({ ok: true, userId });
    },
    async shareCreate(context) {
      const form = !wantsJson(context.request);
      const back = (code?: string) => {
        const id: string = context.params.id;
        return code ? redirect(`/documents/${id}?error=${code}`) : redirect(`/documents/${id}`);
      };
      const token = getSessionToken(context.request);
      const session = token ? await validateSession(token).catch(() => null) : null;
      if (!session) {
        if (form) return redirect("/login");
        return Response.json({ error: "UNAUTHENTICATED" }, { status: 401 });
      }
      const documentId: string = context.params.id;
      let role = "editor";
      let maxUses: number | null = 10;
      let expiresInHours = 168;
      try {
        const ct = context.request.headers.get("content-type") ?? "";
        if (ct.includes("application/json")) {
          const body = await context.request.json() as { role?: unknown; maxUses?: unknown; expiresInHours?: unknown };
          if (body.role !== undefined) role = String(body.role);
          if (body.maxUses !== undefined) maxUses = body.maxUses === null ? null : Number(body.maxUses);
          if (body.expiresInHours !== undefined) expiresInHours = Number(body.expiresInHours);
        } else {
          const f = await context.request.formData();
          role = String(f.get("role") ?? "editor");
          maxUses = f.get("maxUses") === null || f.get("maxUses") === "" ? 10 : Number(f.get("maxUses"));
          expiresInHours = f.get("expiresInHours") === null || f.get("expiresInHours") === "" ? 168 : Number(f.get("expiresInHours"));
        }
      } catch {
        if (form) return back("INVALID_BODY");
        return Response.json({ error: "INVALID_BODY" }, { status: 400 });
      }
      if (!Number.isFinite(expiresInHours) || expiresInHours <= 0 || expiresInHours > 24 * 90) {
        if (form) return back("INVALID_BODY");
        return Response.json({ error: "INVALID_BODY" }, { status: 400 });
      }
      if (maxUses !== null && (!Number.isInteger(maxUses) || maxUses <= 0)) {
        if (form) return back("INVALID_BODY");
        return Response.json({ error: "INVALID_BODY" }, { status: 400 });
      }
      try {
        const link = await createShareLink(documentId, session.userId, { role, maxUses, expiresInHours });
        const url = `/join/${link.token}`;
        if (form) return redirect(`/documents/${documentId}?share=${link.token}`);
        return Response.json({ ok: true, id: link.id, url });
      } catch (err) {
        const code = String((err as Error).message).split(":")[0];
        const status = code === "FORBIDDEN" ? 403 : 400;
        if (form) return back(code);
        return Response.json({ error: code }, { status });
      }
    },
    async shareRevoke(context) {
      const form = !wantsJson(context.request);
      const back = (code?: string) => {
        const id: string = context.params.id;
        return code ? redirect(`/documents/${id}?error=${code}`) : redirect(`/documents/${id}`);
      };
      const token = getSessionToken(context.request);
      const session = token ? await validateSession(token).catch(() => null) : null;
      if (!session) {
        if (form) return redirect("/login");
        return Response.json({ error: "UNAUTHENTICATED" }, { status: 401 });
      }
      const documentId: string = context.params.id;
      let linkId = "";
      try {
        const ct = context.request.headers.get("content-type") ?? "";
        if (ct.includes("application/json")) {
          const body = await context.request.json() as { linkId?: unknown };
          linkId = String(body.linkId ?? "");
        } else {
          const f = await context.request.formData();
          linkId = String(f.get("linkId") ?? "");
        }
      } catch {
        if (form) return back("INVALID_BODY");
        return Response.json({ error: "INVALID_BODY" }, { status: 400 });
      }
      try {
        await revokeShareLink(documentId, linkId, session.userId);
      } catch (err) {
        const code = String((err as Error).message).split(":")[0];
        const status = code === "FORBIDDEN" ? 403 : 400;
        if (form) return back(code);
        return Response.json({ error: code }, { status });
      }
      if (form) return back();
      return Response.json({ ok: true, linkId });
    },
    async joinPage(context) {
      const token: string = context.params.token;
      const peek = await peekShareLink(token).catch(() => null);
      const sessionToken = getSessionToken(context.request);
      const session = sessionToken ? await validateSession(sessionToken).catch(() => null) : null;
      if (session) {
        if (!peek || !peek.valid) return redirect("/documents?error=INVITE_INVALID");
        const joined = await joinViaLink(token, session.userId).catch(() => null);
        if (!joined) return redirect("/documents?error=INVITE_INVALID");
        return redirect(`/documents/${joined.documentId}`);
      }
      return context.render(
        <JoinShell token={token} peek={peek} />,
      );
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
      const url2 = new URL(context.request.url);
      const memberError = url2.searchParams.get("error") ?? undefined;
      const shareToken = url2.searchParams.get("share") ?? undefined;
      const shareLinks = authRole === "owner" ? await listShareLinks(documentId, session.userId).catch(() => []) : [];
      return context.render(
        <DocumentShell
          docId={documentId}
          title={title}
          ticket={issued.ticket}
          baseUrl={baseUrl}
          origin={url2.origin}
          email={user?.email ?? ""}
          role={authRole}
          docs={docs}
          memberError={memberError}
          shareToken={shareToken}
          shareLinks={shareLinks}
          q={q}
          members={members}
          activity={activity}
        />,
      );
    },
  },
});
