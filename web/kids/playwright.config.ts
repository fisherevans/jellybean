import { defineConfig, devices } from "@playwright/test";

// Backend-free Playwright config for the kids app's durable-cache tests
// (jellybean#107 P1). Unlike web/admin's suite (which hits a live daemon +
// Jellyfin), this spins up a throwaway Vite dev server that serves the IDB
// harness and transforms the real cache module on the fly. Nothing here
// needs the Go server, so it runs in CI or on a laptop with no homelab.
export default defineConfig({
    testDir: "./tests",
    fullyParallel: false,
    workers: 1,
    forbidOnly: !!process.env.CI,
    retries: 0,
    reporter: "list",
    use: {
        baseURL: "http://localhost:5199",
        trace: "retain-on-failure",
    },
    projects: [
        {
            name: "chromium",
            use: { ...devices["Desktop Chrome"] },
        },
    ],
    webServer: {
        command: "npx vite --config tests/harness/vite.config.ts",
        url: "http://localhost:5199/tests/harness/index.html",
        reuseExistingServer: !process.env.CI,
        timeout: 60_000,
    },
});
