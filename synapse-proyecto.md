# Synapse — Real-time Collaboration Engine

> Proyecto avanzado de portfolio construido con Deno 2, TypeScript,
> WebSockets y CRDT.
>
> **Objetivo:** desarrollar un motor de colaboración en tiempo real que
> permita a múltiples usuarios editar documentos simultáneamente,
> compartir presencia y cursores, recuperarse de desconexiones y escalar
> a múltiples instancias.

> **Revisión 2.** Esta versión incorpora la revisión técnica del diseño
> original: protocolo con ack de durabilidad, handshake autenticado,
> modelo de datos corregido, roadmap unificado, sección de riesgos y
> alcance acotado. Los cambios están resumidos en el apéndice.

---

## 1. Visión del proyecto

Synapse será una plataforma de colaboración multiusuario inspirada en
Google Docs, con foco en la ingeniería del backend y los sistemas en
tiempo real.

Varios usuarios podrán abrir el mismo documento y modificarlo
simultáneamente. Los cambios deberán converger correctamente incluso
cuando existan ediciones concurrentes, conexiones inestables o clientes
que vuelvan a conectarse después de un período offline.

El proyecto busca demostrar conocimientos de:

-   Deno 2 y TypeScript.
-   WebSockets y protocolos de comunicación.
-   Concurrencia y sincronización en tiempo real.
-   CRDT y consistencia eventual.
-   Persistencia de estados y eventos.
-   Arquitectura distribuida.
-   Observabilidad, pruebas de carga y resiliencia.

### 1.1 Objetivos del producto

1.  Permitir la edición simultánea de documentos.
2.  Mostrar presencia, cursores y selecciones de otros usuarios.
3.  Sincronizar cambios sin conflictos destructivos.
4.  Persistir los documentos y recuperar su estado después de reinicios.
5.  Soportar reconexiones y clientes temporalmente offline.
6.  Distribuir sesiones y documentos entre varias instancias del
    servidor.
7.  Ofrecer un SDK y un protocolo documentado para integraciones.

### 1.2 Fuera de alcance (versión 1)

Synapse se inspira en Google Docs, pero el foco es el backend de
tiempo real. Para evitar que el alcance crezca, queda fuera de la v1:

-   Comentarios, sugerencias y menciones.
-   Exportación a PDF/Word y edición de medios (imágenes, video).
-   Invitaciones por email (requieren infraestructura de correo). En
    su lugar: agregar miembros por email de un usuario ya registrado, o
    compartir mediante link.
-   Cifrado extremo a extremo.
-   Despliegue multi-región.
-   Aplicaciones móviles nativas.
-   Microservicios y un CRDT propio (este último, como experimento
    posterior e independiente).

---

## 2. Funcionalidades

### A. Collaborative Editor

-   Edición simultánea de documentos.
-   Cursores remotos y selecciones de texto.
-   Presencia de usuarios conectados.
-   Sincronización automática.
-   Undo/redo **por usuario** (deshace solo los cambios propios).
-   Indicador del estado de conexión.
-   Reconexión automática.
-   Soporte para cambios locales mientras el cliente está offline, con
    persistencia local en el navegador (ver sección 3). Sin ella, el
    modo offline solo funciona mientras la pestaña siga abierta.

### B. Document Engine

-   Historial de modificaciones **con autor** (cada update persistido
    registra quién lo envió).
-   Persistencia de actualizaciones CRDT.
-   Snapshots periódicos (automáticos) y versiones nombradas.
-   Recuperación de versiones (restaurar = aplicar un nuevo cambio, ver
    sección 7).
-   Sincronización incremental.
-   Reconciliación de cambios al reconectar.
-   Restauración de documentos después de reiniciar el servidor.

### C. Workspace Management

Alcance inicial reducido; el objetivo es probar autorización en el
servidor, no construir un producto de administración.

-   Crear espacios de trabajo.
-   Agregar miembros por email de usuario registrado.
-   Tres roles: `owner`, `editor`, `viewer`.
-   Documentos privados y compartidos (visibilidad).
-   Compartir por link con rol asignado (opcional, con expiración).
-   Gestión de sesiones (login, expiración, revocación).
-   Control de acceso por documento.

---

## 3. Stack tecnológico

| Tecnología | Responsabilidad |
|---|---|
| Deno 2 | Runtime y entorno de ejecución TypeScript |
| TypeScript | Lenguaje principal |
| Remix v3 (`remix`) | Framework full-stack HTTP + UI: routing, middleware, forms, sessions, render streaming + Frames |
| WebSockets nativos de Deno | Transporte bidireccional en tiempo real (fuera de `router.fetch`) |
| Yjs (+ `y-protocols` para awareness) | Motor CRDT y estado efímero de presencia |
| TipTap Core vanilla (sin React) | Editor enriquecido basado en ProseMirror, montado en `clientEntry` |
| `y-indexeddb` (o equivalente) | Persistencia local del cliente para trabajo offline |
| `remix/data-schema` (o Zod) | Validación de payloads de control y de la API |
| Remix Component Model | Interfaz de usuario (sin hooks; `handle.update()`, `mix`, `clientEntry`, `Frame`) |
| Remix asset pipeline | Sin build de app; módulos nativos + `public/` colocado |
| PostgreSQL | Usuarios, workspaces, documentos, updates y snapshots |
| Redis | Pub/Sub y coordinación entre instancias (post-MVP) |
| Caddy, nginx o Traefik | Load balancer con soporte WebSocket (etapa distribuida) |
| Docker Compose | Entorno local reproducible |
| Prometheus + Grafana | Métricas y dashboards |
| OpenTelemetry | Trazas y observabilidad |
| `fast-check` (o similar) | Pruebas de propiedades y fuzzing de convergencia |

### Decisiones técnicas

**CRDT: Yjs inicialmente**

Se recomienda utilizar Yjs como motor CRDT en la primera versión. Esto
permite concentrarse en el transporte, persistencia, autorización,
presencia y distribución, en lugar de invertir el proyecto entero en
implementar un algoritmo de convergencia.

Una implementación CRDT propia puede quedar como experimento posterior e
independiente.

**WebSockets nativos de Deno + Remix v3 (decisión v2)**

El servidor usa `Deno.serve` con bifurcación en `server.ts`: si el pathname empieza con `/ws/` va al handler Synapse (`Deno.upgradeWebSocket`, validación de `Origin`, ticket, `snp.v1`, `Y.Doc` en memoria); todo lo demás va a `router.fetch(req)` de Remix. Remix no maneja el WS: HTTP y WS viven en el mismo proceso Deno pero en ramas separadas.

