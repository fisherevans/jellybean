import { test, expect } from "@playwright/test";

// End-to-end checks for the kids client's profile picker + deviceId
// scaffolding (#19). Reuses the admin storageState (which authenticates
// kids endpoints too) and runs each test in a fresh context so localStorage
// state from one test doesn't bleed into another.

const KIDS_BASE = "/kids/";

async function clearKidsLocalStorage(page: import("@playwright/test").Page) {
    // Visit the kids origin first so localStorage is scoped right.
    await page.goto(KIDS_BASE);
    await page.evaluate(() => {
        localStorage.removeItem("jellybean.kids.profiles");
        localStorage.removeItem("jellybean.kids.activeKey");
        localStorage.removeItem("jellybean.kids.deviceId");
        localStorage.removeItem("jellybean.kids.key");
    });
}

test.describe("kids picker", () => {
    test("zero profiles + admin: shows admin preview with profiles list", async ({ page }) => {
        await clearKidsLocalStorage(page);
        await page.goto(KIDS_BASE);
        await expect(
            page.getByRole("heading", { name: /Kids client preview/ }),
        ).toBeVisible();
        // Server-side Default profile is the test invariant.
        await expect(page.getByRole("link", { name: /Default/ })).toBeVisible();
    });

    test("one profile auto-selects and routes to /library", async ({ page }) => {
        await clearKidsLocalStorage(page);
        await page.evaluate(() => {
            localStorage.setItem(
                "jellybean.kids.profiles",
                JSON.stringify([{ name: "TestKid", apiKey: "fake-key-only-for-routing" }]),
            );
        });
        await page.goto(KIDS_BASE);
        // Library page renders. Even if the API rejects the fake key, the
        // route + heading should show up. Admin cookie carries us past the
        // 401 anyway, so we expect a real heading.
        await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
        await expect(page).toHaveURL(/\/kids\/library/);
    });

    test("two profiles: shows picker with both tiles", async ({ page }) => {
        await clearKidsLocalStorage(page);
        await page.evaluate(() => {
            localStorage.setItem(
                "jellybean.kids.profiles",
                JSON.stringify([
                    { name: "Dex", apiKey: "key-dex" },
                    { name: "Zoey", apiKey: "key-zoey" },
                ]),
            );
        });
        await page.goto(KIDS_BASE);
        await expect(page.getByRole("heading", { name: /Who's watching/ })).toBeVisible();
        await expect(page.getByRole("button", { name: /Dex/ })).toBeVisible();
        await expect(page.getByRole("button", { name: /Zoey/ })).toBeVisible();
    });

    test("/setup query-param shortcut appends a profile and redirects", async ({ page }) => {
        await clearKidsLocalStorage(page);
        await page.goto("/kids/setup?key=qp-key&name=QPKid");
        // Single profile after redirect should auto-route to library.
        await expect(page).toHaveURL(/\/kids\/library/);
        const stored = await page.evaluate(() =>
            localStorage.getItem("jellybean.kids.profiles"),
        );
        expect(stored).toBeTruthy();
        const parsed = JSON.parse(stored!);
        expect(parsed).toEqual([{ name: "QPKid", apiKey: "qp-key" }]);
    });

    test("deviceId is generated lazily and sent on /api/kids/library", async ({ page }) => {
        await clearKidsLocalStorage(page);
        await page.evaluate(() => {
            localStorage.setItem(
                "jellybean.kids.profiles",
                JSON.stringify([{ name: "TestKid", apiKey: "test-key" }]),
            );
        });

        const seen: string[] = [];
        page.on("request", (req) => {
            const id = req.headers()["x-jellybean-deviceid"];
            if (id && req.url().includes("/api/kids/")) seen.push(id);
        });

        await page.goto(KIDS_BASE);
        // Wait for at least one /api/kids/library call.
        await page.waitForRequest(
            (req) => req.url().includes("/api/kids/library"),
            { timeout: 10_000 },
        );
        // Storage now has a deviceId.
        const stored = await page.evaluate(() =>
            localStorage.getItem("jellybean.kids.deviceId"),
        );
        expect(stored).toMatch(
            /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
        );
        expect(seen.length).toBeGreaterThan(0);
        expect(seen[0]).toBe(stored);
    });

    test("manual setup form adds a profile and updates the count", async ({ page }) => {
        await clearKidsLocalStorage(page);
        await page.goto("/kids/setup");
        await page.getByRole("heading", { name: /Add kid profile/ }).waitFor();
        // Two label inputs in order: Display name, Kid API key.
        const inputs = page.locator(".setup label input");
        await inputs.nth(0).fill("Manual");
        await inputs.nth(1).fill("manual-key");
        await page.getByRole("button", { name: "Add profile" }).click();
        await expect(page.getByText(/1 profile configured/)).toBeVisible();
        const stored = await page.evaluate(() =>
            localStorage.getItem("jellybean.kids.profiles"),
        );
        expect(JSON.parse(stored!)).toEqual([
            { name: "Manual", apiKey: "manual-key" },
        ]);
    });
});

// Library / browse grid (#20). Uses the admin preview path (?profileId=N)
// against the test-invariant Default profile.
async function gotoLibrary(page: import("@playwright/test").Page, profileId: number) {
    await clearKidsLocalStorage(page);
    await page.goto(`/kids/library?profileId=${profileId}`);
    await expect(page.getByRole("tablist")).toBeVisible();
}

test.describe("kids library", () => {
    test("renders the type filter, defaulted to Both", async ({ page }) => {
        await gotoLibrary(page, 4);
        const tabs = page.getByRole("tab");
        await expect(tabs).toHaveCount(3);
        await expect(tabs.nth(0)).toHaveText("Both");
        await expect(tabs.nth(0)).toHaveClass(/active/);
    });

    test("clicking a filter pill swaps the type query param", async ({ page }) => {
        await gotoLibrary(page, 4);
        // Wait for the initial fetch to finish so a click triggers a fresh
        // request we can observe.
        await page.locator(".tile-grid, .library-state").first().waitFor();
        const moviesReq = page.waitForRequest((req) => {
            const url = req.url();
            return url.includes("/api/kids/library") && url.includes("type=Movie") &&
                !url.includes("type=Movie%2CSeries");
        });
        await page.getByRole("tab", { name: "Movies" }).click();
        await moviesReq;
    });

    test("library tiles render and clicking one navigates to /play", async ({ page }) => {
        await gotoLibrary(page, 4);
        // Wait for at least one tile to render. Server returns visible items
        // for profile 4; if empty the test data is misconfigured.
        const firstTile = page.locator(".tile-grid").first();
        await expect(firstTile).toBeVisible({ timeout: 10_000 });
        await firstTile.click();
        await expect(page).toHaveURL(/\/kids\/play\//);
    });

    test("D-pad: ArrowDown from filter focuses a tile, Enter activates it", async ({ page }) => {
        await gotoLibrary(page, 4);
        // Wait for the grid to load.
        await page.locator(".tile-grid").first().waitFor({ state: "visible" });
        // Focus the active filter pill, then ArrowDown.
        await page.getByRole("tab", { name: "Both" }).focus();
        await page.keyboard.press("ArrowDown");
        // Some tile (cw or grid) should now have .focused.
        await expect(page.locator(".tile.focused")).toHaveCount(1);
        await page.keyboard.press("Enter");
        await expect(page).toHaveURL(/\/kids\/play\//);
    });

    test("Series tiles get a TV badge when present", async ({ page }) => {
        await gotoLibrary(page, 4);
        await page.locator(".tile-grid, .library-state").first().waitFor();
        const seriesReq = page.waitForRequest((req) =>
            req.url().includes("/api/kids/library") && req.url().includes("type=Series"),
        );
        await page.getByRole("tab", { name: "TV" }).click();
        await seriesReq;
        const firstTile = page.locator(".tile-grid").first();
        await expect(firstTile).toBeVisible({ timeout: 10_000 });
        await expect(firstTile.locator(".tile-badge")).toBeVisible();
    });
});

// Playback (#21). Admin path (no kid token) so the server-side report
// short-circuits and Jellyfin's session view stays clean. We're verifying
// the client-side wiring, not real Jellyfin attribution.
test.describe("kids playback", () => {
    test("movie: stream endpoint resolves and player mounts with HLS source", async ({ page }) => {
        // Headless Chromium can't natively play HLS manifests, so the
        // browser-driven onPlay -> /playback/start chain is verified in Go
        // unit tests instead. Here we confirm the navigation, the stream
        // resolve call, and the video element wiring.
        await clearKidsLocalStorage(page);
        await page.goto(`/kids/library?profileId=4`);
        await page.getByRole("tab", { name: "Movies" }).click();
        const movieTile = page.locator(".tile-grid").first();
        await expect(movieTile).toBeVisible({ timeout: 10_000 });

        const streamReq = page.waitForRequest((req) =>
            req.url().includes("/api/kids/items/") && req.url().includes("/stream"),
        );
        await movieTile.click();
        await streamReq;
        await expect(page).toHaveURL(/\/kids\/play\//);
        const video = page.locator("video");
        await expect(video).toBeVisible();
    });

    test("Esc returns to library", async ({ page }) => {
        await clearKidsLocalStorage(page);
        await page.goto(`/kids/library?profileId=4`);
        await page.getByRole("tab", { name: "Movies" }).click();
        const movieTile = page.locator(".tile-grid").first();
        await expect(movieTile).toBeVisible({ timeout: 10_000 });
        await movieTile.click();
        await expect(page).toHaveURL(/\/kids\/play\//);
        await page.keyboard.press("Escape");
        await expect(page).toHaveURL(/\/kids\/library/);
    });

    test("back button returns to library", async ({ page }) => {
        await clearKidsLocalStorage(page);
        await page.goto(`/kids/library?profileId=4`);
        await page.getByRole("tab", { name: "Movies" }).click();
        const movieTile = page.locator(".tile-grid").first();
        await expect(movieTile).toBeVisible({ timeout: 10_000 });
        await movieTile.click();
        await expect(page).toHaveURL(/\/kids\/play\//);
        await page.getByRole("link", { name: /Back to library/ }).click();
        await expect(page).toHaveURL(/\/kids\/library/);
    });
});
