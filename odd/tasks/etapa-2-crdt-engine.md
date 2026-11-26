# Etapa 2 — CRDT Engine (Deno + Remix v3 + Yjs)

Stack: Deno 2 + Remix v3 full-stack + WS propio SNP v1 + Yjs. Realtime en `apps/server/realtime/`, protocolo en `packages/protocol`, cliente en `packages/sdk`, editor TipTap vanilla en `clientEntry` fuera de `<Frame>`.

## Specs

- S1: "Etapa 2 completa" — "SYNC_STEP1/2, UPDATE con cseq, AWARENESS + SDK vanilla + editor"
- S2: "Listo. Ahora si podemos avanzar más en el proyecto"
- S3: Frames SNP v1 (de `synapse-proyecto.md` sec 6): `0x01 SYNC_STEP1`, `0x02 SYNC_STEP2`, `0x03 UPDATE` (u32 cseq big-endian + update Yjs), `0x04 AWARENESS` (y-protocols); control JSON `document:joined` / `document:ack` / `document:error` / `connection:ping/pong`
- S4: Una conexión por documento; `server.ts` bifurca `/ws/*` vs `router.fetch`; `Y.Doc` en memoria por documento activo; una única versión de `yjs` en todo el workspace
- S5: Editor TipTap Core vanilla en `clientEntry` fuera de `<Frame>`; Frames solo shell; `packages/protocol,shared,sdk` runtime-agnósticos (sin APIs exclusivas de Deno)

## Tasks

- T1 (S1,S3,S5, route: inline, commit: -): `packages/protocol` — tipos, frames binarios, cseq, errores/cierres SNP v1
- T2 (S1,S3,S4, route: inline, commit: -): `apps/server/realtime/` — SYNC_STEP1/2, UPDATE con cseq, AWARENESS en memoria + validación/broadcast
- T3 (S1,S4,S5, route: inline, commit: -): `packages/sdk` — cliente TS SNP vanilla con Yjs + y-protocols (clientEntry)
- T4 (S1,S5, route: inline, commit: -): editor TipTap Core vanilla en `clientEntry` consumiendo SDK, fuera de `<Frame>`
- T5 (S1,S3,S4, route: inline, commit: -): verificación — 2 clientes convergen, resync por state vector, heartbeat y límites

## Log

- L1: "Listo. Ahora si podemos avanzar más en el proyecto" + selección "Etapa 2 completa" ("SYNC_STEP1/2, UPDATE con cseq, AWARENESS + SDK vanilla + editor")