**Una conexión WebSocket por documento (v1)**

Cada conexión se asocia a un único documento, indicado en la URL del
handshake. Simplifica la autorización (una verificación por conexión),
el backpressure y la limpieza de recursos. Multiplexar varios
documentos en una conexión queda como evolución posible del protocolo.

**Autenticación del WebSocket mediante ticket**

El `WebSocket` del navegador no permite headers personalizados. El
cliente obtiene por HTTP (autenticado) un *ticket* de un solo uso y vida
corta, ligado a usuario y documento, y lo presenta en el handshake. El
servidor además valida el header `Origin` contra una lista permitida
(ver secciones 6 y 13).

**PostgreSQL**

Será la fuente persistente de usuarios, documentos, permisos,
actualizaciones y snapshots.

**Redis**

Se incorporará cuando se necesite distribuir eventos y coordinar
instancias. No es necesario agregarlo en el primer prototipo de una sola
instancia.

**Alternativas existentes y por qué un servidor propio**

Ya existen servidores de colaboración sobre Yjs: `y-websocket` (servidor
de referencia) y Hocuspocus (mantenido por el equipo de TipTap, con
autenticación, persistencia y extensión para Redis). Synapse no
pretende reemplazarlos: el objetivo del proyecto es demostrar la
ingeniería alrededor del CRDT (protocolo propio versionado, durabilidad
explícita, autorización por mensaje, distribución y observabilidad).
El documento de decisiones (sección 15) debe recoger esta comparación
con ventajas y desventajas de cada opción.

---

## 4. Arquitectura propuesta

La primera versión es un **proceso Deno único** con dos ramas: Remix v3 para HTTP/UI y handler WS propio para realtime. No es un conjunto de microservicios. Esto reduce complejidad y permite separar responsabilidades sin introducir prematuramente problemas de red y operación.

### Diagrama lógico — MVP (una instancia, Deno + Remix v3)

``` text
                      CLIENTS
     Remix UI (clientEntry editor vanilla + Frames shell)
                          |
                 WebSocket (snp.v1) + HTTP (router.fetch)
                          |
        +-----------------+------------------+
        |           SYNAPSE SERVER           |
        |        (Deno, instancia única)     |
        |                                    |
        |   server.ts bifurca:               |
        |     /ws/* -> WS Handler + Auth     |
        |     resto -> Remix router.fetch    |
        |   Connection Manager               |
        |          |                         |
        |   Document Engine (Y.Doc en        |
        |   memoria por documento activo)    |
        |       |                |           |
        |  Persistence      Awareness        |
        |       |           (en memoria)     |
        +-------|----------------------------+
                |
           PostgreSQL
      (updates + snapshots)
```

> Regla: el editor colaborativo **nunca** va dentro de un `<Frame>` que se recargue. El editor es `clientEntry` fuera de Frames; los Frames son solo para shell (listados, miembros, historial).

Redis **no** forma parte de esta versión. Aparece recién en la
arquitectura distribuida (sección 9).

### Componentes y responsabilidades

| Componente | Responsabilidad |
|---|---|
| Remix router (`router.fetch`) | Login, documentos, workspaces, miembros, links de acceso y emisión de tickets WebSocket; SSR streaming + Frames para shell |
| Connection Manager | Aceptar, identificar y cerrar conexiones WebSocket; heartbeats, límites y backpressure |
| Auth Manager | Validar sesiones y tickets, verificar origen y permisos, aplicar revocaciones |
| Document Engine | Mantener el `Y.Doc` de cada documento activo, aplicar y difundir updates, coordinar sincronización inicial y descarga de documentos inactivos |
| Persistence | Guardar updates por lotes, generar snapshots, compactar, confirmar durabilidad (ack) |
| Awareness | Distribuir presencia, cursores y selecciones (efímeros) |
| Redis (post-MVP) | Propagar eventos entre instancias |
| PostgreSQL | Persistir datos y estado recuperable |

Nota: no existe un "CRDT Engine" propio. La convergencia la provee Yjs;
el Document Engine es el código de Synapse que lo envuelve.

### Flujo de conexión

1.  El cliente inicia sesión por HTTP y obtiene credenciales de sesión.
2.  Solicita un ticket WebSocket para un documento
    (`POST /api/documents/:id/ws-ticket`). El ticket es de un solo uso,
    de vida corta y queda ligado al usuario y al documento.
3.  Abre la conexión `GET /ws/documents/:id?ticket=...` indicando el
    subprotocolo `snp.v1`.
4.  Antes de aceptar el upgrade, el servidor valida el `Origin`,
    consume el ticket, verifica la versión del protocolo y comprueba que
    el usuario tenga permisos sobre el documento. Si algo falla, rechaza
    el upgrade con 401/403/400.
5.  El Document Engine obtiene o carga el estado del documento.
6.  El servidor envía `document:joined` con el rol del usuario y el
    `seq` persistido actual.
7.  Sincronización inicial de Yjs: el cliente envía `SYNC_STEP1` (state
    vector); el servidor responde con `SYNC_STEP2` y su propio
    `SYNC_STEP1`; el cliente completa con `SYNC_STEP2`.
8.  El cliente comienza a enviar y recibir actualizaciones.
9.  Los mensajes de awareness distribuyen cursores y presencia; el
    servidor sobrescribe la identidad con la de la sesión autenticada.
10. Al desconectarse (cierre normal o heartbeat vencido), se eliminan
    los estados de awareness de esa conexión, se liberan recursos y, si
    el documento queda sin conexiones, se persiste y se descarga de
    memoria tras un tiempo de inactividad.

### Flujo de una actualización

1.  Un usuario modifica el documento en el editor.
2.  Yjs produce una actualización binaria.
3.  El cliente la envía como frame `UPDATE` con un contador `cseq` y la
    conserva como pendiente de confirmación.
4.  El servidor valida la sesión, el rol (debe ser `editor` u `owner`),
    el documento, el tamaño y la tasa de mensajes.
5.  El Document Engine aplica la actualización al `Y.Doc` dentro de un
    try/catch. Si es inválida, la descarta y responde `INVALID_UPDATE`.
6.  La actualización se distribuye a los demás clientes autorizados.
7.  Se encola para persistir; los updates se agrupan en lotes
    (`Y.mergeUpdates`) y se guardan en una transacción.
