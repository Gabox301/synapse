import { createAssetServer } from "remix/assets";
import { dirname, resolve } from "node:path";

// Raíz del repo (este archivo vive en apps/server/app/: app -> server -> apps -> root).
const rootDir = resolve(import.meta.dirname!, "..", "..", "..");

export const assets = createAssetServer({
  basePath: "/assets",
  rootDir,
  // watch:false: el watcher (chokidar) no es fiable sobre /mnt/c (DrvFs/WSL)
  // y puede dejar promesas de compilación sin resolver. Sin HMR por ahora.
  watch: false,
  mounts: {
    app: "apps/server/app",
    npm: "apps/server/node_modules",
    packages: "packages",
  },
  allowFiles: [
    "apps/server/app/routes.ts",
    "apps/server/app/**/public/**",
    "packages/protocol/**/*.ts",
    "packages/sdk/**/*.ts",
  ],
  allowPackages: [
    "remix",
    "yjs",
    "y-protocols",
    "@synapse/sdk",
    "@tiptap/core",
    "@tiptap/starter-kit",
    "@tiptap/pm",
    "prosemirror-model",
    "prosemirror-state",
    "prosemirror-view",
    "y-prosemirror",
  ],
  denyFiles: [
    "apps/server/app/**/*.test.*",
    "packages/**/*.test.*",
    "**/smoke_*",
  ],
});
