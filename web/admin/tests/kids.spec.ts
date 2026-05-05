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

    test("search box filters server-side via /api/kids/library?search= (M8 #49)", async ({
        page,
    }) => {
        await clearKidsLocalStorage(page);
        const searches: string[] = [];
        await page.route("**/api/kids/library*", (route) => {
            const url = new URL(route.request().url());
            const s = url.searchParams.get("search");
            if (s) searches.push(s);
            route.continue();
        });
        await page.goto(`/kids/library?profileId=1`);
        await expect(page.locator(".tile-grid").first()).toBeVisible({
            timeout: 15_000,
        });
        await page.getByLabel("Search library").fill("scoo");
        // Debounce is 300ms; allow up to a second for the request.
        await page.waitForTimeout(800);
        expect(searches).toContain("scoo");
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

    test("filter switch with both filters cached never shows the loading state", async ({
        page,
        context,
    }) => {
        // Same harness as the cache-render test: drop the admin cookie,
        // seed a fake kid session, and pre-populate IDB. Difference is
        // we seed all four cache entries the Library effect can hit:
        // (Movies, TV) x (all, continue-watching). With every filter
        // cached, clicking between Movies and TV should swap tiles
        // instantly without rendering ".library-state" (the spinner /
        // empty-state text).
        await context.clearCookies();

        const FAKE_USER_ID = "filter-switch-user-id";
        const FAKE_ETAG = 'W/"filter-switch-etag"';
        const MOVIE_TILE = "Filter Switch Movie";
        const TV_TILE = "Filter Switch Series";
        const KEY_MOVIE_ALL = `${FAKE_USER_ID}:all:Movie:24:0:`;
        const KEY_MOVIE_CW = `${FAKE_USER_ID}:continue-watching:Movie:24:0:`;
        const KEY_TV_ALL = `${FAKE_USER_ID}:all:Series:24:0:`;
        const KEY_TV_CW = `${FAKE_USER_ID}:continue-watching:Series:24:0:`;
        // The library defaults to the "Both" filter on first load, so
        // also seed those keys to keep the initial render flicker-free.
        const KEY_BOTH_ALL = `${FAKE_USER_ID}:all:Movie,Series:24:0:`;
        const KEY_BOTH_CW = `${FAKE_USER_ID}:continue-watching:Movie,Series:24:0:`;

        await page.addInitScript(
            ({
                userId,
                etag,
                movieTile,
                tvTile,
                keyMovieAll,
                keyMovieCw,
                keyTvAll,
                keyTvCw,
                keyBothAll,
                keyBothCw,
            }) => {
                if (location.pathname.startsWith("/kids")) {
                    localStorage.setItem("jellybean.kids.token", "fake-bearer-token");
                    localStorage.setItem("jellybean.kids.userId", userId);
                    localStorage.setItem("jellybean.kids.userName", "filter-switch");
                    localStorage.setItem("jellybean.kids.profileId", "1");
                    localStorage.setItem("jellybean.kids.kidName", "Filter Switch Kid");
                    // Force the default filter to "Both" so the first
                    // render uses the Both cache; the test then clicks
                    // Movies and TV in turn.
                    localStorage.setItem("jellybean.kids.typeFilter", "Both");
                }
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
                const moviePage = {
                    Items: [
                        {
                            Id: "filter-switch-movie-id",
                            Name: movieTile,
                            Type: "Movie",
                            ImageTags: {},
                        },
                    ],
                    HasMore: false,
                    NextStartIndex: 1,
                    ProfileId: 1,
                };
                const tvPage = {
                    Items: [
                        {
                            Id: "filter-switch-series-id",
                            Name: tvTile,
                            Type: "Series",
                            ImageTags: {},
                        },
                    ],
                    HasMore: false,
                    NextStartIndex: 1,
                    ProfileId: 1,
                };
                const bothPage = {
                    Items: [
                        ...moviePage.Items,
                        ...tvPage.Items,
                    ],
                    HasMore: false,
                    NextStartIndex: 2,
                    ProfileId: 1,
                };
                const emptyCw = { Items: [], ProfileId: 1 };
                (window as unknown as { __cacheSeed: Promise<void> }).__cacheSeed =
                    Promise.all([
                        seed(keyMovieAll, moviePage),
                        seed(keyMovieCw, emptyCw),
                        seed(keyTvAll, tvPage),
                        seed(keyTvCw, emptyCw),
                        seed(keyBothAll, bothPage),
                        seed(keyBothCw, emptyCw),
                    ]).then(() => undefined);
            },
            {
                userId: FAKE_USER_ID,
                etag: FAKE_ETAG,
                movieTile: MOVIE_TILE,
                tvTile: TV_TILE,
                keyMovieAll: KEY_MOVIE_ALL,
                keyMovieCw: KEY_MOVIE_CW,
                keyTvAll: KEY_TV_ALL,
                keyTvCw: KEY_TV_CW,
                keyBothAll: KEY_BOTH_ALL,
                keyBothCw: KEY_BOTH_CW,
            },
        );

        // First load primes the page so the seed promise can flush.
        await page.goto(KIDS_BASE);
        await page.evaluate(
            () =>
                (window as unknown as { __cacheSeed?: Promise<void> }).__cacheSeed ??
                Promise.resolve(),
        );

        // Block the network for /api/kids/library so the only path that
        // can put tiles on screen is the IDB cache. This makes the test
        // unambiguous: any tile we see came from cache, and any
        // ".library-state" we see is the spinner we're trying to
        // eliminate.
        await page.route("**/api/kids/library**", (route) => route.abort("failed"));

        await page.goto(`${KIDS_BASE}library`);

        // Wait for the initial "Both" render to land. The Both cache
        // contains both tiles, so .tile-grid should be visible.
        await expect(page.locator(".tile-grid").first()).toBeVisible({
            timeout: 5_000,
        });

        const loadingText = page.locator(".library-state");

        // Click TV. The cache hit should swap tiles synchronously; the
        // loading text must never appear during the transition. We poll
        // .library-state across a short window after the click and
        // assert it stayed hidden the whole time.
        const tvTab = page.getByRole("tab", { name: "TV" });
        const sawLoadingDuringTv = pollVisibleEver(loadingText, 250);
        await tvTab.click();
        const tvFlash = await sawLoadingDuringTv;
        expect(tvFlash).toBe(false);
        await expect(page.locator(".tile-grid").first()).toBeVisible();

        // Now click Movies, same assertion.
        const moviesTab = page.getByRole("tab", { name: "Movies" });
        const sawLoadingDuringMovies = pollVisibleEver(loadingText, 250);
        await moviesTab.click();
        const moviesFlash = await sawLoadingDuringMovies;
        expect(moviesFlash).toBe(false);
        await expect(page.locator(".tile-grid").first()).toBeVisible();
    });
});