8.  Tras el `COMMIT`, el servidor envía `document:ack` con el `cseq`
    confirmado y el `seq` asignado.
9.  Los clientes aplican la actualización y convergen al mismo estado.

### Política de durabilidad (decisión v1)

-   Se **difunde antes de persistir** para minimizar latencia; el
    `document:ack` se envía **solo después del commit**. El ack es la
    única promesa de durabilidad.
-   Si el servidor cae entre la difusión y el commit, el cliente
    emisor aún conserva el update sin confirmar y lo reenvía al
    reconectar mediante la sincronización por state vector.
-   Si el emisor también desapareció (por ejemplo, cerró la pestaña),
    ese update se pierde. Es una ventana acotada, documentada y cubierta
    por tests (sección 12).
-   Un cambio se considera **persistido** cuando su `cseq` fue
    confirmado por un `document:ack`.

---

## 5. Estructura del repositorio

Se propone un monorepo con una sola app Remix v3 en Deno y paquetes compartidos.

``` text
synapse/
│
├── deno.json                  # workspace raíz (miembros y tareas)
│
├── apps/
│   └── server/                # app Remix v3 + WS Synapse (Deno)
│       ├── server.ts          # Deno.serve: /ws/* -> WS, resto -> router.fetch
│       ├── app/
│       │   ├── routes.ts      # URLs + href tipados
│       │   ├── router.ts      # middleware + map de controllers
│       │   ├── middleware/    # session/auth, logging, etc.
│       │   ├── actions/       # controllers + UI por ruta
│       │   │   ├── documents/edit/public/editor.ts  # clientEntry Yjs vanilla
│       │   ├── ui/            # layouts y componentes Remix
│       │   └── assets.ts
│       ├── realtime/          # WS Handler, Document Engine, Persistence, Awareness
│       │   ├── websocket/
│       │   ├── documents/
│       │   ├── collaboration/
│       │   └── persistence/
│       └── deno.json
│
├── packages/
│   ├── protocol/
│   ├── shared/
│   └── sdk/                   # cliente TS SNP (ex-SynapseProvider React, ahora clientEntry vanilla)
│
├── infrastructure/
│   ├── docker/
│   └── postgres/              # migraciones y esquema
│
├── tests/
│   ├── integration/
│   ├── collaboration/
│   ├── convergence/           # fuzzing y pruebas de propiedades
│   └── load/
│
├── docker-compose.yml
└── README.md
```

### Descripción de paquetes

-   `apps/server`: app Remix v3 en Deno (HTTP/UI) + realtime WS Synapse (`realtime/`). `server.ts` bifurca `/ws/*` vs `router.fetch`.
-   Editor: TipTap Core vanilla en `clientEntry`, fuera de `<Frame>`; Frames solo para shell (listados, miembros, historial).
-   `packages/protocol`: tipos, frames, códigos de error/cierre y
    validación del protocolo SNP.
-   `packages/shared`: tipos y utilidades compartidas.
-   `packages/sdk`: cliente TypeScript SNP vanilla. Ex-`SynapseProvider` React, ahora módulo `clientEntry` con Yjs + `y-protocols`. Lo consume el editor desde la etapa 2; la publicación es solo empaquetado y documentación final.
-   `infrastructure`: configuración de servicios locales, migraciones y
    despliegue.
-   `tests`: pruebas unitarias, integración, colaboración, convergencia
    y carga.

### Reglas del monorepo (Remix v3 + Deno)

-   Los paquetes `protocol`, `shared` y `sdk` deben ser
    **runtime-agnósticos** (sin APIs exclusivas de Deno), porque los
    consumen tanto el realtime Deno como los módulos `public/` del browser.
-   Fijar **una única versión de `yjs`** en todo el workspace. Si el
    realtime, el SDK y el editor resuelven copias distintas, Yjs falla con
    el aviso "Yjs was already imported" y la convergencia se rompe de
    forma sutil.
-   Respetar el boundary `app/**/public/`: solo lo de ahí llega al browser. `routes.ts` se permite para hrefs tipados.
-   Evitar `asyncContext` (usa `AsyncLocalStorage` de Node); pasar contexto por argumento para seguir portable en Deno.
-   `staticFiles/compression` usan APIs de Node: funcionan por compat en Deno 2, si fallan servir `public/` por plataforma.

---

## 6. Synapse Protocol (SNP)

El protocolo propio de Synapse define los mensajes, eventos, errores,
autenticación y reglas de sincronización. Versión inicial: **`snp.v1`**.

### Handshake y versionado

-   URL: `/ws/documents/:documentId?ticket=<ticket>`.
-   El cliente solicita el subprotocolo `snp.v1`
    (`Sec-WebSocket-Protocol`). Si el servidor no soporta ninguna de las
    versiones ofrecidas, rechaza el upgrade con 400.
-   El ticket es de un solo uso y vida muy corta. Como viaja en la URL,
    hay que **excluirlo de los logs de acceso** y de las métricas.
-   Se valida `Origin` contra una lista permitida antes de aceptar la
    conexión.
-   La sesión se autentica **una vez por conexión**; no se envían
    credenciales en mensajes posteriores.
-   Una conexión equivale a una sesión en un documento: no existe
    `document:join`. Cerrar el socket equivale a salir.

### Transporte

-   **Mensajes de control**: JSON (frames de texto).
-   **Mensajes de sincronización**: frames binarios con un byte de tipo
    y, para `UPDATE`, un contador de cliente.
-   Límites explícitos de tamaño de mensaje.
-   Validación de payloads en todos los mensajes.
-   Manejo de mensajes desconocidos (error y, si se repite, cierre).
-   Backpressure y límites de envío por conexión.

No conviene convertir updates binarios a Base64 dentro de JSON: agrega
tamaño y trabajo de codificación innecesarios.

### Frames binarios

| Byte 0 | Nombre | Dirección | Contenido |
|---|---|---|---|
| `0x01` | `SYNC_STEP1` | Bidireccional | State vector de Yjs |
| `0x02` | `SYNC_STEP2` | Bidireccional | Diferencia de estado (update) para quien envió el state vector |
| `0x03` | `UPDATE` | Bidireccional | Cliente → servidor: `u32 cseq` (big-endian) + update de Yjs. Servidor → cliente: `u32` en cero + update |
| `0x04` | `AWARENESS` | Bidireccional | Update de awareness (`y-protocols`) |

