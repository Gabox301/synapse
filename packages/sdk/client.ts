// Cliente SNP v1 vanilla (Yjs + y-protocols), runtime-agnóstico.
import * as Y from "yjs";
import {
  applyAwarenessUpdate,
  Awareness,
  encodeAwarenessUpdate,
} from "y-protocols/awareness";
import {
  decodeFrame,
  encodeAwareness,
  encodeSyncStep1,
  encodeSyncStep2,
  encodeUpdate,
  parseControlMessage,
  PROTOCOL_VERSION,
} from "../protocol/mod.ts";
import { browserTransport } from "./transport.ts";
import type { Transport } from "./transport.ts";
import type { SynapseStorage } from "./storage.ts";

/** Origen de transacción para updates aplicados desde la red (evita eco). */
const REMOTE_ORIGIN = "synapse-remote";

/** Prefijo de error fiel al que emite frames.ts (ver handler del servidor). */
function errorCodeOf(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err);
  const prefix = msg.split(":")[0];
  if (
    prefix === "MESSAGE_TOO_LARGE" || prefix === "INVALID_UPDATE" ||
    prefix === "UNKNOWN_MESSAGE"
  ) {
    return prefix;
  }
  return "UNKNOWN_MESSAGE";
}

export interface JoinedInfo {
  documentId: string;
  role: string;
  seq: number;
  /** Schema TipTap del documento (ver docs/schema-evolution.md). */
  schemaVersion: number;
}

export interface SynapseClientOptions {
  documentId: string;
  ticket: string;
  /** Base sin path final, ej: "ws://host:port". */
  baseUrl: string;
  createTransport?: (url: string, protocols: string[]) => Transport;
  /** Throttle de awareness en ms (spec: 50-100). 0 = sin throttle (tests). */
  awarenessThrottleMs?: number;
  /** Persistencia local (offline). Sin storage no se guarda ni se hidrata nada. */
  storage?: SynapseStorage;
  /** Throttle de guardado en ms. 0 = guardar en cada update local (tests). */
  storageThrottleMs?: number;
  onJoined?: (info: JoinedInfo) => void;
  onRemoteUpdate?: (update: Uint8Array) => void;
  onAck?: (info: { upTo: number; seq: number }) => void;
  onAwareness?: () => void;
  onAccessChanged?: (role: string) => void;
  onError?: (code: string, message: string) => void;
  onClose?: (code?: number) => void;
}

export class SynapseClient {
  readonly doc = new Y.Doc();
  private _awareness: Awareness;
  private awarenessDestroyed = false;
  private readonly opts:
    & Required<
      Omit<
        SynapseClientOptions,
        | "onJoined"
        | "onRemoteUpdate"
        | "onAck"
        | "onAwareness"
        | "onAccessChanged"
        | "onError"
        | "onClose"
        | "storage"
        | "storageThrottleMs"
      >
    >
    & Pick<
      SynapseClientOptions,
      | "onJoined"
      | "onRemoteUpdate"
      | "onAck"
      | "onAwareness"
      | "onAccessChanged"
      | "onError"
      | "onClose"
      | "storage"
      | "storageThrottleMs"
    >;
  private transport: Transport | null = null;
  private isOpen = false;
  private readonly outbox: Array<string | Uint8Array> = [];
  private cseq = 0;
  private readonly pending = new Map<number, Uint8Array>();
  private joinedResolve: ((info: JoinedInfo) => void) | null = null;
  private joinedReject: ((err: Error) => void) | null = null;
  private lastAwarenessSent = 0;
  private lastStorageSave = 0;
  private closed = false;

  constructor(opts: SynapseClientOptions) {
    this.opts = {
      createTransport: browserTransport,
      awarenessThrottleMs: 60,
      storage: undefined,
      storageThrottleMs: 1000,
      ...opts,
    };
    this._awareness = new Awareness(this.doc);
    this.wireAwareness();
    this.doc.on("update", (update: Uint8Array, origin: unknown) => {
      if (origin !== REMOTE_ORIGIN && !this.closed) {
        this.sendUpdate(update);
        this.maybeSaveStorage();
      }
    });
  }

  /** Instancia vigente (se recrea en reconnect tras un close). */
  get awareness(): Awareness {
    return this._awareness;
  }

  private wireAwareness(): void {
    this._awareness.on("update", (_: unknown, origin: unknown) => {
      if (origin !== REMOTE_ORIGIN) this.maybeSendAwareness();
    });
  }

