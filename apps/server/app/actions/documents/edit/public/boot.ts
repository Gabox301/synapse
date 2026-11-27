// Entrada plana del editor (Etapa UI): se empaqueta con esbuild a
// editor.bundle.js autocontenido. Lee la sesión de los data attrs que
// renderiza DocumentShell y monta TipTap vía mountEditor.
// (El `clientEntry` de Remix no resolvía bare imports en browser.)
import { mountEditor } from "./mount.ts";

const el = document.getElementById("syn-editor");
if (!el) throw new Error("syn-editor no encontrado");
const { docId, ticket, baseUrl, name } = el.dataset;
if (!docId || !ticket || !baseUrl) throw new Error("faltan datos de sesión del editor");

mountEditor(el, { docId, ticket, baseUrl, name: name || undefined });
