import { test as setup, expect, request } from "@playwright/test";
import { writeFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// Logs in via /api/auth/login using JELLYFIN_USERNAME / JELLYFIN_PASSWORD
// from the environment (scripts/jb e2e injects these from the macOS
// Keychain so the values never appear in chat). Captures the session
// cookie and writes a Playwright storageState file the test project
// loads via storageState in playwright.config.ts.
//
// Running tests without these env vars fails fast with a clear message.

const __filename_local = fileURLToPath(import.meta.url);
const __dirname_local = dirname(__filename_local);
const STATE_FILE = resolve(__dirname_local, "..", "..", "..", ".run", "playwright-state.json");

setup("authenticate", async ({ baseURL }) => {
    const username = process.env.JELLYFIN_USERNAME;
    const password = process.env.JELLYFIN_PASSWORD;
    if (!username || !password) {
        throw new Error(
            "JELLYFIN_USERNAME and JELLYFIN_PASSWORD env vars required. " +
                "Run via scripts/jb e2e to source them from the macOS Keychain.",
        );
    }
    const ctx = await request.newContext({ baseURL });
    const res = await ctx.post("/api/auth/login", {
        data: { username, password },
        headers: { "Content-Type": "application/json" },
    });
    expect(res.ok(), `login failed: ${res.status()} ${await res.text()}`).toBeTruthy();

    // Verify the session works.
    const me = await ctx.get("/api/auth/me");
    expect(me.ok()).toBeTruthy();

    const state = await ctx.storageState();
    mkdirSync(dirname(STATE_FILE), { recursive: true });
    writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
});
