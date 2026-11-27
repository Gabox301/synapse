// Persistencia local del cliente (Etapa 5 T3): interfaz enchufable + default en memoria.
//
// La spec solo exige "y-indexeddb (o equivalente)": sobrevivir cierre/recarga
// y reconciliar al reconectar. El formato es el snapshot Yjs
// (`Y.encodeStateAsUpdate`), runtime-agnóstico. El default en memoria sirve
// para tests y SSR; en el navegador se inyecta un backend IndexedDB con esta
// misma interfaz (ver punto de wiring en mount.ts).

/** Contrato mínimo de storage local por documento. */
export interface SynapseStorage {
  /** Snapshot previamente guardado o null si no hay. Puede ser síncrono. */
  load(documentId: string): Promise<Uint8Array | null> | Uint8Array | null;
  /** Guarda el snapshot completo. Puede ser síncrono. */
  save(documentId: string, state: Uint8Array): Promise<void> | void;
  /** Borra el snapshot (logout / documento eliminado). Opcional. */
  clear?(documentId: string): Promise<void> | void;
}

/** Backend en memoria: pierde todo al recargar, útil para tests y SSR. */
export function memoryStorage(): SynapseStorage {
  const states = new Map<string, Uint8Array>();
  return {
    load: (documentId: string) => states.get(documentId) ?? null,
    save: (documentId: string, state: Uint8Array) => {
      states.set(documentId, state.slice());
    },
    clear: (documentId: string) => {
      states.delete(documentId);
    },
  };
}
