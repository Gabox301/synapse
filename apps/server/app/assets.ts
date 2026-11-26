import { createAssetServer } from "remix/assets";
import { dirname, resolve } from "node:path";

// Raíz del repo (este archivo vive en apps/server/app/: app -> server -> apps -> root).
const rootDir = resolve(import.meta.dirname!, "..", "..", "..");

export const assets = createAssetServer({
  basePath: "/assets",
  rootDir,
  mounts: {
    app: "apps/server/app",
    npm: "apps/server/node_modules",
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
    "@tiptap/core",
    "@tiptap/starter-kit",
    "y-prosemirror",
  ],
  denyFiles: [
    "apps/server/app/**/*.test.*",
    "packages/**/*.test.*",
    "**/smoke_*",
  ],
});
