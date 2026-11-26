import { render } from "remix/middleware/render";
import { createController } from "remix/router";

import { hashPassword, verifyPassword } from "../../auth/password.ts";
import {
  SESSION_COOKIE,
  createSession,
  createUser,
  findUserByEmail,
  getUserById,
  revokeSession,
  validateSession,
} from "../../auth/sessions.ts";
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
    async editDocument(context) {
      // Ticket de prueba con forma final (Etapa 1/4): presencia + longitud mínima.
      const ticket = crypto.randomUUID().replaceAll("-", "");
      const url = new URL(context.request.url);
      const baseUrl = `${url.protocol === "https:" ? "wss" : "ws"}://${url.host}`;
      const entry = await assets.getScriptEntry("apps/server/app/actions/public/entry.ts");
      return context.render(
        <DocumentShell
          docId={context.params.id}
          ticket={ticket}
          baseUrl={baseUrl}
          entry={entry}
        />,
      );
    },
  },
});
