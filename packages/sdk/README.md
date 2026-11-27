# @synapse/sdk

Cliente TypeScript para [Synapse](../../README.md): motor colaborativo en
tiempo real (Yjs + protocolo SNP v1 sobre WebSocket).

## Instalación

```bash
npm i @synapse/sdk
```

Requiere Node 20+ (usa `WebSocket` global) o un navegador moderno.
`yjs` y `y-protocols` vienen como dependencias del paquete.

> `indexedDbStorage` solo funciona en navegadores. En Node usá
> `memoryStorage()` (default) o implementá `SynapseStorage`.

## Uso mínimo

```ts
import { SynapseClient } from "@synapse/sdk";

const client = new SynapseClient({
  documentId: "doc_123",
  ticket: "<ticket de POST /api/documents/:id/ws-ticket>",
  baseUrl: "ws://localhost:44100",
});

const { seq } = await client.connect();
console.log("unido con seq", seq);

// Editar (converge vía CRDT con los demás clientes)
client.doc.getText("t").insert(0, "hola");

// Presencia (cursores / usuarios)
client.setPresence({ nick: "gabo", color: "#e6194b" });

// Avisos
client.doc.on("update", () => console.log("remoto:", client.doc.getText("t").toString()));
```

## API

| Export | Qué es |
| --- | --- |
| `SynapseClient` | `connect()` → `JoinedInfo`; `reconnect(ticket?)`; `close()`; `doc: Y.Doc`; `awareness`; `setPresence()` / `setPresenceField()`; callbacks `onRemoteUpdate`, `onAck`, `onAwareness`, `onAccessChanged`, `onError`, `onClose` |
| `browserTransport` | Transporte default (WebSocket global; sirve en browser y Node 22+) |
| `Transport` | Interfaz para inyectar tu propio transporte |
| `memoryStorage()` / `indexedDbStorage()` / `SynapseStorage` | Persistencia local enchufable (offline + reconciliación al reconectar) |

Detalles del protocolo: [docs/snp-v1.md](../../docs/snp-v1.md).

## Notas

- El ticket es de **un solo uso**: pedí uno por conexión.
- Los updates se confirman con `document:ack` (post-commit en PG); lo no
  confirmado se reenvía al reconectar.
- Sin `storage` no hay persistencia local: offline solo sobrevive con la
  pestaña abierta.
