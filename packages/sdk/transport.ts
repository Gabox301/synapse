// Transporte WebSocket inyectable: el SDK no toca el socket global salvo en browserTransport.
export interface Transport {
  send(data: string | Uint8Array): void;
  close(code?: number): void;
  onOpen(cb: () => void): void;
  onMessage(cb: (data: string | Uint8Array | ArrayBuffer) => void): void;
  onClose(cb: () => void): void;
}

/** Transporte para browser/Deno usando el WebSocket global (se resuelve al llamar, no al importar). */
export function browserTransport(url: string, protocols: string[]): Transport {
  const ws = new WebSocket(url, protocols);
  ws.binaryType = "arraybuffer";
  return {
    send(data: string | Uint8Array): void {
      if (typeof data === "string") ws.send(data);
      else ws.send(data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) as ArrayBuffer);
    },
    close(code?: number): void {
      ws.close(code);
    },
    onOpen(cb: () => void): void {
      ws.onopen = cb;
    },
    onMessage(cb: (data: string | Uint8Array | ArrayBuffer) => void): void {
      ws.onmessage = (ev) => cb(ev.data);
    },
    onClose(cb: () => void): void {
      ws.onclose = () => cb();
    },
  };
}
