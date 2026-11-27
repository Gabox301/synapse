import type { Handle } from "remix/component";

import type { ShareLinkPeek } from "../../auth/sharelinks.ts";

const JOIN_ERRORS: Record<string, string> = {
  REVOKED: "Este enlace fue revocado.",
  EXPIRED: "Este enlace venció.",
  USED_UP: "Este enlace ya se usó todas las veces.",
  INVALID_BODY: "Revisá los datos del formulario.",
  EMAIL_TAKEN: "Ese email ya está registrado. Entrá con tu contraseña.",
  INVALID_LOGIN: "Email o contraseña incorrectos.",
  WEAK_PASSWORD: "La contraseña necesita al menos 8 caracteres.",
  RATE_LIMITED: "Demasiados intentos. Esperá un minuto y probá de nuevo.",
};

export function JoinShell(handle: Handle<{ token: string; peek: ShareLinkPeek | null; error?: string }>) {
  const { token, peek, error } = handle.props;
  const invalidReason = !peek ? "Este enlace no existe." : !peek.valid ? JOIN_ERRORS[peek.reason ?? ""] ?? "Enlace inválido." : null;
  return () => (
    <html lang="es">
      <head>
        <meta charset="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <title>Synapse — unirse</title>
        <link rel="stylesheet" href="/assets/app/ui/public/shell.css" />
      </head>
      <body>
        <main class="syn-auth">
          <header class="syn-brand">
            <h1>Synapse</h1>
            <p>Te invitaron a colaborar</p>
          </header>
          {error ? <p class="syn-error" role="alert">{JOIN_ERRORS[error] ?? error}</p> : null}
          {invalidReason ? (
            <section class="syn-card">
              <h2>Enlace no válido</h2>
              <p class="syn-empty">{invalidReason} Pedí un enlace nuevo.</p>
              <p><a href="/login">Ir a entrar</a></p>
            </section>
          ) : peek ? (
            <>
              <p>Documento: <b>{peek.title}</b> · rol: <span class="syn-role">{peek.role}</span></p>
              <section class="syn-card">
                <h2>Crear cuenta y unirse</h2>
                <form method="post" action="/api/register">
                  <input type="hidden" name="invite" value={token} />
                  <label>
                    Email
                    <input type="email" name="email" required autocomplete="email" />
                  </label>
                  <label>
                    Contraseña
                    <input type="password" name="password" required minLength={8} autocomplete="new-password" />
                  </label>
                  <button type="submit">Crear cuenta y entrar</button>
                </form>
              </section>
              <section class="syn-card">
                <h2>Ya tengo cuenta</h2>
                <form method="post" action="/api/login">
                  <input type="hidden" name="invite" value={token} />
                  <label>
                    Email
                    <input type="email" name="email" required autocomplete="email" />
                  </label>
                  <label>
                    Contraseña
                    <input type="password" name="password" required minLength={8} autocomplete="current-password" />
                  </label>
                  <button type="submit">Entrar y unirse</button>
                </form>
              </section>
            </>
          ) : null}
        </main>
      </body>
    </html>
  );
}
