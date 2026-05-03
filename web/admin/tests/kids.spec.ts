import { test, expect } from "@playwright/test";

// End-to-end checks for the kids client. The auth model is now
// "Jellyfin username + password on the device" (see docs/auth-pivot-plan.md);
// the old API-key picker / setup flow is gone. These tests:
//
//   - Cover the new login screen happy path.
//   - Reuse the admin-preview path (?profileId=N + admin cookie) for the
//     library + playback checks, since that path doesn't depend on a kid
//     mapping existing for the test fixture's admin user.
//
// All tests run with the admin storageState so admin-cookie-authed kids
// endpoints work. We clear kids localStorage between tests so login state
// doesn't bleed across cases.

const KIDS_BASE = "/kids/";

async function clearKidsLocalStorage(page: import("@playwright/test").Page) {
    // Visit the kids origin first so localStorage is scoped right.
    await page.goto(KIDS_BASE);
    await page.evaluate(() => {
        for (const k of Object.keys(localStorage)) {
            if (k.startsWith("jellybean.kids.")) localStorage.removeItem(k);
        }
    });
}

test.describe("kids login", () => {
    test("/kids redirects to /kids/login when not signed in", async ({ page }) => {
        await clearKidsLocalStorage(page);
        await page.goto(KIDS_BASE);
        await expect(page).toHaveURL(/\/kids\/login$/);
        await expect(page.getByRole("heading", { name: /Sign in/ })).toBeVisible();
    });

    test("login form: invalid credentials show an error", async ({ page }) => {
        await clearKidsLocalStorage(page);
        await page.goto("/kids/login");
        await page.getByLabel("Username").fill("definitely-not-a-real-user");
        await page.getByLabel("Password").fill("definitely-not-a-real-password");
        await page.getByRole("button", { name: /Sign in/ }).click();
        // Backend responds 401, login screen shows the error message.
        await expect(page.getByText(/Wrong username or password/)).toBeVisible({
            timeout: 10_000,
        });
    });

    test("login form: valid creds either land on /library or 403 if not mapped", async ({
        page,
    }) => {
        const username = process.env.JELLYFIN_USERNAME;
        const password = process.env.JELLYFIN_PASSWORD;
        test.skip(
            !username || !password,
            "JELLYFIN_USERNAME / JELLYFIN_PASSWORD env vars required",
        );
        await clearKidsLocalStorage(page);
        await page.goto("/kids/login");
        await page.getByLabel("Username").fill(username!);
        await page.getByLabel("Password").fill(password!);
        await page.getByRole("button", { name: /Sign in/ }).click();

        // Two acceptable outcomes:
        //   - The admin user is mapped to a kid: we land on /library.
        //   - It isn't (more likely with the test fixture): the form shows
        //     the "ask a parent" message.
        // Wait until either condition is true.
        await expect(async () => {
            const url = page.url();
            if (/\/kids\/library/.test(url)) return;
            await expect(
                page.getByText(/isn't set up as a kid/),
            ).toBeVisible();
        }).toPass({ timeout: 10_000 });
    });
});

// Library / browse grid. Uses the admin preview path (?profileId=N)
// against the test-invariant Default profile so we don't need a kid
// mapping for the admin user.
async function gotoLibrary(page: import("@playwright/test").Page, profileId: number) {
    await clearKidsLocalStorage(page);
    await page.goto(`/kids/library?profileId=${profileId}`);
    await expect(page.getByRole("tablist")).toBeVisible();
}

test.describe("kids library", () => {
    test("renders the type filter, defaulted to Both", async ({ page }) => {
        await gotoLibrary(page, 1);
        const tabs = page.getByRole("tab");
        await expect(tabs).toHaveCount(3);
        await expect(tabs.nth(0)).toHaveText("Both");
        await expect(tabs.nth(0)).toHaveClass(/active/);
    });

    test("clicking a filter pill swaps the type query param", async ({ page }) => {
        await gotoLibrary(page, 1);
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
        await gotoLibrary(page, 1);
        // Wait for at least one tile to render. Server returns visible items
        // for the Default profile; if empty the test data is misconfigured.
        const firstTile = page.locator(".tile-grid").first();
        await expect(firstTile).toBeVisible({ timeout: 10_000 });
        await firstTile.click();
        await expect(page).toHaveURL(/\/kids\/play\//);
    });

    test("D-pad: ArrowDown from filter focuses a tile, Enter activates it", async ({ page }) => {
        await gotoLibrary(page, 1);
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
        await gotoLibrary(page, 1);
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

    test("deviceId is generated lazily and sent on /api/kids/library", async ({ page }) => {
        await clearKidsLocalStorage(page);
        const seen: string[] = [];
        page.on("request", (req) => {
            const id = req.headers()["x-jellybean-deviceid"];
            if (id && req.url().includes("/api/kids/")) seen.push(id);
        });

        await page.goto(`/kids/library?profileId=1`);
        await page.waitForRequest(
            (req) => req.url().includes("/api/kids/library"),
            { timeout: 10_000 },
        );
        const stored = await page.evaluate(() =>
            localStorage.getItem("jellybean.kids.deviceId"),
        );
        expect(stored).toMatch(
            /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
        );
        expect(seen.length).toBeGreaterThan(0);
        expect(seen[0]).toBe(stored);
    });
});

// Playback. Admin path (no kid token) so the server-side report
// short-circuits and Jellyfin's session view stays clean. We're verifying
// the client-side wiring, not real Jellyfin attribution.
test.describe("kids playback", () => {
    test("movie: stream endpoint resolves and player mounts with HLS source", async ({ page }) => {
        // Headless Chromium can't natively play HLS manifests, so the
        // browser-driven onPlay -> /playback/start chain is verified in Go
        // unit tests instead. Here we confirm the navigation, the stream
        // resolve call, and the video element wiring.
        await clearKidsLocalStorage(page);
        await page.goto(`/kids/library?profileId=1`);
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
        await page.goto(`/kids/library?profileId=1`);
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
        await page.goto(`/kids/library?profileId=1`);
        await page.getByRole("tab", { name: "Movies" }).click();
        const movieTile = page.locator(".tile-grid").first();
        await expect(movieTile).toBeVisible({ timeout: 10_000 });
        await movieTile.click();
        await expect(page).toHaveURL(/\/kids\/play\//);
        await page.getByRole("link", { name: /Back to library/ }).click();
        await expect(page).toHaveURL(/\/kids\/library/);
    });
});
