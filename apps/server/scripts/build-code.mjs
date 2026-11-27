// Build del editor de código (Etapa UI editor Monaco).
// Corre con cwd=apps/server (vía `pnpm --filter @synapse/server run build:code`).
// El exports map de monaco-editor 0.58 rompe los deep imports bajo
// resolutores estrictos: se unifican con alias (el CSS va por ruta absoluta
// resuelta vía package.json, que siempre está exenta del exports map).
import { build } from "esbuild";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { existsSync } from "node:fs";

const require = createRequire(resolve(process.cwd(), "package.json"));
let monacoDir = dirname(require.resolve("monaco-editor"));
while (!existsSync(join(monacoDir, "package.json")) && monacoDir !== dirname(monacoDir)) {
  monacoDir = dirname(monacoDir);
}

await build({
  entryPoints: ["app/actions/documents/edit/public/boot-code.ts"],
  bundle: true,
  platform: "browser",
  format: "esm",
  outfile: "app/actions/documents/edit/public/code.bundle.js",
  loader: { ".css": "css", ".ttf": "dataurl" },
  alias: {
    "monaco-editor/esm/vs/editor/editor.api.js": "monaco-editor",
    "monaco-editor/min/vs/editor/editor.main.css": `${monacoDir}/min/vs/editor/editor.main.css`,
  },
  minify: true,
  logLevel: "warning",
});
console.log("build code OK: app/actions/documents/edit/public/code.bundle.js");
