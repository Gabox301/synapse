# Etapa 1 — WebSocket Core (Deno + Remix v3)

Stack decidido: Deno 2 como runtime, Remix v3 full-stack para HTTP/UI, WS propio fuera de `router.fetch`. Sin Hono, sin Vite React, sin InsForge en el realtime.

## Specs

- S1: "Podemos usar deno como runtime y remix como ui? https://docs.remix.run/"
- S2: "Pero el objetivo si es crear logins. Sino entonces cualquiera puede hacer ediciones. La idea es colaborar pero de forma controlada."
- S3: "Y ahi alguna manera de acoplarlo? Cambiando lo que está documentado"
- S4: Decisión UI: "Acoplar Remix v3 full-stack"
- S5: "Ok. Entonces como lo podemos armar?"
- S6: Handshake con forma final desde Etapa 1: ticket (prueba hasta Etapa 4 pero misma forma), validación de `Origin`, subprotocolo `snp.v1`, una conexión por documento.
- S7: `server.ts` bifurca: `/ws/*` al handler WS Synapse, resto a `router.fetch`. Editor `clientEntry` fuera de `<Frame>`; Frames solo para shell.

## Tasks

- T1 (S1,S6,S7, route: inline, commit: -): Inicializar repo git + workspace Deno + scaffold Remix v3 + Docker Compose base
- T2 (S6,S7, route: inline, commit: -): Implementar `server.ts` bifurcado + WS core (rooms, heartbeat, límites, handshake con ticket prueba)
- T3 (S2,S6, route: inline, commit: -): Dejar handshake listo para auth real sin rework (ticket, Origin, snp.v1, 401/403/400)
- T4 (S5,S6, route: inline, commit: -): Verificación enfocada (conexión, broadcast, rechazo sin ticket)

## Log

- L1: "Dale" (segundo, autoriza arrancar Etapa 1 tras el parche doc Deno + Remix v3)
- L2: Decisiones previas verbatim: S1, S2, S3, S4, "https://docs.remix.run/streaming-ui-with-frames/ remix soporta streams", "Y si metemos insforge para el realtime?", S5, "Dale" (primero, autoriza parche doc)
- L3: InsForge descartado para realtime del editor (solo evaluable para shell); se mantiene WS propio + SNP + ack
- L4: Tooling 2026-11-24: WSL sin repo git, sin Deno, node solo como `node.exe` Windows v24.22.1. Bloquea T1 hasta definir instalación/WSL vs Windows
- L5: Verificación Etapa 1 (2026-11-24, live, sin tests automatizados aún): `GET /` → `synapse ok`; `GET /api/health` → `{"ok":true}`; `GET /ws/documents/doc1` sin ticket → 401; WS `snp.v1` con ticket → `document:joined` (seq 0) + `connection:pong` + broadcast entre 2 clientes OK. Deps: `remix 3.3.0`, `yjs 13.6.33`, `deno 2.9.8`, `node 26.13.1`. Cambios sin commit en `feature/etapa-1-ws-core`.
