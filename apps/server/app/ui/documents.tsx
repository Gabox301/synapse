import type { Handle } from "remix/component";

import type { ListedDocument } from "../../realtime/persistence.ts";

export function DocsShell(
  handle: Handle<{ email: string; docs: ListedDocument[]; error?: string }>,
) {
  const { email, docs, error } = handle.props;
  const friendly: Record<string, string> = {
    INVITE_INVALID: "Ese enlace de invitación ya no vale. Pedí uno nuevo.",
    INTERNAL: "Algo falló. Probá de nuevo.",
  };
  const shownError = error ? friendly[error] ?? error : undefined;
  return () => (
    <html lang="es">
      <head>
        <meta charset="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <title>Synapse — mis documentos</title>
        <link rel="stylesheet" href="/assets/app/ui/public/shell.css" />
      </head>
      <body>
        <header class="syn-topbar">
          <div>
            <h1>Synapse</h1>
            <p>{email}</p>
          </div>
          <form method="post" action="/api/logout">
            <button type="submit" class="syn-ghost">Salir</button>
          </form>
        </header>
        <main class="syn-docs">
          {shownError ? <p class="syn-error" role="alert">{shownError}</p> : null}
          <section class="syn-card">
            <h2>Nuevo documento</h2>
            <form method="post" action="/api/documents" class="syn-row">
              <input type="text" name="title" placeholder="Título" maxLength={120} />
              <select name="kind" aria-label="Tipo de documento" defaultValue="prose">
                <option value="prose">Prosa</option>
                <option value="code">Código</option>
              </select>
              <button type="submit">Crear</button>
            </form>
          </section>
          <section class="syn-card">
            <h2>Mis documentos</h2>
            {docs.length === 0 ? (
              <p class="syn-empty">Todavía no tenés documentos. Creá el primero arriba.</p>
            ) : (
              <ul class="syn-list">
                {docs.map((d) => (
                  <li key={d.id}>
                    <a href={`/documents/${d.id}`}>{d.title || d.id}</a>
                    <span class="syn-role">{d.role}</span>
                  </li>
                ))}
              </ul>
            )}
          </section>
        </main>
      </body>
    </html>
  );
}