  get pendingCount(): number {
    return this.pending.size;
  }

  get role(): string | null {
    return this.lastJoined?.role ?? null;
  }

  private lastJoined: JoinedInfo | null = null;

  /** Carga el snapshot local (si hay storage) y luego abre la conexión. */
  connect(): Promise<JoinedInfo> {
    const storage = this.opts.storage;
    if (!storage) return this.startConnect();
    try {
      const loaded = storage.load(this.opts.documentId);
      if (loaded instanceof Promise) {
        return loaded.then(
          (snap) => {
            this.applySnapshot(snap);
            return this.startConnect();
          },
          (err) => {
            this.reportStorageError(err);
            return this.startConnect();
          },
        );
      }
      this.applySnapshot(loaded);
      return this.startConnect();
    } catch (err) {
      this.reportStorageError(err);
      return this.startConnect();
    }
  }

  private startConnect(): Promise<JoinedInfo> {
    const url =
      `${this.opts.baseUrl}/ws/documents/${this.opts.documentId}?ticket=${
        encodeURIComponent(this.opts.ticket)
      }`;
    this.transport = this.opts.createTransport(url, [PROTOCOL_VERSION]);
    const current = this.transport;
    const isCurrent = () => this.transport === current;
    const promise = new Promise<JoinedInfo>((resolve, reject) => {
      this.joinedResolve = resolve;
      this.joinedReject = reject;
    });
    this.transport.onOpen(() => {
      if (!isCurrent()) return;
      this.isOpen = true;
      // El handshake va primero; luego se drena lo encolado en orden.
      current.send(encodeSyncStep1(Y.encodeStateVector(this.doc)));
      this.flushOutbox();
    });
    this.transport.onMessage((data) => {
      if (!isCurrent()) return;
      this.handleMessage(data);
    });
    this.transport.onClose((code) => {
      if (!isCurrent()) return;
      this.isOpen = false;
      this.opts.onClose?.(code);
      this.joinedReject?.(new Error("CONNECTION_CLOSED"));
      this.joinedResolve = null;
      this.joinedReject = null;
    });
    return promise;
  }

  /** Reconexión manual: re-handshake y resync por state vector (los pendientes convergen vía STEP2). */
  reconnect(ticket?: string): Promise<JoinedInfo> {
    try {
      this.transport?.close(1000);
    } catch {
      // ignorar: el transporte puede ya estar cerrado
    }
    this.isOpen = false;
    if (ticket) this.opts.ticket = ticket;
    this.closed = false;
    if (this.awarenessDestroyed) {
      this._awareness = new Awareness(this.doc);
      this.wireAwareness();
      this.awarenessDestroyed = false;
    }
    return this.connect();
  }

  ping(): void {
    this.sendRaw(JSON.stringify({ type: "connection:ping" }));
  }

  setPresence(state: Record<string, unknown>): void {
    this.awareness.setLocalState(state);
  }

  setPresenceField(key: string, value: unknown): void {
    this.awareness.setLocalStateField(key, value);
  }

  close(code = 1000): void {
    this.saveStorage();
    this.closed = true;
    this.isOpen = false;
    this.transport?.close(code);
    this.transport = null;
    // Higiene (Etapa 5): el intervalo propio de Awareness muere con el
    // cliente; si no, cada cliente abandonado pineaba su Y.Doc para siempre.
    if (!this.awarenessDestroyed) {
      this.awarenessDestroyed = true;
      this._awareness.destroy();
    }
    // Un close intencional cancela un join pendiente.
    this.joinedReject?.(new Error("CONNECTION_CLOSED"));
    this.joinedResolve = null;
    this.joinedReject = null;
  }

  private sendRaw(data: string | Uint8Array): void {
    if (this.isOpen && !this.closed && this.transport) {
      this.transport.send(data);
    } else if (!this.closed) {
      this.outbox.push(data);
    }
  }

  private flushOutbox(): void {
    while (this.outbox.length > 0 && !this.closed) {
      const data = this.outbox.shift();
      if (data !== undefined) this.transport?.send(data);
    }
  }

  private sendUpdate(update: Uint8Array): number {
    this.cseq += 1;
    let framed: Uint8Array;
    try {
      framed = encodeUpdate(this.cseq, update);
    } catch (err) {
      // Update local que no entra en un frame (p. ej. >65531 bytes):
      // no se encola ni se marca pendiente; el doc local queda intacto.
      this.cseq -= 1;
      const msg = err instanceof Error ? err.message : String(err);
      this.opts.onError?.(errorCodeOf(err), msg);
      return this.cseq;
    }
    this.pending.set(this.cseq, update);
    this.sendRaw(framed);
    return this.cseq;
  }

