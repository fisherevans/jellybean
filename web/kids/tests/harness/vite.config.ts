import { defineConfig } from "vite";
import { resolve } from "node:path";

// Minimal Vite dev server for the offline-cache Playwright harness. Root
// is the kids app dir so the harness html at /tests/harness/index.html can
// import "/src/kidsCache.ts" and Vite transforms the TS on the fly. No PWA
// plugin (we don't want a service worker mediating IndexedDB here) and no
// /player base (keeps the import paths simple). Backend-free: nothing here
// touches /api.
export default defineConfig({
    root: resolve(__dirname, "../.."),
    base: "/",
    server: {
        port: 5199,
        strictPort: true,
    },
});
