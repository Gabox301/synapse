import type { Handle } from "remix/component";

import type {
  DocActivity,
  DocumentMember,
  ListedDocument,
} from "../../realtime/persistence.ts";

const CURSOR_COLORS = [
  "#e6194b",
  "#3cb44b",
  "#0082c8",
  "#f58231",
  "#911eb4",
  "#46f0f0",
  "#f032e6",
  "#008080",
];

function colorFor(seed: string): string {
  let hash = 0;
  for (let i = 0; i < seed.length; i++) hash = ((hash * 31) + seed.charCodeAt(i)) >>> 0;
  return CURSOR_COLORS[hash % CURSOR_COLORS.length];
}

const MEMBER_ERRORS: Record<string, string> = {
  FORBIDDEN: "Solo un owner gestiona miembros.",
  EMAIL_NOT_FOUND: "Ese email no está registrado.",
  LAST_OWNER: "El documento necesita al menos un owner: transferí antes de salir.",
  INVALID_ROLE: "Rol inválido (owner, editor o viewer).",
  INVALID_BODY: "Revisá los datos del formulario.",
};

function ago(iso: string): string {
  const s = Math.max(0, Math.floor((Date.now() - new Date(iso).getTime()) / 1000));
  if (s < 10) return "ahora mismo";
  if (s < 60) return `hace ${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `hace ${m} min`;
  const h = Math.floor(m / 60);
  if (h < 24) return `hace ${h} h`;
  return `hace ${Math.floor(h / 24)} d`;
}

function recentAt(updatedAt: string): boolean {
  return Date.now() - new Date(updatedAt).getTime() < 3_600_000;
}

/**
 * Workspace rail (design/synapse-ide/02-workspace-rail): topbar con
 * breadcrumb, tabs, sidebar con filtro/secciones/miembros, rail derecho
 * con presencia y actividad real de PG, y statusbar con estado vivo.
 */
export function DocumentShell(
  handle: Handle<{
    docId: string;
    title: string;
    ticket: string;
    baseUrl: string;
    email: string;
    role: string;
    docs: ListedDocument[];
    q: string;
    members: DocumentMember[];
    activity: DocActivity[];
    memberError?: string;
  }>,
) {
  const { docId, title, ticket, baseUrl, email, role, docs, q, members, activity, memberError } = handle.props;
  const mine = docs.filter((d) => d.mine);
  const shared = docs.filter((d) => !d.mine);
  const isOwner = role === "owner";
  return () => (
    <html lang="es">
      <head>
        <meta charset="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <title>Synapse — {title}</title>
        <link rel="stylesheet" href="/assets/app/ui/public/shell.css" />
      </head>
      <body class="syn-ide">
        <header class="syn-topbar">
          <div class="syn-brandline">
            <a href="/documents" class="syn-logo">Synapse</a>
            <nav class="syn-crumbs" aria-label="Ubicación">
              <a href="/documents">Mis documentos</a>
              <span aria-hidden="true">/</span>
              <b>{title}</b>
            </nav>
          </div>
          <div class="syn-userbox">
            <span id="syn-conn-top" class="syn-dot" data-state="connecting">conectando</span>
            <span class="syn-email">{email}</span>
            <form method="post" action="/api/logout">
              <button type="submit" class="syn-ghost">Salir</button>
            </form>
          </div>
        </header>
        <div class="syn-ide-body">
          <aside class="syn-sidebar">
            <div class="syn-sidehead">
              <span>Documentos</span>
              <a href="/documents" class="syn-mini">＋</a>
            </div>
            <form method="get" class="syn-filterrow">
              <input type="search" name="q" value={q} placeholder="Filtrar…" aria-label="Filtrar documentos" />
            </form>
            <ul class="syn-sidelist">
              {mine.map((d) => (
                <li key={d.id} class={d.id === docId ? "syn-active" : ""}>
                  <a href={`/documents/${d.id}`}>{d.title || d.id}</a>
                  <span class={recentAt(d.updatedAt) ? "syn-st-ok" : "syn-st-idle"} title={d.updatedAt}>●</span>
                </li>
              ))}
            </ul>
            {shared.length > 0 ? (
              <div class="syn-sidesec">
                <div class="syn-sidehead"><span>Compartidos conmigo</span></div>
                <ul class="syn-sidelist">
                  {shared.map((d) => (
                    <li key={d.id} class={d.id === docId ? "syn-active" : ""}>
                      <a href={`/documents/${d.id}`}>{d.title || d.id}</a>
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}
            <div class="syn-sidesec">
              <div class="syn-sidehead"><span>Miembros</span></div>
              {memberError ? (
                <p class="syn-error" role="alert">{MEMBER_ERRORS[memberError] ?? memberError}</p>
              ) : null}
              <ul class="syn-members">
                {members.map((m) => (
                  <li key={m.userId}>
                    <i style={{ background: colorFor(m.email) }}>{m.email.slice(0, 1).toUpperCase()}</i>
                    <span>{m.email}<small>{m.email === email ? "vos" : m.role}</small></span>
                    <span class="syn-role">{m.role}</span>
                  </li>
                ))}
              </ul>
              {isOwner ? (
                <form method="post" action={`/api/documents/${docId}/members`} class="syn-miniform">
                  <input type="email" name="email" required placeholder="email@x.test" aria-label="Email del miembro" />
                  <select name="role" aria-label="Rol" defaultValue="editor">
                    <option value="editor">editor</option>
                    <option value="viewer">viewer</option>
                    <option value="owner">owner</option>
                  </select>
                  <button type="submit">Agregar</button>
                </form>
              ) : null}
              {isOwner ? members.filter((m) => m.email !== email).map((m) => (
                <form key={m.userId} method="post" action={`/api/documents/${docId}/members/remove`} class="syn-miniform">
                  <input type="hidden" name="userId" value={m.userId} />
                  <span class="syn-note">{m.email}</span>
                  <button type="submit" class="syn-danger">Quitar</button>
                </form>
              )) : null}
            </div>
          </aside>
          <div class="syn-main">
            <div class="syn-tabs" role="tablist">
              <a href={`/documents/${docId}`} role="tab" aria-selected="true">{title}</a>
              <a href="/documents" role="tab" aria-selected="false" title="Todos">＋</a>
            </div>
            <main class="syn-editorpane">
              <div
                id="syn-editor"
                data-doc-id={docId}
                data-ticket={ticket}
                data-base-url={baseUrl}
                data-name={email.split("@")[0] || "anon"}
              >
                <p>Conectando al documento…</p>
              </div>
            </main>
          </div>
          <aside class="syn-rail">
            <div>
              <div class="syn-sidehead"><span>En línea — <b id="syn-online">…</b></span></div>
              <p class="syn-note">Los cursores aparecen en el editor con el color de cada miembro.</p>
            </div>
            <div>
              <div class="syn-sidehead"><span>Actividad</span></div>
              {activity.length === 0 ? (
                <p class="syn-empty">Todavía no hay commits en este documento.</p>
              ) : (
                <ul class="syn-feed">
                  {activity.map((a) => (
                    <li key={a.seq}>
                      <b>{a.email ?? "alguien"}</b> confirmó seq {a.seq}
                      <time>{ago(a.at)}</time>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </aside>
        </div>
        <footer class="syn-status">
          <span id="syn-conn" class="syn-dot" data-state="connecting">conectando…</span>
          <span class="syn-sep">·</span>
          <span>rol: {role}</span>
          <span class="syn-sep">·</span>
          <span>
            seq: <b id="syn-seq">…</b>
          </span>
        </footer>
        <script type="module" src="/assets/app/actions/documents/edit/public/editor.bundle.js"></script>
      </body>
    </html>
  );
}