  /** Aplica el snapshot local antes del handshake (origen remoto: no reenvía). */
  private applySnapshot(snap: Uint8Array | null): void {
    if (!snap || snap.length === 0) return;
    try {
      Y.applyUpdate(this.doc, snap, REMOTE_ORIGIN);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.opts.onError?.("INVALID_UPDATE", `snapshot local corrupto: ${msg}`);
    }
  }

  private reportStorageError(err: unknown): void {
    const msg = err instanceof Error ? err.message : String(err);
    this.opts.onError?.("STORAGE_ERROR", msg);
  }

  private maybeSendAwareness(): void {
    if (!this.transport || this.closed) return;
    const now = Date.now();
    const throttle = this.opts.awarenessThrottleMs;
    if (throttle > 0 && now - this.lastAwarenessSent < throttle) return;
    this.lastAwarenessSent = now;
    this.sendRaw(
      encodeAwareness(
        encodeAwarenessUpdate(this.awareness, [this.awareness.clientID]),
      ),
    );
  }

  private maybeSaveStorage(): void {
    const storage = this.opts.storage;
    if (!storage || this.closed) return;
    const now = Date.now();
    const throttle = this.opts.storageThrottleMs ?? 1000;
    if (throttle > 0 && now - this.lastStorageSave < throttle) return;
    this.lastStorageSave = now;
    this.saveStorage();
  }

  /** Guarda el snapshot completo (se llama throttled en cada update y siempre al cerrar). */
  private saveStorage(): void {
    const storage = this.opts.storage;
    if (!storage) return;
    let state: Uint8Array;
    try {
      state = Y.encodeStateAsUpdate(this.doc);
    } catch (err) {
      this.reportStorageError(err);
      return;
    }
    try {
      const result = storage.save(this.opts.documentId, state);
      if (result instanceof Promise) {
        result.catch((err) => this.reportStorageError(err));
      }
    } catch (err) {
      this.reportStorageError(err);
    }
  }

  private handleMessage(data: string | Uint8Array | ArrayBuffer): void {
    if (typeof data === "string") {
      this.handleControl(data);
      return;
    }
    const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
    let frame;
    try {
      frame = decodeFrame(bytes);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.opts.onError?.(errorCodeOf(err), msg);
      return;
    }
    try {
      switch (frame.type) {
        case 0x02:
          Y.applyUpdate(this.doc, frame.payload, REMOTE_ORIGIN);
          break;
        case 0x01:
          this.sendRaw(
            encodeSyncStep2(Y.encodeStateAsUpdate(this.doc, frame.payload)),
          );
          break;
        case 0x03:
          Y.applyUpdate(this.doc, frame.payload, REMOTE_ORIGIN);
          this.opts.onRemoteUpdate?.(frame.payload);
          break;
        case 0x04:
          applyAwarenessUpdate(this.awareness, frame.payload, REMOTE_ORIGIN);
          this.opts.onAwareness?.();
          break;
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.opts.onError?.("INVALID_UPDATE", msg);
    }
  }

  private handleControl(text: string): void {
    let msg;
    try {
      msg = parseControlMessage(text);
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      this.opts.onError?.("UNKNOWN_MESSAGE", detail);
      return;
    }
    switch (msg.type) {
      case "document:joined": {
        const info: JoinedInfo = {
          documentId: msg.payload.documentId,
          role: msg.payload.role,
          seq: msg.payload.seq,
          // Forward-compat: servidores previos al guard no mandan el campo.
          schemaVersion: typeof msg.payload.schemaVersion === "number"
            ? msg.payload.schemaVersion
            : 1,
        };
        this.lastJoined = info;
        this.opts.onJoined?.(info);
        this.joinedResolve?.(info);
        this.joinedResolve = null;
        this.joinedReject = null;
        break;
      }
      case "document:ack": {
        const { upTo, seq } = msg.payload;
        for (const cseq of [...this.pending.keys()]) {
          if (cseq <= upTo) this.pending.delete(cseq);
        }
        this.opts.onAck?.({ upTo, seq });
        break;
      }
      case "document:error":
        this.opts.onError?.(msg.payload.code, msg.payload.message);
        break;
      case "document:access-changed":
        this.opts.onAccessChanged?.(msg.payload.role);
        break;
      default:
        break;
    }
  }
}
