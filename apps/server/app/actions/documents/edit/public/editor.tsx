import { clientEntry, ref } from "remix/component";
import type { Handle } from "remix/component";

// Etapa 2 slice (a): boundary del editor como clientEntry fuera de <Frame>.
// El montaje TipTap + SDK llega en el slice (b); este stub prueba el pipeline
// (render SSR, import maps, entry, hidratación) sin lógica de editor.
export const SynapseEditor = clientEntry(
  import.meta.url,
  function SynapseEditor(handle: Handle<{ docId: string; ticket: string; baseUrl: string }>) {
    let root: Element | null = null;
    handle.queueTask(() => {
      // Solo corre en el browser, tras el commit: marca hidratación.
      if (root) (root as Element & { dataset: Record<string, string> }).dataset.hydrated = "true";
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
