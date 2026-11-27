// Editor de código Monaco (Etapa UI editor de código). Se bindea a un
// `Y.Text` ("monaco") del doc compartido vía y-monaco; la presencia viaja
// por el awareness estándar (los cursores remotos los dibuja el binding).
import * as monaco from "monaco-editor";
import { MonacoBinding } from "y-monaco";
import { SynapseClient } from "@synapse/sdk";
import { indexedDbStorage } from "@synapse/sdk";

export interface CodeMountOptions {
  docId: string;
  ticket: string;
  baseUrl: string;
  language: string;
  /** Nombre visible para cursores remotos. */
  name?: string;
}

export interface CodeMountHandle {
  editor: monaco.editor.IStandaloneCodeEditor | null;
  client: SynapseClient;
  destroy: () => void;
}

const CURSOR_COLORS = [
  "#e6194b", "#3cb44b", "#0082c8", "#f58231",
  "#911eb4", "#46f0f0", "#f032e6", "#008080",
];

export function mountCodeEditor(container: HTMLElement, opts: CodeMountOptions): CodeMountHandle {
  const onError = (code: string, message: string) =>
    console.error(`[synapse] ${code}: ${message}`);
  let editor: monaco.editor.IStandaloneCodeEditor | null = null;
  let binding: MonacoBinding | null = null;
  let destroyed = false;

  function setConn(state: "on" | "off" | "err", text: string): void {
    for (const id of ["syn-conn", "syn-conn-top"]) {
      const el = document.getElementById(id);
      if (!el) continue;
      el.setAttribute("data-state", state);
      el.textContent = text;
    }
  }

  function setSeq(seq: number): void {
    const el = document.getElementById("syn-seq");
    if (el) el.textContent = String(seq);
  }

  const client = new SynapseClient({
    documentId: opts.docId,
    ticket: opts.ticket,
    baseUrl: opts.baseUrl,
    storage: indexedDbStorage(),
    onError,
    onJoined(info) {
      if (destroyed) return;
      mount();
      setConn("on", "conectado");
      setSeq(info.seq);
    },
    onAck({ seq }) {
      if (!destroyed) setSeq(seq);
    },
    onClose() {
      if (!destroyed) setConn("off", "desconectado");
    },
  });

  function mount(): void {
    container.replaceChildren();
    editor = monaco.editor.create(container, {
      theme: "vs-dark",
      language: opts.language || "typescript",
      automaticLayout: true,
      minimap: { enabled: false },
      matchBrackets: "always",
      autoClosingBrackets: "always",
      autoClosingQuotes: "always",
      autoClosingOvertype: "always",
      autoIndent: "full",
      guides: { bracketPairs: true },
      bracketPairColorization: { enabled: true },
      fontSize: 14,
      padding: { top: 12 },
      scrollBeyondLastLine: false,
    });
    const model = editor.getModel();
    if (!model) throw new Error("monaco sin modelo");
    const color = CURSOR_COLORS[client.awareness.clientID % CURSOR_COLORS.length];
    client.setPresence({
      user: { name: opts.name ?? `anon-${client.awareness.clientID}`, color },
    });
    binding = new MonacoBinding(
      client.doc.getText("monaco"),
      model,
      new Set([editor]),
      client.awareness,
    );
  }

  function updateOnline(): void {
    const el = document.getElementById("syn-online");
    if (el) el.textContent = String(client.awareness.getStates().size);
  }
  client.awareness.on("change", updateOnline);
  updateOnline();

  client.connect().catch((err: unknown) => {
    onError(
      "CONNECTION_FAILED",
      err instanceof Error ? err.message : String(err),
    );
  });

  return {
    get editor() {
      return editor;
    },
    client,
    destroy() {
      if (destroyed) return;
      destroyed = true;
      try {
        binding?.destroy();
      } catch { /* noop */ }
      try {
        client.awareness.off("change", updateOnline);
      } catch { /* noop */ }
      editor?.dispose();
      editor = null;
      client.close();
    },
  };
}
