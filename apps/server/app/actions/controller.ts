import { createController } from "remix/router";

import { routes } from "../routes.ts";

export default createController(routes, {
  actions: {
    home() {
      return new Response("synapse ok", {
        headers: { "Content-Type": "text/plain" },
      });
    },
    health() {
      return Response.json({ ok: true, service: "synapse", ws: "/ws/documents/:id" });
    },
  },
});