El esquema exacto (incluido el campo `cseq`) se valida durante la etapa
2 y queda congelado con la publicación de `snp.v1`.

### Mensajes de control (JSON)

Servidor → cliente, tras aceptar la conexión:

``` json
{
  "type": "document:joined",
  "payload": {
    "documentId": "doc_123",
    "clientId": "client_456",
    "role": "editor",
    "seq": 1042
  }
}
```

`seq` es el último número de secuencia persistido del documento (ver
sección 7). Yjs no tiene una "versión" lineal: la sincronización usa
state vectors, y `seq` solo identifica la posición en el log durable.

Confirmación de durabilidad:

``` json
{
  "type": "document:ack",
  "payload": { "upTo": 87, "seq": 1043 }
}
```

`upTo` es el mayor `cseq` del cliente ya persistido (todos los
anteriores también lo están); `seq` es el número de secuencia asignado
al último update del lote.

Error:

``` json
{
  "type": "document:error",
  "payload": { "code": "READ_ONLY", "message": "El rol viewer no puede editar." }
}
```

Cambio de acceso:

``` json
{
  "type": "document:access-changed",
  "payload": { "role": "viewer" }
}
```

Si el acceso se revoca por completo, el servidor cierra la conexión con
el código `4403`.

### Eventos propuestos

| Evento | Dirección | Propósito |
|---|---|---|
| `document:joined` | Servidor → cliente | Confirmar el ingreso y comunicar rol y `seq` |
| `document:ack` | Servidor → cliente | Confirmar persistencia hasta un `cseq` |
| `document:access-changed` | Servidor → cliente | Cambio de rol o revocación en caliente |
| `document:error` | Servidor → cliente | Comunicar errores |
| `connection:ping` | Cliente → servidor | Heartbeat (los navegadores no pueden enviar ping frames) |
| `connection:pong` | Servidor → cliente | Respuesta al heartbeat |
| frames `SYNC_STEP1/2`, `UPDATE` | Bidireccional | Sincronización CRDT (binarios) |
| frame `AWARENESS` | Bidireccional | Presencia, cursores y selecciones (binario) |

`presence:update` queda eliminado: la presencia y los cursores viajan
juntos en awareness. `document:update` y `document:sync` pasan a ser los
frames binarios `UPDATE` y `SYNC_STEP1/2`.

### Códigos de error

| Código | Cuándo |
|---|---|
| `UNAUTHENTICATED` | Ticket inválido, vencido o ya usado |
| `FORBIDDEN` | Sin permisos sobre el documento |
| `READ_ONLY` | Un `viewer` intentó enviar un `UPDATE` (el update se descarta; awareness sigue permitido) |
| `DOCUMENT_NOT_FOUND` | El documento no existe o fue eliminado |
| `MESSAGE_TOO_LARGE` | Frame mayor al límite configurado |
| `RATE_LIMITED` | Excedió la tasa de mensajes |
| `INVALID_UPDATE` | El update no se pudo decodificar o aplicar |
| `UNKNOWN_MESSAGE` | Tipo de mensaje o frame desconocido |
| `PROTOCOL_VERSION_UNSUPPORTED` | Versión de protocolo no soportada |
| `INTERNAL` | Error interno (sin detalles sensibles) |

### Códigos de cierre propuestos

La API WebSocket solo permite enviar `1000` o códigos entre `3000` y
`4999` en `close()`, por eso se usa el rango `4xxx`.

| Código | Significado |
|---|---|
| `4400` | Violación del protocolo (por ejemplo, mensajes desconocidos repetidos) |
| `4401` | Sesión vencida o revocada (el cliente debe pedir un nuevo ticket) |
| `4403` | Acceso al documento revocado |
| `4408` | Heartbeat vencido |
| `4413` | Mensaje demasiado grande |
| `4429` | Límite de tasa excedido de forma sostenida |

### Awareness

El servidor **nunca confía en la identidad enviada por el cliente**: al
recibir un frame `AWARENESS` reescribe los campos de usuario (id,
nombre, color) con los de la sesión autenticada, y registra qué
`clientID` de awareness pertenece a cada conexión para eliminarlos al
cerrarla.

---

## 7. Modelo de datos

Esquema inicial sugerido para PostgreSQL (tipos orientativos).

### Identidad y sesiones

``` text
users
  id, email (único), password_hash, created_at

sessions
  id, user_id, token_hash, expires_at, revoked_at, created_at
```

`password_hash` debe generarse con un algoritmo adaptativo (argon2id o
bcrypt). Los tokens de sesión se guardan hasheados, nunca en claro.

### Workspaces y acceso

``` text
workspaces
  id, name, owner_id, created_at

workspace_members
  workspace_id, user_id, role (owner | editor | viewer), created_at

documents
  id, workspace_id, title, visibility (private | workspace | shared),
  last_seq (bigint, default 0), schema_version,
  created_by, created_at, updated_at, deleted_at

document_members
  document_id, user_id, role (owner | editor | viewer), created_at

document_share_links          -- opcional (compartir por link)
  id, document_id, token_hash, role, expires_at, created_by, created_at
```

Las invitaciones por email quedan fuera de la v1 (sección 1.2).

### Contenido del documento

``` text
document_updates
  document_id, seq (bigint), update_data (BYTEA),
  author_id, created_at
  PK (document_id, seq)

document_snapshots
  id, document_id, state (BYTEA), last_seq,
  kind (auto | named), label (nullable),
  created_by, created_at
```

-   `seq` es un contador **por documento**. Se asigna dentro de la
    transacción de guardado incrementando `documents.last_seq`
    (`UPDATE ... SET last_seq = last_seq + 1 RETURNING last_seq`, o un
    rango por lote). Ese bloqueo de fila serializa a los escritores del
    mismo documento, lo que también sirve para ordenar el log entre
    instancias.
-   `last_seq` en `document_snapshots` indica hasta qué update está
    incluido el snapshot. Sin ese dato no se puede saber qué updates
    aplicar después ni cuáles se pueden compactar.
-   `author_id` hace posible el historial atribuible. Yjs no registra
    usuarios por sí mismo.
-   Claves foráneas con `ON DELETE CASCADE` desde `document_updates` y
    `document_snapshots` hacia `documents`.

### Consideraciones de persistencia

-   Guardar updates binarios de Yjs, no cada pulsación de teclado como
    una operación de texto propia.
