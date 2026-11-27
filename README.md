# Synapse — motor colaborativo en tiempo real

Edición simultánea estilo Google Docs: WebSocket propio con protocolo
**SNP v1**, CRDT (**Yjs**), presencia y cursores, persistencia en
**PostgreSQL** y arquitectura distribuida con **Redis**. Runtime
**Deno 2** + **Remix v3** full-stack.

## Estructura

- `apps/server/` — servidor Deno + Remix (WS `/ws/*`, HTTP/API, editor).
- `packages/sdk/` — [@synapse/sdk](packages/sdk/README.md): cliente TS.
- `packages/protocol/` — protocolo SNP v1 (frames, errores, tipos, schema).
- `docs/` — [diseño y roadmap](docs/synapse-proyecto.md) · [spec SNP v1](docs/snp-v1.md) · [evolución de schema](docs/schema-evolution.md).

## Desarrollo

Requisitos: Deno 2, Docker (PostgreSQL), `REDIS_URL` en `.env`
(solo para modo distribuido; sin ella todo corre local en una instancia).

```bash
docker compose up -d postgres
deno task migrate
deno task dev      # servidor en :44100
deno task test     # suite canónica (con check)
deno task build-sdk  # paquete npm del SDK en ./npm/sdk (dry-run: npm publish --dry-run)
```

## Licencia

MIT — ver [LICENSE](LICENSE).
