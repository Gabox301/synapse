import type { Handle } from "remix/component";

const FRIENDLY: Record<string, string> = {
  INVALID_LOGIN: "Email o contraseña incorrectos.",
  EMAIL_TAKEN: "Ese email ya está registrado. Entrá con tu contraseña.",
  WEAK_PASSWORD: "La contraseña necesita al menos 8 caracteres.",
  INVALID_CREDENTIALS: "Revisá los datos del formulario.",
  UNAUTHENTICATED: "Tenés que entrar primero.",
  NOT_FOUND: "No existe o no tenés acceso.",
  RATE_LIMITED: "Demasiados intentos. Esperá un minuto y probá de nuevo.",
  INVALID_BODY: "Revisá los datos del formulario.",
  INTERNAL: "Algo falló. Probá de nuevo.",
};

export function LoginShell(handle: Handle<{ error?: string; email?: string }>) {
  const { error, email } = handle.props;
  return () => (
    <html lang="es">
      <head>
        <meta charset="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <title>Synapse — entrar</title>
        <link rel="stylesheet" href="/assets/app/ui/public/shell.css" />
      </head>
      <body>
        <main class="syn-auth">
          <header class="syn-brand">
            <h1>Synapse</h1>
            <p>Colaboración en tiempo real</p>
          </header>
          {error ? <p class="syn-error" role="alert">{FRIENDLY[error] ?? error}</p> : null}
          <section class="syn-card">
            <h2>Entrar</h2>
            <form method="post" action="/api/login">
              <label>
                Email
                <input type="email" name="email" required autocomplete="email" value={email ?? ""} />
              </label>
              <label>
                Contraseña
                <input type="password" name="password" required minLength={8} autocomplete="current-password" />
              </label>
              <button type="submit">Entrar</button>
            </form>
          </section>
          <section class="syn-card">
            <h2>Crear cuenta</h2>
            <form method="post" action="/api/register">
              <label>
                Email
                <input type="email" name="email" required autocomplete="email" value={email ?? ""} />
              </label>
              <label>
                Contraseña
                <input type="password" name="password" required minLength={8} autocomplete="new-password" />
              </label>
              <button type="submit">Crear cuenta</button>
            </form>
          </section>
        </main>
      </body>
    </html>
  );
}