-   Agrupar updates en lotes breves (ventana a medir, del orden de
    decenas a cientos de milisegundos) y combinarlos con
    `Y.mergeUpdates` antes de insertar. El ack se envía después del
    commit del lote.
-   Generar snapshots automáticos según umbrales de cantidad o tamaño de
    updates desde el último snapshot.
-   Recuperar un documento cargando el snapshot automático más reciente
    y aplicando los updates con `seq > last_seq`.
-   **Compactación:** tras crear un snapshot automático, eliminar los
    updates con `seq <= last_seq` que ya excedan la ventana de
    retención. Ejecutarla bajo un lock por documento
    (`pg_advisory_xact_lock` o similar) para evitar compactaciones
    concurrentes entre tareas o instancias.
-   **Versiones nombradas:** se guardan como copia del estado completo
    (`Y.encodeStateAsUpdate`) con `kind = 'named'` y no se compactan.
    Se descarta, como decisión inicial, usar `Y.snapshot` con GC
    desactivado, porque aumenta mucho el almacenamiento; queda como
    experimento.
-   **Restaurar una versión** no rebobina el CRDT (que solo crece):
    se carga el estado guardado en un `Y.Doc` temporal y se aplica un
    cambio nuevo que reescribe el contenido actual con el de esa
    versión. Ese cambio es un update más, con su autor y su `seq`.
-   Usar transacciones y claves foráneas para mantener integridad.
-   Indexar por `(document_id, seq)` y por fecha donde se consulte
    historial.
-   Definir un límite de tamaño por documento y una política de
    retención del historial.
-   Considerar particionamiento o archivado si el volumen crece.
-   Definir explícitamente cuándo una actualización se considera
    persistida: al recibir su `document:ack` (sección 4).

La presencia y los cursores son datos efímeros: no deberían tratarse
como contenido durable del documento.

---

## 8. Presencia y Awareness

La presencia permite que los usuarios sepan quién está conectado y dónde
está trabajando.

Funciones:

-   Mostrar usuarios conectados.
-   Asignar color e identidad visual a cada usuario.
-   Compartir posición del cursor.
-   Compartir selección de texto.
-   Mostrar cambios de estado de conexión.
-   Expirar presencia de clientes desconectados.

Reglas:

-   Se usa Yjs Awareness para propagar estados efímeros. Awareness ya
    incorpora una expiración de estados que no se renuevan (del orden de
    30 segundos, con renovación periódica del cliente); además, el
    servidor elimina los estados de una conexión apenas se cierra.
-   La identidad (id, nombre, color) la **fija el servidor** a partir
    de la sesión; el cliente solo aporta cursor y selección.
-   Los `viewer` pueden enviar awareness (su cursor es visible) pero no
    updates de contenido.
-   Aplicar **throttle** a los envíos de awareness (valor inicial a
    medir, por ejemplo 50–100 ms) y límites de frecuencia por conexión.
    El tráfico de awareness crece de forma cuadrática con la cantidad de
    editores en un documento, y es el primer cuello de botella esperable
    en la prueba de 100 editores.
-   Las identidades y colores no son datos del documento; no se
    persisten.

---

## 9. Arquitectura distribuida

Una vez estable el MVP de una sola instancia, Synapse puede evolucionar
para ejecutar varias instancias del servidor.

``` text
                 CLIENTS
                    |
             Load Balancer
               /       \
              /         \
        Server A       Server B
        (Y.Doc,        (Y.Doc,
        Awareness)     Awareness)
            |              |
            +------ Redis -+
                    |
               PostgreSQL
```

### Decisión de modelo (v1)

**Cualquier instancia puede alojar cualquier documento.** Como los
updates de Yjs conmutan, dos instancias pueden tener el mismo documento
en memoria y converger. Es más simple que asignar un dueño por documento
(sharding por hash consistente), a costa de cargar el mismo documento en
varios nodos. El ownership por documento queda como alternativa
posterior si la memoria se vuelve un problema.

### Responsabilidades

-   El balanceador distribuye nuevas conexiones (no requiere sticky
    sessions). Debe soportar WebSocket y tener timeouts de conexión
    inactiva coherentes con los heartbeats.
-   Cada servidor administra las conexiones WebSocket que recibió.
-   Redis propaga actualizaciones y awareness entre instancias.
-   PostgreSQL conserva el estado durable y ordena el log por `seq`.
-   El sistema debe asegurar que los clientes de distintas instancias
    reciban los cambios pertinentes.

### Aspectos que deben resolverse

-   **Enrutamiento por documento:** un canal por documento (por ejemplo
    `snp:doc:<id>`); cada mensaje lleva el identificador de la instancia
    de origen.
-   **Evitar loops de propagación:** una instancia ignora los mensajes
    cuya instancia de origen es ella misma.
-   **Orden de suscripción al activar un documento:** (1) suscribirse al
    canal, (2) cargar el estado desde PostgreSQL, (3) aplicar los
    mensajes recibidos mientras se cargaba. Si se carga primero y se
    suscribe después, se pierden updates en el intervalo.
-   **Pérdida de mensajes:** Redis Pub/Sub entrega como máximo una vez y
    sin replay. Tras una reconexión a Redis o una suscripción tardía, la
    instancia debe resincronizar cada documento activo por state vector
    contra PostgreSQL.
-   **Alternativa con log durable:** persistir primero y usar Redis solo
    para avisar "hay un `seq` nuevo", de modo que cada instancia se ponga
    al día leyendo `seq > último visto`. Cuesta algo de latencia y gana
    robustez; si se necesita entrega durable directa en el bus, evaluar
    Redis Streams o NATS JetStream.
-   **Compactación concurrente:** protegida con lock por documento
    (sección 7).
-   **Awareness distribuido:** viaja por Redis; los estados de una
    instancia que cae deben expirar (TTL o heartbeat por instancia) para
    no dejar usuarios fantasma.
-   **Recuperación cuando una instancia cae:** los clientes reconectan a
    otra instancia (el ticket se vuelve a pedir si venció) y resincronizan
    por state vector.
-   Persistencia antes de confirmar durabilidad: el ack sigue siendo
    posterior al commit, en cualquier instancia.
-   Limpieza de sesiones y presencia obsoletas.

---

## 10. Roadmap de desarrollo

El orden de esta sección es el vigente; las secciones 11 y 16 lo
respetan.

### Etapa 1 — WebSocket Core

**Objetivo:** construir la base de comunicación, con el handshake ya
diseñado para autenticación, sobre Deno + Remix v3.

