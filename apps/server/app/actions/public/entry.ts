import {
  detectMultipleImportMapSupport,
  importModule,
  preloadShim,
} from "remix/multiple-import-maps-polyfill";
import { run } from "remix/component";

const app = run({
  async loadModule(moduleUrl, exportName) {
    const module = await importModule(moduleUrl);
    const Component = module[exportName];
    if (typeof Component !== "function") {
      throw new Error(`Unknown component: ${moduleUrl}#${exportName}`);
    }
    return Component;
  },
  async processClientEntryPreloads(preloads) {
    if (await detectMultipleImportMapSupport()) return preloads;

    preloadShim(preloads);
    return [];
  },
});

app.addEventListener("error", (event) => {
  console.error("Component error:", event.error);
});

await app.ready();
