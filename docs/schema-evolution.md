# Evolución del schema TipTap (Etapa 5)

El contenido es un `Y.XmlFragment` que ProseMirror/TipTap interpreta con las
extensiones de la app. Agregar o quitar extensiones puede volver ilegibles los
documentos existentes (nodos/marcas desconocidas), así que el schema se versiona
por documento en `documents.schema_version` (migración `0001_init.sql`,
`INT NOT NULL DEFAULT 1`).

## Qué es la versión

- **v1 = StarterKit actual** (`history` desactivado; undo vía `yUndoPlugin`).
- Describe los nodos/marcas que el editor sabe interpretar, **no** el historial:
  `schemaVersion` ≠ `version`/state vector lineal de Yjs (que el apéndice de
  `synapse-proyecto.md` descarta como criterio de sync). Acá no se compara ni
  rechaza nada por la versión de Yjs.
- Editar contenido **no** la cambia; solo una migración de schema lo hace.
- Una sola versión soportada por binario: `SUPPORTED_SCHEMA_VERSION` en
  `packages/protocol/schema.ts` es la fuente de verdad server/SDK/editor.

## Reglas de cambio

1. Solo cambios **aditivos**: agregar extensiones, nodos o marcas; nunca
   renombrar ni quitar de golpe.
2. Cada conjunto incompatible sube la versión en +1 (2, 3, …); cambios
   cosméticos o de UI no la tocan.

## Procedimiento de bump

1. Escribir la migración de contenido (pasada única) al nuevo schema.
2. Ejecutarla bajo `withDocLock(documentId)`
   (`apps/server/realtime/persistence.ts`) para no competir con un flush.
3. Antes de tocar contenido, sacar un **snapshot nombrado** (`kind = 'named'`)
   como punto de retorno, registrando el `last_seq` usado.
4. En la misma transacción, `UPDATE documents SET schema_version = N`.
5. Subir `SUPPORTED_SCHEMA_VERSION` en el mismo release.

## Comportamiento ante versión desconocida

- **Servidor** (`apps/server/realtime/durability.ts`): `checkSchemaVersion`
  corre **antes** de crear el `Y.Doc` en memoria y de aplicar cualquier byte. Si
  es mayor a la soportada lanza `SCHEMA_UNSUPPORTED` y el doc **no** queda en
  memoria: no se sirve, no se persiste, no se puede corromper. La conexión
  recibe `document:error` con `code: "SCHEMA_UNSUPPORTED"` y cierra con `4415`
  (`CLOSE_CODES.SCHEMA_UPGRADE_REQUIRED`). Ausente/nulo/basura ⇒ v1 (legacy).
- **SDK** (`packages/sdk/client.ts`): `document:joined` trae `schemaVersion`; si
  el servidor no lo manda se asume 1 (forward-compat).
- **Editor** (`.../edit/public/mount.ts`): fail-closed. Monta TipTap recién
  cuando el join confirma versión soportada; con una mayor **no monta**, reporta
  `SCHEMA_UNSUPPORTED` ("actualizá la app") y `editor` queda `null`, así que el
  cliente no escribe con un schema que no entiende.

La validación semántica del contenido (Yjs-válido / ProseMirror-inválido) sigue
siendo best-effort: límites de tamaño, `try/catch` y snapshots restaurables.
