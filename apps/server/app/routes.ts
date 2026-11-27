import { get, post, route } from "remix/routes";

export const routes = route({
  home: get("/"),
  health: get("/api/health"),
  loginPage: get("/login"),
  documentsPage: get("/documents"),
  editDocument: get("/documents/:id"),
  createDocument: post("/api/documents"),
  wsTicket: post("/api/documents/:id/ws-ticket"),
  membersUpsert: post("/api/documents/:id/members"),
  membersRemove: post("/api/documents/:id/members/remove"),
  shareCreate: post("/api/documents/:id/share"),
  shareRevoke: post("/api/documents/:id/share/revoke"),
  joinPage: get("/join/:token"),
  register: post("/api/register"),
  login: post("/api/login"),
  logout: post("/api/logout"),
  me: get("/api/me"),
  metrics: get("/api/metrics"),
});