-   `server.ts` en Deno: `Deno.serve` bifurca `/ws/*` a WS Handler y resto a `router.fetch`.
-   Scaffold Remix v3: `routes.ts`, `router.ts`, middleware base (`logger`, `staticFiles`, `formData`, `render`).
-   Handshake: validación de `Origin`, subprotocolo `snp.v1`, ticket
    (puede ser de prueba hasta la etapa 4, pero con la misma forma).
-   Gestión de conexiones e identificación de clientes.
-   Sistema de rooms (una conexión por documento).
-   Broadcast de mensajes.
-   Heartbeats.
-   Manejo de desconexiones.
-   Límites de conexiones, de tamaño y de tasa de mensajes por
    conexión.
-   Monorepo Remix v3 en Deno, una única versión de Yjs y
    Docker Compose base.

**Resultado esperado:** servidor capaz de gestionar múltiples clientes y
distribuir mensajes entre ellos, con un handshake que no habrá que
rehacer al agregar autenticación.

### Etapa 2 — CRDT Engine

**Objetivo:** lograr edición colaborativa.

-   Integración de Yjs en el Document Engine.
-   Frames `SYNC_STEP1/2` y `UPDATE` (con `cseq`).
-   Cliente SNP vanilla en `packages/sdk` (`clientEntry`), consumido por el editor Remix.
-   Sincronización inicial y actualizaciones incrementales.
-   Aplicación de cambios concurrentes.
-   Reconexión y sincronización.
-   Integración con TipTap Core vanilla (sin React) + extensión Collaboration; desactivar el
    undo/redo nativo del editor y usar el de Yjs. Editor fuera de `<Frame>`.

**Resultado esperado:** varios usuarios editando el mismo documento y
convergiendo al mismo estado.

### Etapa 3 — Persistence

**Objetivo:** conservar los documentos.

-   Integración con PostgreSQL y migraciones.
-   Guardado de updates por lotes con `seq` y `author_id`.
-   `document:ack` ligado al commit.
-   Snapshots automáticos y versiones nombradas.
-   Restauración de documentos y de versiones.
-   Recuperación después de reiniciar el servidor.
-   Política de compactación con lock por documento.
-   Límite de tamaño por documento.

**Resultado esperado:** documentos persistentes y recuperables, con una
definición clara de qué cambios están confirmados.

### Etapa 4 — Presence y Access

**Objetivo:** completar la experiencia colaborativa y la autorización.

-   Cursores remotos, usuarios conectados, colores y selecciones.
-   Awareness con identidad fijada por el servidor, throttle y
    expiración.
-   Login con forms/actions Remix (`form()`, `data-schema`, `session/auth`), emisión real de tickets y revocación.
-   Roles (`owner`, `editor`, `viewer`) aplicados en cada mensaje.
-   `document:access-changed` y cierre `4403` al revocar.
-   Rate limiting por usuario y por conexión.

**Resultado esperado:** experiencia visual de colaboración en vivo con
control de acceso verificado en el servidor.

### Etapa 5 — Observabilidad y resiliencia

**Objetivo:** poder medir y confiar en lo construido antes de
distribuirlo.

-   Métricas básicas (conexiones, documentos activos, latencia de
    propagación, tiempo de persistencia, errores).
-   Pruebas de convergencia con fuzzing (retrasos, pérdidas y
    reordenamientos).
-   Persistencia local del cliente (`y-indexeddb`) y pruebas de
    reconciliación offline.
-   Pruebas de updates inválidos o enormes y de aplicación del rol
    `viewer`.
-   Estrategia de evolución del schema de TipTap (sección 14).

**Resultado esperado:** una instancia única medible y probada contra
fallos, con base para comparar contra la versión distribuida.

### Etapa 6 — Distributed Architecture

**Objetivo:** escalar horizontalmente.

-   Múltiples instancias Deno detrás de un load balancer.
-   Redis Pub/Sub inicialmente (canal por documento, instancia de
    origen).
-   Orden de suscripción y resincronización tras pérdida de mensajes.
-   Awareness distribuido con expiración.
-   Recuperación ante caída de instancias.
-   Reconexión de clientes a otra instancia.

**Resultado esperado:** usuarios conectados a instancias diferentes
pueden colaborar en el mismo documento, y la caída de una instancia no
pierde cambios confirmados.

### Etapa 7 — Production Ready

**Objetivo:** preparar el proyecto para uso y demostración.

-   Publicación y documentación del SDK TypeScript.
-   Especificación SNP v1 publicada.
-   Ajuste fino de rate limiting y límites de recursos.
-   Dashboards de Grafana y tracing con OpenTelemetry.
-   Tests de carga y benchmarks reproducibles.
-   Documentación técnica y de decisiones.
-   Demo pública.

**Resultado esperado:** un producto demostrable, documentado y medible.

---

## 11. MVP: primera versión funcional

No conviene implementar toda la arquitectura distribuida al principio.
El primer MVP debe funcionar con una sola instancia, pero ya con
autenticación mínima: el handshake y el flujo de unión dependen de ella
y agregarla tarde obliga a rehacer el protocolo.

El MVP corresponde a las etapas 1 a 4.

### Funcionalidades del MVP

-   [ ] Registro/login básico.
-   [ ] Crear un documento.
-   [ ] Abrirlo desde dos navegadores (con ticket WebSocket de un solo
        uso).
-   [ ] Editar simultáneamente.
-   [ ] Mostrar cursores remotos.
-   [ ] Sincronizar cambios mediante WebSockets.
-   [ ] Guardar documentos en PostgreSQL y confirmar con `document:ack`.
-   [ ] Rol `viewer` que no puede modificar el documento (verificado en
        el servidor).
-   [ ] Reconectar automáticamente.
-   [ ] Recuperar el documento después de reiniciar el servidor.

### Criterio de finalización

Dos usuarios autenticados pueden editar el mismo documento
simultáneamente, cerrar sus conexiones, volver a entrar y recuperar el
estado correcto sin perder cambios confirmados por `document:ack`. Un
usuario `viewer` no puede modificar el documento aunque envíe frames
`UPDATE` manualmente.

---

## 12. Pruebas y objetivos de rendimiento

Los siguientes valores son **objetivos de prueba**, no capacidades
garantizadas. Deben medirse en un entorno documentado, con hardware,
configuración, tamaño de documentos y patrón de tráfico especificados.

### Perfil de carga inicial (hipótesis a ajustar)

