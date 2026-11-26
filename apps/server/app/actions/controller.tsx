import { render } from "remix/middleware/render";
import { createController } from "remix/router";

import { assets } from "../assets.ts";
import { DocumentShell } from "../ui/document.tsx";
import { routes } from "../routes.ts";

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
