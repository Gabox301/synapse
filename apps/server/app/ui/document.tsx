import type { Handle } from "remix/component";

import type { ListedDocument } from "../../realtime/persistence.ts";

/**
 * Shell IDE del editor. El editor es un bundle esbuild autocontenido
 * (boot.ts + mountEditor); esta página solo renderiza el contenedor con la
 * sesión en data attrs, sin clientEntry de Remix.
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
  }>,
) {
  const { docId, title, ticket, baseUrl, email, role, docs } = handle.props;
  const name = email.split("@")[0] || "anon";
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
            <span class="syn-divider">/</span>
            <span class="syn-doctitle">{title}</span>
          </div>
          <div class="syn-userbox">
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
            <ul class="syn-sidelist">
              {docs.map((d) => (
                <li key={d.id} class={d.id === docId ? "syn-active" : ""}>
                  <a href={`/documents/${d.id}`}>{d.title || d.id}</a>
                </li>
              ))}
            </ul>
          </aside>
          <main class="syn-editorpane">
            <div
              id="syn-editor"
              data-doc-id={docId}
              data-ticket={ticket}
              data-base-url={baseUrl}
              data-name={name}
            >
              <p>Conectando al documento…</p>
            </div>
          </main>
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
