// Standalone offline app-shell check for the kids service worker
// (jellybean#107 P1). NOT part of the default test suite - run manually:
//
//   npm run build:kids
//   node web/kids/scripts/offline-sw-check.mjs
//
// It boots `vite preview` for the built kids app (served under /player/),
// then drives headless Chromium to prove the shell loads with the network
// cut:
//   1. Load online  -> SW installs + precaches the hashed assets, activates
//      (skipWaiting + clientsClaim) and claims the page.
//   2. Reload online -> the NetworkFirst navigation route caches the shell
//      HTML into the `kids-shell` runtime cache.
//   3. context.setOffline(true).
//   4. Reload        -> navigation network fails, SW serves the cached shell,
//      precached JS/CSS boot React.
//   5. Assert the app's own DOM rendered (the `.kid-login` container from
//      Login.tsx), which only exists if React booted - i.e. NOT Chromium's
//      offline error page.
//
// Exit code 0 on success, 1 on failure. Tears down the preview server.

import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { preview } from "vite";
import { chromium } from "@playwright/test";

const __dirname = dirname(fileURLToPath(import.meta.url));
const kidsRoot = resolve(__dirname, "..");

function log(...args) {
    console.log("[offline-sw-check]", ...args);
}

async function main() {
    const server = await preview({
        root: kidsRoot,
        configFile: resolve(kidsRoot, "vite.config.ts"),
        preview: { port: 4180, strictPort: true },
        logLevel: "warn",
    });

    const base = server.resolvedUrls.local[0]; // e.g. http://localhost:4180/player/
    log("preview serving at", base);

    const browser = await chromium.launch();
    const context = await browser.newContext();
    const page = await context.newPage();

    let ok = false;
    let assertion = "";
    try {
        // 1. Online load: install + activate the SW.
        await page.goto(base, { waitUntil: "load" });
        await page.waitForFunction(
            () => navigator.serviceWorker && navigator.serviceWorker.controller !== null,
            null,
            { timeout: 15000 },
        );
        const swScope = await page.evaluate(async () => {
            const reg = await navigator.serviceWorker.ready;
            return reg.scope;
        });
        log("SW active, controller present. scope:", swScope);

        // 2. Online reload so the NetworkFirst nav route caches the shell.
        await page.reload({ waitUntil: "load" });
        // Confirm the shell HTML actually landed in the runtime cache.
        const cachedShell = await page.evaluate(async () => {
            const cache = await caches.open("kids-shell");
            const keys = await cache.keys();
            return keys.map((r) => r.url);
        });
        log("kids-shell cache entries:", cachedShell);

        // 3. Cut the network.
        await context.setOffline(true);
        log("network set offline");

        // 4. Reload offline.
        await page.reload({ waitUntil: "load" });

        // 5. Assert the app shell rendered (React booted), not the browser
        //    offline error page.
        assertion =
            '.kid-login is visible after offline reload (React shell booted from cached HTML + precached assets)';
        await page.waitForSelector(".kid-login", { state: "visible", timeout: 10000 });

        // Extra sanity: the document is our app, and no bundle 404'd.
        const title = await page.title();
        const hasRoot = await page.evaluate(
            () => !!document.getElementById("root") && document.getElementById("root").childElementCount > 0,
        );
        if (title !== "Jellybean Kids" || !hasRoot) {
            throw new Error(
                `shell partial: title=${JSON.stringify(title)} rootHasChildren=${hasRoot}`,
            );
        }
        ok = true;
        log("PASS:", assertion);
        log(`       title=${JSON.stringify(title)} #root has children=${hasRoot}`);
    } catch (err) {
        log("FAIL:", assertion || "(before assertion)");
        log(String(err && err.stack ? err.stack : err));
    } finally {
        await browser.close();
        await new Promise((res) => server.httpServer.close(res));
    }

    process.exit(ok ? 0 : 1);
}

main().catch((err) => {
    console.error(err);
    process.exit(1);
});
