// SNP v1 — versión del schema TipTap (runtime-agnóstico).
// Dimensión DISTINTA del `version` lineal de Yjs (que en el apéndice de la spec
// se rechaza): schemaVersion describe las extensiones/nodos que entiende el
// editor (hoy StarterKit = 1); no cambia con las ediciones del documento.
// `documents.schema_version` (migración 0001) es la fuente de verdad por doc.

export const SUPPORTED_SCHEMA_VERSION = 1;

export type SchemaVersionCheck =
  | { ok: true; version: number }
  | { ok: false; stored: number; supported: number };

/**
 * Coacciona el valor almacenado (INT de PG o texto) a número de versión.
 * Sin dato o con basura se asume 1: las filas legacy viven sin versión y un
 * valor corrupto no debe volver el documento ilegible (fail-open acotado).
 */
function coerceVersion(stored: unknown): number {
  if (stored === null || stored === undefined) return 1;
  if (typeof stored === "number") return Number.isFinite(stored) ? stored : 1;
  if (typeof stored === "string") {
    const n = Number(stored);
    return Number.isFinite(n) ? n : 1;
  }
  return 1;
}

/**
 * Guard de arranque: acepta cualquier versión hasta la soportada (inclusive)
 * y rechaza las superiores — un documento escrito con un schema más nuevo
 * puede contener nodos que este binario no sabe preservar.
 */
export function checkSchemaVersion(stored: unknown): SchemaVersionCheck {
  const version = coerceVersion(stored);
  if (version > SUPPORTED_SCHEMA_VERSION) {
    return { ok: false, stored: version, supported: SUPPORTED_SCHEMA_VERSION };
  }
  return { ok: true, version };
}
