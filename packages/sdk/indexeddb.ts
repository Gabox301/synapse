// Backend IndexedDB para SynapseStorage (persistencia local real del cliente).
//
// Guarda snapshots Yjs completos por documentId (structured clone). Es la
// opción "o equivalente" de la spec: y-indexeddb persiste updates
// incrementales con su propia API atada al Y.Doc, mientras que nuestro
// contrato es snapshot load/save; IndexedDB nativo cubre eso sin deps de
// runtime. Si los docs crecen al punto de que el snapshot throttled pese,
// se puede sumar un backend incremental detrás de la misma interfaz.
//
// Solo corre en browser (mount.ts es clientEntry). El acceso a `indexedDB`
// es perezoso: importar este módulo en SSR no toca ningún global.
import type { SynapseStorage } from "./storage.ts";

const STORE = "snapshots";

const openPromises = new Map<string, Promise<IDBDatabase>>();

function idb(): IDBFactory {
  const factory = globalThis.indexedDB;
  if (!factory) throw new Error("IndexedDB no disponible en este entorno");
  return factory;
}

function openDb(dbName: string): Promise<IDBDatabase> {
  let open = openPromises.get(dbName);
  if (!open) {
    open = new Promise<IDBDatabase>((resolve, reject) => {
      const req = idb().open(dbName, 1);
      req.onupgradeneeded = () => {
        if (!req.result.objectStoreNames.contains(STORE)) {
          req.result.createObjectStore(STORE);
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () =>
        reject(req.error ?? new Error("IndexedDB open falló"));
      req.onblocked = () => reject(new Error("IndexedDB open bloqueado"));
    });
    openPromises.set(dbName, open);
  }
  return open;
}

function tx<T>(
  db: IDBDatabase,
  mode: IDBTransactionMode,
  run: (store: IDBObjectStore) => IDBRequest<T>,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const transaction = db.transaction(STORE, mode);
    transaction.onerror = () =>
      reject(transaction.error ?? new Error("IndexedDB txn falló"));
    transaction.onabort = () =>
      reject(transaction.error ?? new Error("IndexedDB txn abortada"));
    const req = run(transaction.objectStore(STORE));
    req.onsuccess = () => resolve(req.result);
    req.onerror = () =>
      reject(req.error ?? new Error("IndexedDB request falló"));
  });
}

function toSnapshot(value: unknown): Uint8Array | null {
  if (!value) return null;
  if (value instanceof Uint8Array) return value.slice();
  if (value instanceof ArrayBuffer) return new Uint8Array(value.slice(0));
  if (ArrayBuffer.isView(value)) {
    return new Uint8Array(
      value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength),
    );
  }
  return null;
}

/** Storage persistente en IndexedDB (sobrevive cierre/recarga del browser). */
export function indexedDbStorage(dbName = "synapse"): SynapseStorage {
  // Falla rápido si no hay IndexedDB (SSR/tests sin fake).
  idb();
  return {
    load: async (documentId: string) =>
      toSnapshot(
        await tx(await openDb(dbName), "readonly", (s) => s.get(documentId)),
      ),
    save: async (documentId: string, state: Uint8Array) => {
      await tx(
        await openDb(dbName),
        "readwrite",
        (s) => s.put(state.slice(), documentId),
      );
    },
    clear: async (documentId: string) => {
      await tx(await openDb(dbName), "readwrite", (s) => s.delete(documentId));
    },
  };
}
