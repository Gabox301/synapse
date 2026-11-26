import { Editor, Extension } from "@tiptap/core";
import StarterKit from "@tiptap/starter-kit";
import type { Awareness } from "y-protocols/awareness";
import { yCursorPlugin, ySyncPlugin, yUndoPlugin } from "y-prosemirror";
import type * as Y from "yjs";
import { SynapseClient } from "@synapse/sdk";

export interface MountOptions {
  docId: string;
  ticket: string;
  baseUrl: string;
  /** Nombre visible para cursores remotos. */
  name?: string;
  onError?: (code: string, message: string) => void;
}

export interface MountHandle {
  editor: Editor;
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
    if (!yXml || !awareness) throw new Error("synapse-collab sin yXml/awareness");
    return [ySyncPlugin(yXml), yCursorPlugin(awareness), yUndoPlugin()];
  },
});

export function mountEditor(container: Element, opts: MountOptions): MountHandle {
  const onError = opts.onError ??
    ((code: string, message: string) => console.error(`[synapse] ${code}: ${message}`));
  const client = new SynapseClient({
    documentId: opts.docId,
    ticket: opts.ticket,
    baseUrl: opts.baseUrl,
    onError,
  });

  const color = CURSOR_COLORS[client.awareness.clientID % CURSOR_COLORS.length];
  client.setPresence({ user: { name: opts.name ?? `anon-${client.awareness.clientID}`, color } });

  const editor = new Editor({
    element: container,
    extensions: [
      StarterKit.configure({ history: false }),
      Collaboration.configure({
        yXml: client.doc.getXmlFragment("prosemirror"),
        awareness: client.awareness,
      }),
    ],
    content: "",
  });

  client.connect().catch((err: unknown) => {
    onError("CONNECTION_FAILED", err instanceof Error ? err.message : String(err));
  });

  let destroyed = false;
  return {
    editor,
    client,
    destroy() {
      if (destroyed) return;
      destroyed = true;
      editor.destroy();
      client.close();
    },
  };
}