-   Documento de tamaño moderado (por ejemplo, decenas de KB de estado).
-   Una fracción de los clientes escribiendo (por ejemplo, 20 %) a un
    ritmo de unos pocos caracteres por segundo; el resto solo lee.
-   Awareness con throttle activo.
-   Los números definitivos se fijan después del primer baseline y se
    registran junto con cada resultado.

### Objetivo de latencia (hipótesis a validar)

-   p95 de propagación de un update entre dos clientes de la misma
    instancia por debajo de 100 ms en localhost/LAN. El valor definitivo
    se fija tras la primera medición.

### Escenarios

| Escenario | Qué se busca demostrar |
|---|---|
| 1.000 conexiones simultáneas | Estabilidad del servidor (punto de partida; ampliar a 5.000–10.000 como objetivo extendido) |
| 100 editores en un documento | Sincronización concurrente y costo de awareness (con throttle) |
| Desconexión de un cliente | Recuperación sin perder cambios confirmados por ack |
| Reinicio del servidor | Restauración desde PostgreSQL |
| Caída del servidor entre difusión y commit | El cliente emisor reenvía lo no confirmado y no se pierde |
| Dos instancias | Sincronización entre nodos |
| Pérdida de mensajes en Redis | Resincronización por state vector |
| Compactación concurrente | Sin corrupción ni pérdida con el lock por documento |
| Cliente offline | Reconciliación al reconectar |
| Fuzzing de convergencia | N clientes con retrasos, pérdidas y reordenamientos terminan con el mismo estado |
| Rol `viewer` | Updates rechazados con `READ_ONLY` |
| Update inválido o enorme | Descartado sin afectar al documento ni al servidor |

### Métricas recomendadas

-   Conexiones activas.
-   Documentos activos.
-   Mensajes entrantes y salientes por segundo.
-   Latencia de propagación de updates (p50/p95/p99).
-   Latencia de sincronización inicial.
-   Tamaño promedio y máximo de mensajes.
-   Uso de CPU y memoria.
-   Tiempo de persistencia y tamaño de lote.
-   Retraso entre difusión y ack.
-   Errores y desconexiones (por código).
-   Tiempo de recuperación después de reinicios.

Herramientas posibles: Prometheus, Grafana, OpenTelemetry y herramientas
de generación de carga WebSocket.

---

## 13. Seguridad y resiliencia

Para acercar Synapse a un producto real, contemplar:

**Autenticación y sesiones**

-   Autenticación de conexiones mediante ticket de un solo uso y vida
    corta, ligado a usuario y documento.
-   Validación del header `Origin` en el handshake (evita el secuestro
    de WebSocket entre sitios cuando se usan cookies).
-   Excluir tickets y tokens de logs, métricas y mensajes de error.
-   Expiración y revocación de sesiones; cierre `4401` cuando una
    sesión deja de ser válida.
-   Hash de contraseñas con argon2id o bcrypt.

**Autorización**

-   Autorización por documento y workspace, siempre en el servidor.
-   El rol se verifica **en cada mensaje**, no solo al conectar: un
    `viewer` no puede enviar `UPDATE`.
-   Cambios de rol y revocaciones se aplican a conexiones abiertas
    (`document:access-changed`, cierre `4403`).
-   Awareness con identidad fijada por el servidor.

**Datos recibidos del cliente**

-   Validación de cada mensaje y de cada payload.
-   Límites de tamaño y frecuencia.
-   `applyUpdate` siempre dentro de try/catch; los updates inválidos
    se descartan sin afectar al documento.
-   Límite de tamaño de documento y de memoria por documento y
    conexión.
-   Rate limiting por usuario y conexión.
-   Protección contra abuso de conexiones.
-   Contenido enriquecido: sanitizar enlaces y cualquier HTML al
    renderizar o exportar.

**Operación**

-   Manejo seguro de errores (sin detalles internos).
-   No registrar tokens ni contenido sensible en logs.
-   Timeouts y heartbeats.
-   Backpressure para clientes lentos.
-   Recuperación y limpieza de sesiones obsoletas.

La autorización debe verificarse en el servidor; no alcanza con ocultar
documentos ni deshabilitar el editor en el frontend.

---

## 14. Riesgos y decisiones abiertas

### Riesgos conocidos

| Riesgo | Mitigación | Etapa |
|---|---|---|
| Pérdida de un update entre la difusión y el commit | Ack posterior al commit; el cliente conserva lo no confirmado y resincroniza por state vector | 3 |
| Crecimiento del historial y del tamaño de documentos | Snapshots, compactación con retención, límite de tamaño por documento | 3 |
| Copias duplicadas de Yjs en el monorepo | Una única versión en el workspace; verificar que server, SDK y web resuelven la misma copia | 1 |
| Fan-out cuadrático del tráfico de awareness | Throttle, límites por conexión, medición en la prueba de 100 editores | 4 |
| Contenido válido para Yjs pero inválido para el schema de ProseMirror (cliente malicioso o con bug) | Límites de tamaño, try/catch, renderizado tolerante en el cliente, restaurar versión; validación en el servidor como mejora opcional | 5 |
| Evolución del schema de TipTap (agregar o quitar extensiones puede romper documentos existentes) | Campo `schema_version` en `documents`, cambios aditivos, tests con documentos de versiones anteriores | 5 |
| Pérdida de mensajes en Redis Pub/Sub | Resincronización por state vector, o log durable con Redis solo como aviso | 6 |
| Compactación concurrente entre tareas o instancias | Lock por documento | 3 y 6 |
| Expansión del alcance (Workspace Management, funciones tipo Google Docs) | Sección 1.2 (fuera de alcance) y roles simplificados | Todas |

### Decisiones abiertas

-   Formato final del frame `UPDATE` y del campo `cseq` (se valida en la
    etapa 2).
-   Ticket en la URL o alternativa (por ejemplo, mensaje de
    autenticación inicial tras abrir la conexión).
-   Sesión con cookie o con token de portador.
-   Ventana de agrupamiento de updates y umbrales de snapshot.
-   Política concreta de retención del historial.
-   Límite de tamaño por documento y por mensaje.
-   Redis Pub/Sub, Redis Streams o NATS JetStream para la etapa 6.
-   Si se mantiene "cualquier instancia aloja cualquier documento" o se
    pasa a ownership por documento.

---

## 15. Qué hará destacar el proyecto en el portfolio

Además de que el editor funcione, conviene entregar artefactos que
demuestren calidad de ingeniería:

