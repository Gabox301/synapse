import { get, post, route } from "remix/routes";

export const routes = route({
  home: get("/"),
  health: get("/api/health"),
  editDocument: get("/documents/:id"),
  createDocument: post("/api/documents"),
  wsTicket: post("/api/documents/:id/ws-ticket"),
  register: post("/api/register"),
  login: post("/api/login"),
  logout: post("/api/logout"),
  me: get("/api/me"),
  metrics: get("/api/metrics"),
});