// pollVisibleEver returns true if the locator becomes visible at any
// point during the polling window. Used to detect transient flashes
// (e.g. a spinner that flickers for a frame between cached renders).
async function pollVisibleEver(
    locator: import("@playwright/test").Locator,
    durationMs: number,
): Promise<boolean> {
    const deadline = Date.now() + durationMs;
    while (Date.now() < deadline) {
        if (await locator.isVisible().catch(() => false)) return true;
        await new Promise((r) => setTimeout(r, 10));
    }
    return false;
}

// Offline fallback (issue #26). Builds on the cache test pattern: pre-seed
// IDB and a kid session, then flip the browser context offline before
// navigating. Cached tiles must render and the offline pill must show.
// When we flip back online, the SPA must auto-retry the library fetch.
test.describe("kids offline", () => {
    test("renders cached tiles + offline pill when offline; auto-retries on reconnect", async ({
        page,
        context,
    }) => {
        await context.clearCookies();

        const FAKE_USER_ID = "offline-test-user-id";
        const FAKE_ETAG = 'W/"offline-test-etag"';
        const CACHE_TILE_NAME = "Offline Cached Tile";
        const CACHE_KEY_ALL = `${FAKE_USER_ID}:all:Movie,Series:24:0:`;
        const CACHE_KEY_CW = `${FAKE_USER_ID}:continue-watching:Movie,Series:24:0:`;

        await page.addInitScript(
            ({ userId, etag, tileName, allKey, cwKey }) => {
                if (location.pathname.startsWith("/kids")) {
                    localStorage.setItem("jellybean.kids.token", "fake-bearer-token");
                    localStorage.setItem("jellybean.kids.userId", userId);
                    localStorage.setItem("jellybean.kids.userName", "offline-test");
                    localStorage.setItem("jellybean.kids.profileId", "1");
                    localStorage.setItem("jellybean.kids.kidName", "Offline Test Kid");
                }
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
                            Id: "offline-test-id-1",
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

        // Seed the cache via a first online visit. addInitScript only
        // queues the seed; we need the page to actually mount once for
        // the seed promise to flush to IDB.
        await page.goto(KIDS_BASE);
        await page.evaluate(
            () =>
                (window as unknown as { __cacheSeed?: Promise<void> }).__cacheSeed ??
                Promise.resolve(),
        );

        // Simulate "API unreachable" by failing /api/kids/* requests at
        // the network layer. We can't use context.setOffline because
        // that also blocks the SPA's own assets and the test framework's
        // navigation, neither of which would be blocked in production
        // (the SPA is already loaded). page.route + abort("failed")
        // makes fetch reject with a TypeError, which is exactly the
        // signal the offline detection looks for.
        await page.route("**/api/kids/**", (route) => route.abort("failed"));
        // Tell the SPA the browser thinks we're offline so the pill
        // renders. The hook listens to window 'offline' / 'online'.
        await page.addInitScript(() => {
            Object.defineProperty(navigator, "onLine", {
                configurable: true,
                get: () => false,
            });
        });

        await page.goto(`${KIDS_BASE}library`);

        const tile = page.locator(".tile-grid").first();
        await tile.waitFor({ state: "visible", timeout: 5_000 });
        await expect(tile.locator(".tile-title")).toHaveText(CACHE_TILE_NAME);

        // Offline pill must be visible.
        await expect(
            page.getByText(/Offline - showing cached library/),
        ).toBeVisible();

        // Reconnect: stop failing API requests, flip navigator.onLine
        // back, and dispatch the online event so the hook re-triggers
        // the load effect.
        await page.unroute("**/api/kids/**");
        const retryReq = page.waitForRequest(
            (req) =>
                req.url().includes("/api/kids/library") &&
                req.method() === "GET" &&
                new URL(req.url()).searchParams.get("section") === "all",
            { timeout: 10_000 },
        );
        await page.evaluate(() => {
            Object.defineProperty(navigator, "onLine", {
                configurable: true,
                get: () => true,
            });
            window.dispatchEvent(new Event("online"));
        });
        await retryReq;
    });

    test("play screen shows 'can't play offline' when /stream is unreachable", async ({
        page,
        context,
    }) => {
        await context.clearCookies();
        await page.addInitScript(() => {
            if (location.pathname.startsWith("/kids")) {
                localStorage.setItem("jellybean.kids.token", "fake-bearer-token");
                localStorage.setItem("jellybean.kids.userId", "offline-play-user");
                localStorage.setItem("jellybean.kids.userName", "offline-play");
                localStorage.setItem("jellybean.kids.profileId", "1");
                localStorage.setItem("jellybean.kids.kidName", "Offline Play Kid");
            }
        });
        // Fail the stream endpoint at the network layer to mimic the
        // browser being offline. Same reasoning as the cache test:
        // context.setOffline blocks page assets too, which doesn't match
        // production behaviour.
        await page.route("**/api/kids/items/**", (route) => route.abort("failed"));

        await page.goto(`${KIDS_BASE}play/some-fake-id`);

        await expect(page.getByRole("heading", { name: /Can't play offline/ })).toBeVisible({
            timeout: 5_000,
        });
        await expect(page.locator("video")).toHaveCount(0);
        await expect(page.getByRole("link", { name: /Back to library/ })).toBeVisible();
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

    test("Esc returns to the watch menu (M7 #44)", async ({ page }) => {
        await clearKidsLocalStorage(page);
        await page.goto(`/kids/library?profileId=1`);
        await page.getByRole("tab", { name: "Movies" }).click();
        const movieTile = page.locator(".tile-grid").first();
        await expect(movieTile).toBeVisible({ timeout: 10_000 });
        await movieTile.click();
        // The library tile may route to /watch (in-progress) or /play
        // (fresh). When it's the latter, Esc lands on the watch
        // interstitial; when it's the former we never enter /play to
        // begin with, so skip that branch.
        const url = page.url();
        if (!/\/kids\/play\//.test(url)) {
            test.skip();
        }
        await page.keyboard.press("Escape");
        await expect(page).toHaveURL(/\/kids\/watch\//);
    });

    test("back button returns to the watch menu (M7 #44)", async ({ page }) => {
        await clearKidsLocalStorage(page);
        await page.goto(`/kids/library?profileId=1`);
        await page.getByRole("tab", { name: "Movies" }).click();
        const movieTile = page.locator(".tile-grid").first();
        await expect(movieTile).toBeVisible({ timeout: 10_000 });
        await movieTile.click();
        const url = page.url();
        if (!/\/kids\/play\//.test(url)) {
            test.skip();
        }
        await page.getByRole("link", { name: /^Back$/ }).first().click();
        await expect(page).toHaveURL(/\/kids\/watch\//);
    });

    test("custom transport mounts and reveals on keypress", async ({ page }) => {
        // Issue #33: replace native <video controls> with a kid-friendly
        // custom transport. Transport stays hidden during the initial
        // buffer state to avoid showing a "Play" button while the video
        // is loading; first user keypress reveals it. Verify it mounts
        // with a scrubber and at least the restart + play/pause buttons.
        await clearKidsLocalStorage(page);
        await page.goto(`/kids/library?profileId=1`);
        await page.getByRole("tab", { name: "Movies" }).click();
        const movieTile = page.locator(".tile-grid").first();
        await expect(movieTile).toBeVisible({ timeout: 10_000 });
        await movieTile.click();
        await expect(page).toHaveURL(/\/kids\/play\//);
        // Transport mounts hidden during the buffer state. Send a key
        // to wake it up.
        const transport = page.locator(".player-transport");
        await expect(transport).toHaveClass(/hidden/);
        await page.keyboard.press("Enter");
        await expect(transport).toHaveClass(/visible/);
        // Scrubber rail exists and is keyboard-focusable.
        await expect(page.locator(".pt-rail")).toBeVisible();
        // At least restart + play/pause buttons exist (movies path).
        await expect(page.locator(".pt-button")).toHaveCount(2, { timeout: 5_000 });
    });
});
