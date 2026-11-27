// Entrada del editor de código (docs kind === "code"). Se empaqueta con
// esbuild a code.bundle.js autocontenido (incluye el CSS de Monaco).
// @ts-ignore: esbuild inyecta este CSS en el bundle (loader css); Deno no lo resuelve.
import "monaco-editor/min/vs/editor/editor.main.css";

import { mountCodeEditor } from "./mount-code.ts";

const el = document.getElementById("syn-code-editor");
if (!el) throw new Error("syn-code-editor no encontrado");
const { docId, ticket, baseUrl, language, name } = (el as HTMLElement).dataset;
if (!docId || !ticket || !baseUrl) throw new Error("faltan datos de sesión del editor");

mountCodeEditor(el, {
  docId,
  ticket,
  baseUrl,
  language: language || "typescript",
  name: name || undefined,
});
