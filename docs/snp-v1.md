# SNP v1 — especificación del protocolo Synapse

Versión 1 del protocolo de Synapse (motor colaborativo en tiempo real).
Fuente de verdad del formato: `packages/protocol/` (`frames.ts`,
`errors.ts`, `types.ts`, `schema.ts`); del comportamiento:
`apps/server/server.ts`, `apps/server/realtime/`, `packages/sdk/`.

## 1. Transporte y handshake

- WebSocket contra `GET /ws/documents/:id?ticket=<ticket>`.
- Subprotocolo obligatorio: `snp.v1` (`Sec-WebSocket-Protocol`; sin él → `403`).
- `Origin`: si el navegador lo envía debe estar en `ALLOWED_ORIGINS`;
  sin `Origin` (curl / no-browser) se acepta.
- `ticket`: de un solo uso, atado al documento
  (`POST /api/documents/:id/ws-ticket` con sesión). Falta o inválido →
  `401`; sin rol sobre el documento → `403`.
- Al aceptar, el servidor responde `document:joined` con
  `{ documentId, role, seq, schemaVersion }` (`seq` = último commit en PG).

## 2. Frames binarios

Primer byte = tipo; el resto = payload. Límite: **64 KiB**
(`MAX_FRAME_BYTES`; superarlo → `document:error MESSAGE_TOO_LARGE` +
cierre `4413`).

| Byte | Nombre | Layout | Sentido |
| --- | --- | --- | --- |
| `0x01` | `SYNC_STEP1` | `01 ‖ state-vector` | C→S (vector local). S responde `SYNC_STEP2(diff)` + `SYNC_STEP1(vector propio)` |
| `0x02` | `SYNC_STEP2` | `02 ‖ update` | C→S (pone al servidor al día) |
| `0x03` | `UPDATE` | `03 ‖ cseq u32 BE ‖ update Yjs` | C→S con contador del cliente; el servidor re-emite con `cseq = 0` |
| `0x04` | `AWARENESS` | `04 ‖ update y-protocols` | ambos (presencia/cursores) |

- Tres mensajes desconocidos seguidos → cierre `4400`.
- Frame vacío o tipo desconocido → `document:error UNKNOWN_MESSAGE`.

## 3. Actualizaciones y `cseq`

- `cseq` = contador `u32` big-endian por cliente; el update inválido se
  descarta sin tocar el doc (`INVALID_UPDATE`).
- El servidor aplica el update a su `Y.Doc`, lo persiste (ver §5) y lo
  re-emite a la room con `cseq = 0`.
- El rol se verifica **en cada mensaje**: `viewer` solo lee
  (`SYNC_STEP1`) y manda awareness; escribir → `document:error READ_ONLY`
  sin cerrar. Rol revocado → cierre `4403` + `document:access-changed`
  en caliente si el rol cambia.

## 4. Mensajes de control JSON

| `type` | Dirección | Payload |
| --- | --- | --- |
| `document:joined` | S→C | `{ documentId, role, seq, schemaVersion }` |
| `document:ack` | S→C (al emisor) | `{ upTo, seq }`: confirma durabilidad post-commit en PG |
| `document:error` | S→C | `{ code, message }` (`code` ∈ `ERROR_CODES`) |
| `document:access-changed` | S→C | `{ role }` |
| `connection:ping` / `connection:pong` | C→S / S→C | latido |

Texto que no es JSON válido o de tipo desconocido → `UNKNOWN_MESSAGE`.
Texto > 64 KiB → `MESSAGE_TOO_LARGE` + cierre `4413`.

## 5. Durabilidad y `ack`

- Los updates se encolan por documento y se persisten por ventanas
  (`saveBatch` con `seq` lineal y `author_id`); el `ack` es la **única**
  promesa de durabilidad y llega **después del commit**.
- Lo no confirmado se reenvía al reconectar; el cliente resincroniza por
  *state vector*.
- Snapshots automáticos + versiones nombradas; restaurar = aplicar un
  cambio nuevo. Compactación con lock por documento.

## 6. Awareness

- Updates efímeros `y-protocols` en frames `0x04`, con throttle de cliente
  50–100 ms.
- El servidor **reescribe la identidad** (`user.id/name/color` de la
  sesión): nunca confía en la que manda el cliente; un frame con IDs de
  otra conexión viva se descarta (spoof).
- Al cerrar la conexión se emite la remoción y se difunde; en despliegue
  distribuido las bajas de instancias caídas viajan por el bus con
  expiración por heartbeat (sin TTL en el mensaje: es efímero).

## 7. Errores y cierres

`ERROR_CODES`: `UNAUTHENTICATED`, `FORBIDDEN`, `READ_ONLY`,
`DOCUMENT_NOT_FOUND`, `MESSAGE_TOO_LARGE`, `RATE_LIMITED`,
`INVALID_UPDATE`, `UNKNOWN_MESSAGE`, `PROTOCOL_VERSION_UNSUPPORTED`,
`SCHEMA_UNSUPPORTED`, `INTERNAL`.

| Cierre | Cuándo |
| --- | --- |
| `4400` PROTOCOL_VIOLATION | 3 mensajes desconocidos seguidos |
| `4403` ACCESS_REVOKED | rol revocado |
| `4413` MESSAGE_TOO_LARGE | frame o texto > 64 KiB |
| `4415` SCHEMA_UPGRADE_REQUIRED | `schema_version` mayor al soportado |
| `4429` RATE_LIMITED | abuso sostenido tras avisos |
| `4401` SESSION_INVALID / `4408` HEARTBEAT_TIMEOUT | definidos, sin uso activo en el servidor actual |

Rate limiting: token bucket por conexión (100 cap / 50 por s) y por
usuario (200 / 100 por s); ráfagas cortas pasan, abuso acumulado cierra.

## 8. Versiones de schema

- `schemaVersion` (TipTap: nodos/marcas que entiende el editor) viaja en
  `document:joined`; si el documento usa una versión mayor, se rechaza
  con `SCHEMA_UNSUPPORTED` + cierre `4415` **antes** de cargarlo.
- El `version` lineal de Yjs que un apéndice temprano proponía quedó
  rechazado: el orden lo da `seq` de PG (ver `docs/schema-evolution.md`).

## 9. Modo distribuido (informativo)

Múltiples instancias detrás de un balanceador (sin sticky sessions).
Bus Redis pub/sub por documento (`snp:doc:<id>`) con `instance-id` de
origen (se ignora lo propio); suscripción antes de cargar de PG;
at-most-once sin replay + resincronización contra PG; awareness con
expiración por heartbeat; anti-entropy periódica. Detalle de
implementación en el código (`realtime/bus.ts`, `presence.ts`,
`server.ts`), no parte del contrato del cliente.
