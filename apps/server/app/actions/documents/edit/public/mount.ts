import { Editor, Extension } from "@tiptap/core";
import StarterKit from "@tiptap/starter-kit";
import type { Awareness } from "y-protocols/awareness";
import { yCursorPlugin, ySyncPlugin, yUndoPlugin } from "y-prosemirror";
import type * as Y from "yjs";
import { SynapseClient } from "@synapse/sdk";
import { indexedDbStorage } from "@synapse/sdk";
import { SUPPORTED_SCHEMA_VERSION } from "../../../../../../../packages/protocol/schema.ts";

export interface MountOptions {
  docId: string;
  ticket: string;
  baseUrl: string;
  /** Nombre visible para cursores remotos. */
  name?: string;
  onError?: (code: string, message: string) => void;
}

export interface MountHandle {
  /**
   * null cuando el editor NO se montó: todavía no llegó `document:joined` o
   * el documento usa un schema TipTap que esta app no soporta (fail-closed).
   */
  editor: Editor | null;
  client: SynapseClient;
  destroy: () => void;
}

const CURSOR_COLORS = [
  "#e6194b",
  "#3cb44b",
  "#0082c8",
  "#f58231",
  "#911eb4",
  "#46f0f0",
  "#f032e6",
  "#008080",
];

interface CollabOptions {
  yXml: Y.XmlFragment | null;
  awareness: Awareness | null;
}

const Collaboration = Extension.create<CollabOptions>({
  name: "synapse-collab",
  addOptions() {
    return { yXml: null, awareness: null };
  },
  addProseMirrorPlugins() {
    const { yXml, awareness } = this.options;
    if (!yXml || !awareness) {
      throw new Error("synapse-collab sin yXml/awareness");
    }
    return [ySyncPlugin(yXml), yCursorPlugin(awareness), yUndoPlugin()];
  },
});

export function mountEditor(
  container: Element,
  opts: MountOptions,
): MountHandle {
  const onError = opts.onError ??
    ((code: string, message: string) =>
      console.error(`[synapse] ${code}: ${message}`));
  let editor: Editor | null = null;
  let destroyed = false;

  const client = new SynapseClient({
    documentId: opts.docId,
    ticket: opts.ticket,
    baseUrl: opts.baseUrl,
    onError,
    // Persistencia local real (Etapa 5): sobrevive cierre/recarga; al
    // volver, el snapshot hidrata el doc antes del handshake y el resync
    // trae solo el diff. mount.ts corre solo en browser (clientEntry).
    storage: indexedDbStorage(),
    // Fail-closed (Etapa 5): el editor se monta recién cuando el servidor
    // confirmó un schema TipTap soportado. Con uno más nuevo no se monta ni
    // se escribe: montar con un schema viejo podría borrar nodos desconocidos.
    onJoined: (info) => {
      if (destroyed) return;
      if (info.schemaVersion > SUPPORTED_SCHEMA_VERSION) {
        onError(
          "SCHEMA_UNSUPPORTED",
          `el documento usa schema v${info.schemaVersion} y esta app soporta v${SUPPORTED_SCHEMA_VERSION}: actualizá la app`,
        );
        return;
      }
      mountTiptap();
    },
  });

  function mountTiptap(): void {
    editor = new Editor({
      element: container,
      extensions: [
        StarterKit.configure({ undoRedo: false }),
        Collaboration.configure({
          yXml: client.doc.getXmlFragment("prosemirror"),
          awareness: client.awareness,
        }),
      ],
      content: "",
    });
  }

  const color = CURSOR_COLORS[client.awareness.clientID % CURSOR_COLORS.length];
  client.setPresence({
    user: { name: opts.name ?? `anon-${client.awareness.clientID}`, color },
  });

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
      editor?.destroy();
      editor = null;
      client.close();
    },
  };
}
