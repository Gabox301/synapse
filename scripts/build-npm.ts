// Build del SDK a paquete npm (Etapa 7 T2; verificado en T1 con dnt 0.44.0).
// Uso: deno task build-sdk   → sale en ./npm/sdk (ignorado por git).
// Publicar (solo con orden explícita + credenciales):
//   cd npm/sdk && npm publish [--dry-run]
import { build, emptyDir } from "jsr:@deno/dnt";
import sdkDenoJson from "../packages/sdk/deno.json" with { type: "json" };

const version = (sdkDenoJson as { version?: string }).version ?? "0.1.0";

await emptyDir("./npm/sdk");
await build({
  entryPoints: ["./packages/sdk/mod.ts"],
  outDir: "./npm/sdk",
  shims: {},
  // Los *_test.ts usan Deno.test: no entran al paquete.
  test: false,
  compilerOptions: {
    lib: ["ESNext", "DOM", "DOM.Iterable"],
  },
  package: {
    name: "@synapse/sdk",
    version,
    description:
      "Cliente TypeScript para Synapse, motor colaborativo en tiempo real (Yjs + SNP v1).",
    license: "MIT",
    author: "Gabo",
    repository: {
      type: "git",
      url: "https://github.com/Gabox301/synapse.git",
    },
    keywords: ["yjs", "crdt", "collaboration", "websocket", "realtime"],
    engines: { node: ">=20" },
  },
});
console.log(`build npm OK (@synapse/sdk v${version} en ./npm/sdk)`);