1.  **README claro:** problema, funcionalidades, instalación y demo.
2.  **Diagrama de arquitectura:** componentes y flujos (MVP y
    distribuido).
3.  **Especificación del protocolo SNP:** frames, mensajes, errores,
    códigos de cierre y versionado.
4.  **SDK TypeScript:** API sencilla para integradores (cliente SNP vanilla `clientEntry`).
5.  **Benchmarks reproducibles:** metodología, perfil de carga, hardware
    y resultados.
6.  **Tests de integración:** concurrencia, reconexión y persistencia.
7.  **Suite de convergencia:** fuzzing con retrasos, pérdidas y
    reordenamientos; es la prueba más directa de que el sistema
    converge.
8.  **Demo multiusuario:** dos o más sesiones editando el mismo
    documento.
9.  **Observabilidad:** dashboard con conexiones, latencia y errores.
10. **Docker Compose:** entorno local de un solo comando.
11. **Documentación de decisiones:** por qué se eligieron Yjs,
    PostgreSQL, Redis y WebSockets, e incluir la comparación con
    `y-websocket` y Hocuspocus (qué aportan, qué no cubren y por qué
    Synapse construye su propio servidor).

---

## 16. Orden recomendado de implementación (Deno + Remix v3)

Para mantener el alcance controlado (equivale a las etapas de la
sección 10):

1.  Crear el monorepo Remix v3 en Deno 2, fijar una
    única versión de Yjs y levantar Docker Compose base.
2.  Implementar `server.ts` con bifurcación (`/ws/*` vs `router.fetch`) + handshake (ticket, `Origin`,
    `snp.v1`) y un sistema básico de rooms.
3.  Crear el shell Remix + editor TipTap Core vanilla en `clientEntry` (fuera de Frames).
4.  Integrar Yjs vanilla en dos clientes mediante cliente SNP (`packages/sdk`).
5.  Implementar la sincronización por frames `SYNC_STEP1/2` y `UPDATE`.
6.  Integrar PostgreSQL: updates por lotes, `seq`, snapshots y `ack`.
7.  Implementar autenticación, roles y permisos por mensaje, junto con
    awareness y cursores remotos.
8.  Agregar métricas básicas, pruebas de convergencia y de recuperación,
    y persistencia local del cliente.
9.  Incorporar Redis, load balancer y múltiples instancias.
10. Publicar SDK, especificación SNP, documentación y benchmarks.

---

## 17. Decisiones iniciales recomendadas

| Decisión | Elección inicial |
|---|---|
| Runtime | Deno 2 |
| Lenguaje | TypeScript |
| Servidor HTTP/UI | Remix v3 `router.fetch` en Deno (`Deno.serve`) |
| WebSocket | `Deno.upgradeWebSocket` en `/ws/*` (fuera de Remix), una conexión por documento |
| Autenticación WebSocket | Ticket de un solo uso + validación de `Origin` |
| Protocolo | SNP `snp.v1`: JSON de control + frames binarios, con `document:ack` |
| Motor CRDT | Yjs |
| Editor | TipTap Core vanilla en `clientEntry` (fuera de Frames) |
| Frontend | Remix v3 Component Model + Frames para shell (sin Vite React) |
| Persistencia local del cliente | `y-indexeddb` (etapa 5) |
| Base de datos | PostgreSQL (updates con `seq`, snapshots con `last_seq`) |
| Durabilidad | Difundir antes de persistir; ack tras commit |
| Mensajería distribuida | Redis Pub/Sub (con resincronización por state vector) |
| Modelo multi-instancia | Cualquier instancia aloja cualquier documento |
| Infraestructura local | Docker Compose |
| Observabilidad | Prometheus + Grafana |
| Arquitectura inicial | Monolito modular |
| Arquitectura futura | Varias instancias coordinadas |

### Recomendación final

La combinación recomendada para empezar es **Yjs + Deno nativo +
WebSockets + React/TipTap + PostgreSQL**, con un handshake autenticado
desde el principio.

Primero hay que conseguir una colaboración correcta en una sola
instancia, con autenticación mínima y durabilidad explícita. Después se
agregan observabilidad, reconexión y offline robustos, y por último la
distribución horizontal.

No conviene introducir microservicios, Redis o un CRDT propio antes de
tener un flujo de edición colaborativa que funcione y esté cubierto por
pruebas.

**La primera meta concreta:** dos usuarios autenticados, dos
navegadores, un documento compartido, cambios sincronizados en tiempo
real, confirmación de persistencia con `document:ack` y recuperación
después de reiniciar el servidor.

---

## Apéndice: cambios respecto de la versión original

**Correcciones**

-   Se elimina `version` de `document:joined`: Yjs no tiene versión
    lineal; se usa `seq` del log durable.
-   `document_snapshots` incluye `last_seq`; `document_updates` incluye
    `seq` por documento y `author_id`.
-   Se resuelve la tensión entre historial/versiones y compactación
    (versiones nombradas como copias de estado; restaurar = nuevo
    update).
-   Se agrega `document:ack` y se define la política de durabilidad.
-   Se unifica el orden de roadmap, MVP y orden de implementación; la
    autenticación se adelanta al MVP.
-   Se elimina `presence:update` (se mantiene awareness).
-   El esquema cubre lo que prometía Workspace Management
    (`workspace_members`, `sessions`, visibilidad, links de acceso).
-   El diagrama del MVP ya no incluye Redis; se agrega uno distribuido
    aparte. Se elimina el "CRDT Engine" como componente propio.

**Mejoras y huecos cubiertos**

-   Handshake autenticado (ticket, `Origin`, subprotocolo `snp.v1`),
    una conexión por documento, frames binarios, códigos de error y de
    cierre.
-   Seguridad: roles por mensaje, revocación en caliente, awareness con
    identidad del servidor, updates inválidos, hash de contraseñas.
-   Persistencia local del cliente, undo/redo por usuario y
    `SynapseProvider` desde la etapa 2.
-   Reglas del monorepo (workspace, paquetes runtime-agnósticos, única
    copia de Yjs).
-   Arquitectura distribuida: orden de suscripción, pérdida de
    mensajes, lock de compactación, modelo multi-nodo, load balancer.
-   Pruebas: perfil de carga, objetivo de latencia, fuzzing de
    convergencia y escenarios de fallo; observabilidad adelantada.
-   Nuevas secciones: fuera de alcance, alternativas existentes,
    riesgos y decisiones abiertas.
