import { ImportMap } from "remix/component/server";
import type { Handle } from "remix/component";

import type { assets } from "../assets.ts";
import { SynapseEditor } from "../actions/documents/edit/public/editor.tsx";

type EntryMeta = Awaited<ReturnType<typeof assets.getScriptEntry>>;

export function DocumentShell(
  handle: Handle<{
    docId: string;
    ticket: string;
    baseUrl: string;
    entry: EntryMeta;
  }>,
) {
  const { docId, ticket, baseUrl, entry } = handle.props;
  return () => (
    <html lang="es">
      <head>
        <meta charset="utf-8" />
        <title>Synapse — {docId}</title>
        <ImportMap value={entry.importMap} />
        {entry.preloads.map((href) => (
          <link rel="modulepreload" href={href} />
        ))}
        <script type="module" src={entry.href} />
      </head>
      <body>
        <header>
          <h1>Synapse</h1>
          <p>Documento: {docId}</p>
        </header>
        <main>
          <SynapseEditor docId={docId} ticket={ticket} baseUrl={baseUrl} />
        </main>
      </body>
    </html>
  );
}
