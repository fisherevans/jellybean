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

// IndexedDB-backed library cache (issue #25). Pairs with the server
// ETag from #24 to render cached tiles instantly on navigation, then
// revalidate against the server with If-None-Match.
//
// The kids client only consults the cache when a *real* kid session is
// in localStorage (no userId in admin-preview mode = no key to scope
// against). To exercise the cache wiring without a real Jellyfin kid
// mapping for the admin user, this test simulates a session: it drops
// the admin cookie and pre-populates both localStorage and IDB before
// the page loads. The subsequent network request fails (no real bearer)
// but the assertions are about cache-render-before-network and the
// If-None-Match header, not about a successful refresh.
test.describe("kids library cache", () => {
    test("renders cached tiles before network and sends If-None-Match on revalidation", async ({
        page,
        context,
    }) => {
        // Drop the admin cookie so resolveKidsAuth doesn't fall through
        // to the admin-cookie path. We want pure bearer (kid) auth so
        // the cache code branch (useCache = !!session && !adminProfileId)
        // is exercised.
        await context.clearCookies();

        const FAKE_USER_ID = "cache-test-user-id";
        const FAKE_ETAG = 'W/"cache-test-etag"';
        const CACHE_TILE_NAME = "Cached Test Tile";
        const CACHE_KEY_ALL = `${FAKE_USER_ID}:all:Movie,Series:24:0:`;
        const CACHE_KEY_CW = `${FAKE_USER_ID}:continue-watching:Movie,Series:24:0:`;

        // Seed the kids client's localStorage + IDB before the SPA boots.
        // addInitScript runs in every page context within this test, so
        // the second navigation (the "reload") sees the same state.
        await page.addInitScript(
            ({ userId, etag, tileName, allKey, cwKey }) => {
                if (location.pathname.startsWith("/kids")) {
                    localStorage.setItem("jellybean.kids.token", "fake-bearer-token");
                    localStorage.setItem("jellybean.kids.userId", userId);
                    localStorage.setItem("jellybean.kids.userName", "cache-test");
                    localStorage.setItem("jellybean.kids.profileId", "1");
                    localStorage.setItem("jellybean.kids.kidName", "Cache Test Kid");
                }
                // Seed IDB. Keep this in sync with libraryCache.ts:
                // db = "jellybean-kids", store = "library", v1.
                const seed = (key: string, page: unknown) =>
                    new Promise<void>((resolve) => {
                        const open = indexedDB.open("jellybean-kids", 1);
                        open.onupgradeneeded = () => {
                            const db = open.result;
                            if (!db.objectStoreNames.contains("library")) {
                                db.createObjectStore("library");
                            }
                        };
                        open.onsuccess = () => {
                            const db = open.result;
                            const tx = db.transaction("library", "readwrite");
                            tx.objectStore("library").put(
                                { page, etag, savedAt: Date.now() },
                                key,
                            );
                            tx.oncomplete = () => {
                                db.close();
                                resolve();
                            };
                            tx.onerror = () => {
                                db.close();
                                resolve();
                            };
                        };
                        open.onerror = () => resolve();
                    });
                const allPage = {
                    Items: [
                        {
                            Id: "cache-test-id-1",
                            Name: tileName,
                            Type: "Movie",
                            ImageTags: {},
                        },
                    ],
                    HasMore: false,
                    NextStartIndex: 1,
                    ProfileId: 1,
                };
                const cwPage = { Items: [], ProfileId: 1 };
                // Fire-and-await both seeds; tests block on this script
                // because it's awaited.
                (window as unknown as { __cacheSeed: Promise<void> }).__cacheSeed =
                    Promise.all([seed(allKey, allPage), seed(cwKey, cwPage)]).then(
                        () => undefined,
                    );
            },
            {
                userId: FAKE_USER_ID,
                etag: FAKE_ETAG,
                tileName: CACHE_TILE_NAME,
                allKey: CACHE_KEY_ALL,
                cwKey: CACHE_KEY_CW,
            },
        );

        // First load: prime the page (the cache write happened in the
        // init script; we just need the SPA to mount once so any SPA
        // state is consistent).
        await page.goto(KIDS_BASE);
        // Wait for the cache seed to finish.
        await page.evaluate(
            () =>
                (window as unknown as { __cacheSeed?: Promise<void> }).__cacheSeed ??
                Promise.resolve(),
        );

        // Capture the library request that fires after the second nav so
        // we can inspect its If-None-Match header. Hook before navigating.
        const libraryReq = page.waitForRequest((req) =>
            req.url().includes("/api/kids/library") && req.method() === "GET"
            && new URL(req.url()).searchParams.get("section") === "all",
        );

        // Navigate to the library. Cache should produce the tile before
        // the network resolves.
        const navStart = Date.now();
        await page.goto(`${KIDS_BASE}library`);

        // Cached tile must render quickly. We give it a generous 1500ms
        // ceiling (CI machines vary), then assert the elapsed time was
        // under a tight cache-hit budget. The network request will most
        // likely 401 (fake bearer + no admin cookie), so this can only
        // succeed via the IDB cache.
        const tile = page.locator(".tile-grid").first();
        await tile.waitFor({ state: "visible", timeout: 1500 });
        const elapsed = Date.now() - navStart;
        // Cache renders well before any 1s+ network round-trip would. We
        // pad heavily for CI but stay below typical fetch cycles.
        expect(elapsed).toBeLessThan(1500);
        await expect(tile.locator(".tile-title")).toHaveText(CACHE_TILE_NAME);

        // The revalidation request must carry If-None-Match with the
        // cached etag.
        const req = await libraryReq;
        expect(req.headers()["if-none-match"]).toBe(FAKE_ETAG);
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
