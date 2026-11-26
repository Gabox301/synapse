import { clientEntry, ref } from "remix/component";
import type { Handle } from "remix/component";

import { mountEditor } from "./mount.ts";

// Editor colaborativo como clientEntry fuera de <Frame>: hidrata el SSR
// y monta TipTap + y-prosemirror sobre el Y.Doc del SDK.
export const SynapseEditor = clientEntry(
  import.meta.url,
  function SynapseEditor(handle: Handle<{ docId: string; ticket: string; baseUrl: string }>) {
    let root: Element | null = null;
    handle.queueTask((signal) => {
      // Solo corre en el browser, tras el commit.
      if (!root) return;
      const mounted = mountEditor(root, {
        docId: handle.props.docId,
        ticket: handle.props.ticket,
        baseUrl: handle.props.baseUrl,
      });
      signal.addEventListener("abort", () => mounted.destroy(), { once: true });
    });
    return () => (
      <section>
        <div
          mix={[
            ref((node) => {
              root = node;
            }),
          ]}
          data-doc-id={handle.props.docId}
        >
          <p>Conectando al documento…</p>
        </div>
      </section>
    );
  },
);
