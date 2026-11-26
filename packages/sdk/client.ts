// Cliente SNP v1 vanilla (Yjs + y-protocols), runtime-agnóstico.
import * as Y from "yjs";
import {
  Awareness,
  applyAwarenessUpdate,
  encodeAwarenessUpdate,
} from "y-protocols/awareness";
import {
  PROTOCOL_VERSION,
  decodeFrame,
  encodeAwareness,
  encodeSyncStep1,
  encodeSyncStep2,
  encodeUpdate,
  parseControlMessage,
} from "../protocol/mod.ts";
import { browserTransport } from "./transport.ts";
import type { Transport } from "./transport.ts";

/** Origen de transacción para updates aplicados desde la red (evita eco). */
const REMOTE_ORIGIN = "synapse-remote";

export interface JoinedInfo {
  documentId: string;
  role: string;
  seq: number;
}

export interface SynapseClientOptions {
  documentId: string;
  ticket: string;
  /** Base sin path final, ej: "ws://host:port". */
  baseUrl: string;
  createTransport?: (url: string, protocols: string[]) => Transport;
  /** Throttle de awareness en ms (spec: 50-100). 0 = sin throttle (tests). */
  awarenessThrottleMs?: number;
  onJoined?: (info: JoinedInfo) => void;
  onRemoteUpdate?: (update: Uint8Array) => void;
  onAwareness?: () => void;
  onAccessChanged?: (role: string) => void;
  onError?: (code: string, message: string) => void;
  onClose?: () => void;
}

export class SynapseClient {
  readonly doc = new Y.Doc();
  readonly awareness: Awareness;
  private readonly opts: Required<Omit<SynapseClientOptions, "onJoined" | "onRemoteUpdate" | "onAwareness" | "onAccessChanged" | "onError" | "onClose">> &
    Pick<SynapseClientOptions, "onJoined" | "onRemoteUpdate" | "onAwareness" | "onAccessChanged" | "onError" | "onClose">;
  private transport: Transport | null = null;
  private isOpen = false;
  private readonly outbox: Array<string | Uint8Array> = [];
  private cseq = 0;
  private readonly pending = new Map<number, Uint8Array>();
  private joinedResolve: ((info: JoinedInfo) => void) | null = null;
  private joinedReject: ((err: Error) => void) | null = null;
  private lastAwarenessSent = 0;
  private closed = false;

  constructor(opts: SynapseClientOptions) {
    this.opts = {
      createTransport: browserTransport,
      awarenessThrottleMs: 60,
      ...opts,
    };
    this.awareness = new Awareness(this.doc);
    this.doc.on("update", (update: Uint8Array, origin: unknown) => {
      if (origin !== REMOTE_ORIGIN && !this.closed) {
        this.sendUpdate(update);
      }
    });
    this.awareness.on("update", (_: unknown, origin: unknown) => {
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

  connect(): Promise<JoinedInfo> {
    const url = `${this.opts.baseUrl}/ws/documents/${this.opts.documentId}?ticket=${encodeURIComponent(this.opts.ticket)}`;
    this.transport = this.opts.createTransport(url, [PROTOCOL_VERSION]);
    const promise = new Promise<JoinedInfo>((resolve, reject) => {
      this.joinedResolve = resolve;
      this.joinedReject = reject;
    });
    this.transport.onOpen(() => {
      this.isOpen = true;
      // El handshake va primero; luego se drena lo encolado en orden.
      this.transport?.send(encodeSyncStep1(Y.encodeStateVector(this.doc)));
      this.flushOutbox();
    });
    this.transport.onMessage((data) => this.handleMessage(data));
    this.transport.onClose(() => {
      this.isOpen = false;
      this.opts.onClose?.();
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
    this.closed = true;
    this.transport?.close(code);
    this.transport = null;
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
    this.pending.set(this.cseq, update);
    this.sendRaw(encodeUpdate(this.cseq, update));
    return this.cseq;
  }

  private maybeSendAwareness(): void {
    if (!this.transport || this.closed) return;
    const now = Date.now();
    const throttle = this.opts.awarenessThrottleMs;
    if (throttle > 0 && now - this.lastAwarenessSent < throttle) return;
    this.lastAwarenessSent = now;
    this.sendRaw(encodeAwareness(encodeAwarenessUpdate(this.awareness, [this.awareness.clientID])));
  }

  private handleMessage(data: string | Uint8Array | ArrayBuffer): void {
    if (typeof data === "string") {
      this.handleControl(data);
      return;
    }
    const bytes = data instanceof Uint8Array
      ? data
      : new Uint8Array(data);
    let frame;
    try {
      frame = decodeFrame(bytes);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.opts.onError?.("UNKNOWN_MESSAGE", msg);
      return;
    }
    try {
      switch (frame.type) {
        case 0x02:
          Y.applyUpdate(this.doc, frame.payload, REMOTE_ORIGIN);
          break;
        case 0x01:
          this.sendRaw(encodeSyncStep2(Y.encodeStateAsUpdate(this.doc, frame.payload)));
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
        };
        this.lastJoined = info;
        this.opts.onJoined?.(info);
        this.joinedResolve?.(info);
        this.joinedResolve = null;
        this.joinedReject = null;
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
