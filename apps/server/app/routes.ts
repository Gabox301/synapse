import { get, post, route } from "remix/routes";

export const routes = route({
  home: get("/"),
  health: get("/api/health"),
  editDocument: get("/documents/:id"),
  register: post("/api/register"),
  login: post("/api/login"),
  logout: post("/api/logout"),
  me: get("/api/me"),
});
