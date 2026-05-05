import { test, expect, request } from "@playwright/test";
import { mkdirSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

// Kid overlay rendering. Each test:
//   1. Logs in as the kid (kids/kids1234 in keychain) via
//      /api/kids/auth/login to get a bearer token.
//   2. Seeds localStorage on the page with that token so the kid SPA
//      treats us as signed in.
//   3. Stubs the relevant /api/kids/<status> endpoint via
//      page.route() to force the overlay state we want.
//   4. Loads /player/browse and asserts the overlay is rendered.
//
// We don't drive the real engine state via admin endpoints because
// the lockout / break / mode flips depend on time-of-day and watch
// segments that are awkward to set up in a unit-style smoke test.
// The route stub is good enough to confirm the kid SPA renders the
// right surface for each engine output.

const __filename_local = fileURLToPath(import.meta.url);
const __dirname_local = dirname(__filename_local);
const SHOTS_DIR = resolve(
    __dirname_local,
    "..",
    "..",
    "..",
    ".run",
    "ux-review",
    "kid-overlays",
);
mkdirSync(SHOTS_DIR, { recursive: true });

async function kidLogin(baseURL: string): Promise<{
    token: string;
    userId: string;
    profileId: number;
    kidName?: string;
    profileName?: string;
}> {
    const username = process.env.JELLYBEAN_KID_USERNAME;
    const password = process.env.JELLYBEAN_KID_PASSWORD;
    if (!username || !password) {
        throw new Error(
            "JELLYBEAN_KID_USERNAME / JELLYBEAN_KID_PASSWORD missing. " +
                "scripts/jb e2e injects them from the macOS Keychain.",
        );
    }
    // Fresh context with no cookies - the admin cookie from the
    // Playwright project's storageState would otherwise win the
    // bearer-vs-cookie race on the server.
    const ctx = await request.newContext({ baseURL, storageState: { cookies: [], origins: [] } });
    const res = await ctx.post("/api/kids/auth/login", {
        data: { username, password },
        headers: { "Content-Type": "application/json" },
    });
    expect(res.ok(), `kid login failed: ${res.status()}`).toBeTruthy();
    const body = await res.json();
    await ctx.dispose();
    return body;
}

async function seedKidSession(page, baseURL: string) {
    const session = await kidLogin(baseURL);
    // Clear any admin cookie inherited from auth.setup.ts. The kid
    // backend prefers admin cookie over bearer when both are
    // present; that path requires ?profileId in the query, which
    // the kid SPA doesn't add. Drop the admin cookie so the bearer
    // path is the one that resolves.
    await page.context().clearCookies();
    await page.addInitScript((s) => {
        localStorage.setItem("jellybean.kids.token", s.token);
        localStorage.setItem("jellybean.kids.userId", s.userId);
        localStorage.setItem("jellybean.kids.userName", "kids");
        localStorage.setItem("jellybean.kids.profileId", String(s.profileId));
        if (s.profileName)
            localStorage.setItem("jellybean.kids.profileName", s.profileName);
        if (s.kidName) localStorage.setItem("jellybean.kids.kidName", s.kidName);
    }, session);
    return session;
}

async function stubStatus(
    page,
    path: string,
    body: Record<string, unknown>,
) {
    await page.route(`**/api/kids${path}`, (route) =>
        route.fulfill({
            status: 200,
            contentType: "application/json",
            body: JSON.stringify(body),
        }),
    );
}

test("kid overlay: bedtime lockout renders when auto_off_active", async ({
    page,
    baseURL,
}) => {
    await seedKidSession(page, baseURL!);
    await stubStatus(page, "/viewing-state", {
        dimPercent: 0,
        warmTintPercent: 0,
        autoOffActive: true,
        autoOffReason: "clock",
    });
    await stubStatus(page, "/time-status", { enabled: false, minutesRemaining: 999, locked: false });
    await stubStatus(page, "/body-break-status", { enabled: false, accumulatorMin: 0, playMinutes: 30, breakMinutes: 5, onBreak: false });
    await stubStatus(page, "/active-mode", { source: "none" });

    await page.goto("/player/browse");
    const lockout = page.locator(".kid-lockout");
    await expect(lockout).toBeVisible({ timeout: 10_000 });
    await expect(lockout.locator(".kid-lockout-title")).toContainText("bedtime");
    // The overlay should render readable white text on the dark
    // backdrop. Caught a regression once where the title inherited
    // dark color from the body via cascade.
    const titleColor = await lockout
        .locator(".kid-lockout-title")
        .first()
        .evaluate((el) => getComputedStyle(el).color);
    expect(titleColor).toBe("rgb(255, 255, 255)");
    const filterOnHtml = await page.evaluate(
        () => document.documentElement.style.filter || "",
    );
    expect(filterOnHtml).toBe(""); // no warm tint here
    await page.screenshot({
        path: resolve(SHOTS_DIR, "01-lockout-bedtime.png"),
        fullPage: true,
    });
});

test("kid overlay: time-limit lockout renders when locked", async ({
    page,
    baseURL,
}) => {
    await seedKidSession(page, baseURL!);
    const refill = new Date(Date.now() + 90 * 60 * 1000).toISOString();
    await stubStatus(page, "/viewing-state", {
        dimPercent: 0,
        warmTintPercent: 0,
        autoOffActive: false,
    });
    await stubStatus(page, "/time-status", {
        enabled: true,
        minutesRemaining: 0,
        nextRefillAt: refill,
        locked: true,
    });
    await stubStatus(page, "/body-break-status", { enabled: false, accumulatorMin: 0, playMinutes: 30, breakMinutes: 5, onBreak: false });
    await stubStatus(page, "/active-mode", { source: "none" });

    await page.goto("/player/browse");
    const lockout = page.locator(".kid-lockout");
    await expect(lockout).toBeVisible({ timeout: 10_000 });
    await expect(lockout.locator(".kid-lockout-title")).toContainText(/time/i);
    await page.screenshot({
        path: resolve(SHOTS_DIR, "02-lockout-time-limit.png"),
        fullPage: true,
    });
});

test("kid overlay: sleep timer lockout uses the sleep copy", async ({
    page,
    baseURL,
}) => {
    await seedKidSession(page, baseURL!);
    await stubStatus(page, "/viewing-state", {
        dimPercent: 0,
        warmTintPercent: 0,
        autoOffActive: true,
        autoOffReason: "sleep_timer",
    });
    await stubStatus(page, "/time-status", { enabled: false, minutesRemaining: 999, locked: false });
    await stubStatus(page, "/body-break-status", { enabled: false, accumulatorMin: 0, playMinutes: 30, breakMinutes: 5, onBreak: false });
    await stubStatus(page, "/active-mode", { source: "none" });

    await page.goto("/player/browse");
    const lockout = page.locator(".kid-lockout");
    await expect(lockout).toBeVisible({ timeout: 10_000 });
    await expect(lockout.locator(".kid-lockout-title")).toContainText("asleep");
    await page.screenshot({
        path: resolve(SHOTS_DIR, "03-lockout-sleep-timer.png"),
        fullPage: true,
    });
});

test("kid overlay: warm tint applies a CSS filter to <html>", async ({
    page,
    baseURL,
}) => {
    await seedKidSession(page, baseURL!);
    await stubStatus(page, "/viewing-state", {
        dimPercent: 30,
        warmTintPercent: 100,
        autoOffActive: false,
    });
    await stubStatus(page, "/time-status", { enabled: false, minutesRemaining: 999, locked: false });
    await stubStatus(page, "/body-break-status", { enabled: false, accumulatorMin: 0, playMinutes: 30, breakMinutes: 5, onBreak: false });
    await stubStatus(page, "/active-mode", { source: "none" });

    await page.goto("/player/browse");
    // Wait for the filter to land on <html>.
    await page.waitForFunction(() => {
        const f = document.documentElement.style.filter;
        return f.includes("sepia") && f.includes("hue-rotate");
    }, { timeout: 10_000 });
    const filter = await page.evaluate(() => document.documentElement.style.filter);
    expect(filter).toMatch(/sepia\(/);
    expect(filter).toMatch(/hue-rotate\(/);
    expect(filter).toMatch(/saturate\(/);
    expect(filter).toMatch(/brightness\(/);
    await page.screenshot({
        path: resolve(SHOTS_DIR, "04-warm-tint-applied.png"),
        fullPage: true,
    });
});

test("kid overlay: body break renders countdown + reason while playing", async ({
    page,
    baseURL,
}) => {
    await seedKidSession(page, baseURL!);
    const onBreakUntil = new Date(Date.now() + 4 * 60 * 1000).toISOString();
    await stubStatus(page, "/viewing-state", {
        dimPercent: 0,
        warmTintPercent: 0,
        autoOffActive: false,
    });
    await stubStatus(page, "/time-status", { enabled: false, minutesRemaining: 999, locked: false });
    await stubStatus(page, "/body-break-status", {
        enabled: true,
        accumulatorMin: 30,
        playMinutes: 30,
        breakMinutes: 5,
        onBreak: true,
        onBreakUntil,
        onBreakReason: "Stand up and stretch.",
    });
    await stubStatus(page, "/active-mode", { source: "none" });

    // body-break only fires while activelyPlaying, so we have to
    // navigate to /play. We don't actually play a real video — the
    // route stubs prevent network activity. The Play page may show
    // a loading state but the overlay should render on top.
    await page.goto("/player/play/abc123");
    const overlay = page.locator(".kid-bodybreak");
    await expect(overlay).toBeVisible({ timeout: 12_000 });
    await expect(overlay.locator(".kid-bodybreak-reason")).toContainText("stretch");
    await expect(overlay.locator(".kid-bodybreak-countdown")).toBeVisible();
    await page.screenshot({
        path: resolve(SHOTS_DIR, "05-body-break.png"),
        fullPage: true,
    });
});

test("kid overlay: active mode flips body data-theme", async ({
    page,
    baseURL,
}) => {
    await seedKidSession(page, baseURL!);
    await stubStatus(page, "/viewing-state", {
        dimPercent: 0,
        warmTintPercent: 0,
        autoOffActive: false,
    });
    await stubStatus(page, "/time-status", { enabled: false, minutesRemaining: 999, locked: false });
    await stubStatus(page, "/body-break-status", { enabled: false, accumulatorMin: 0, playMinutes: 30, breakMinutes: 5, onBreak: false });
    await stubStatus(page, "/active-mode", {
        source: "schedule",
        mode: {
            id: 1,
            name: "Bedtime",
            themeKey: "bedtime",
        },
    });

    await page.goto("/player/browse");
    await page.waitForFunction(
        () => document.body.dataset.theme === "bedtime",
        { timeout: 10_000 },
    );
    expect(await page.evaluate(() => document.body.dataset.theme)).toBe("bedtime");
});

test("kid: watch menu + play screen render for a real item", async ({
    page,
    baseURL,
}) => {
    const session = await seedKidSession(page, baseURL!);
    // Pull the first visible item from the kid library so we have a
    // real id to navigate to. No stubs - this exercises the actual
    // /api/kids/items endpoint + the Watch / Play page mounts.
    // Fresh context with no cookies - the admin cookie from the
    // Playwright project's storageState would otherwise win the
    // bearer-vs-cookie race on the server.
    const ctx = await request.newContext({ baseURL, storageState: { cookies: [], origins: [] } });
    const lib = await ctx.get("/api/kids/library", {
        headers: {
            Authorization: `Bearer ${session.token}`,
            "X-Jellyfin-User-Id": session.userId,
            "X-Jellybean-DeviceId": "test-device",
        },
    });
    expect(lib.ok(), `library fetch failed: ${lib.status()} ${await lib.text()}`).toBeTruthy();
    const body = await lib.json();
    const firstId = body.Items?.[0]?.Id ?? body.items?.[0]?.Id;
    await ctx.dispose();
    if (!firstId) {
        // No visible items in the test profile - skip rather than
        // fail. Smoke test is a "renders cleanly" check; with no
        // items the library is empty and the watch page can't run.
        return;
    }

    await page.goto(`/player/watch/${encodeURIComponent(firstId)}`);
    await page.waitForSelector(".watch-screen, .watch-hero", {
        timeout: 15_000,
    });
    await expect(page.locator(".watch-hero")).toBeVisible();
    await page.screenshot({
        path: resolve(SHOTS_DIR, "10-watch-menu.png"),
        fullPage: true,
    });

    await page.goto(`/player/play/${encodeURIComponent(firstId)}`);
    // Don't wait for video to load (Jellyfin transcode lag varies);
    // just confirm the page mounted a <video> element.
    await page.waitForSelector("video", { timeout: 15_000 });
    await page.screenshot({
        path: resolve(SHOTS_DIR, "11-play-screen.png"),
        fullPage: true,
    });
});

test("kid: watch menu renders the episode accordion for a series", async ({
    page,
    baseURL,
}) => {
    const session = await seedKidSession(page, baseURL!);
    const ctx = await request.newContext({ baseURL, storageState: { cookies: [], origins: [] } });
    const lib = await ctx.get("/api/kids/library?type=Series&limit=10", {
        headers: {
            Authorization: `Bearer ${session.token}`,
            "X-Jellyfin-User-Id": session.userId,
            "X-Jellybean-DeviceId": "test-device",
        },
    });
    if (!lib.ok()) {
        await ctx.dispose();
        return;
    }
    const body = await lib.json();
    const seriesId = body.Items?.[0]?.Id;
    await ctx.dispose();
    if (!seriesId) return;

    await page.goto(`/player/watch/${encodeURIComponent(seriesId)}`);
    await page.waitForSelector(".watch-screen", { timeout: 15_000 });
    // Series get the accordion below the hero. Wait for at least
    // one season header to appear.
    await expect(page.locator(".watch-season-head").first()).toBeVisible({
        timeout: 10_000,
    });
    await page.screenshot({
        path: resolve(SHOTS_DIR, "12-watch-series.png"),
        fullPage: true,
    });
});

test("kid overlay: no overlays render when nothing is firing", async ({
    page,
    baseURL,
}) => {
    await seedKidSession(page, baseURL!);
    await stubStatus(page, "/viewing-state", {
        dimPercent: 0,
        warmTintPercent: 0,
        autoOffActive: false,
    });
    await stubStatus(page, "/time-status", { enabled: false, minutesRemaining: 999, locked: false });
    await stubStatus(page, "/body-break-status", { enabled: false, accumulatorMin: 0, playMinutes: 30, breakMinutes: 5, onBreak: false });
    await stubStatus(page, "/active-mode", { source: "none" });

    await page.goto("/player/browse");
    await page.waitForLoadState("networkidle");
    expect(await page.locator(".kid-lockout").count()).toBe(0);
    expect(await page.locator(".kid-bodybreak").count()).toBe(0);
});
