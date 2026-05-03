import { defineConfig, devices } from "@playwright/test";

// Hits the running daemon at JB_BASE_URL (default localhost:8765 to match
// scripts/jb's default port). The "auth setup" project runs first and writes
// a storageState file to .run/playwright-state.json so the actual test
// projects can skip the login screen.

const baseURL = process.env.JB_BASE_URL ?? "http://127.0.0.1:8765";

export default defineConfig({
    testDir: "./tests",
    fullyParallel: false, // we share one daemon + one DB
    workers: 1,
    forbidOnly: !!process.env.CI,
    retries: 0,
    reporter: process.env.CI ? "list" : "list",
    use: {
        baseURL,
        trace: "retain-on-failure",
        screenshot: "only-on-failure",
        video: "retain-on-failure",
    },
    projects: [
        {
            name: "setup",
            testMatch: /auth\.setup\.ts/,
        },
        {
            name: "chromium",
            use: {
                ...devices["Desktop Chrome"],
                storageState: "../../.run/playwright-state.json",
            },
            dependencies: ["setup"],
        },
    ],
});
