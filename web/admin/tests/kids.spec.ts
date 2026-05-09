import { test, expect, type Page } from "@playwright/test";

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

const KIDS_BASE = "/player/";

async function clearKidsLocalStorage(page: import("@playwright/test").Page) {
    // Visit the kids origin first so localStorage is scoped right.
    await page.goto(KIDS_BASE);
    await page.evaluate(() => {
        for (const k of Object.keys(localStorage)) {
            if (k.startsWith("jellybean.kids.")) localStorage.removeItem(k);
        }
    });
}

// Force the password mode so legacy username+password tests can
// reach the form without first clicking past the QC card. Routes
// /quickconnect/enabled to return false; the login screen settles
// directly on the password view.
async function forcePasswordMode(page: Page) {
    await page.route(
        "**/api/kids/auth/quickconnect/enabled",
        async (route) =>
            await route.fulfill({
                status: 200,
                contentType: "application/json",
                body: JSON.stringify({ enabled: false }),
            }),
    );
}

test.describe("kids login", () => {
    test("/kids redirects to /player/login when not signed in", async ({ page }) => {
        await clearKidsLocalStorage(page);
        await forcePasswordMode(page);
        await page.goto(KIDS_BASE);
        await expect(page).toHaveURL(/\/player\/login$/);
        await expect(page.getByRole("heading", { name: /Sign in/ })).toBeVisible();
    });

    test("login form: invalid credentials show an error", async ({ page }) => {
        await clearKidsLocalStorage(page);
        await forcePasswordMode(page);
        await page.goto("/player/login");
        await page.getByLabel("Username").fill("definitely-not-a-real-user");
        await page.getByLabel("Password").fill("definitely-not-a-real-password");
        await page.getByRole("button", { name: /^Sign in$/ }).click();
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
        await forcePasswordMode(page);
        await page.goto("/player/login");
        await page.getByLabel("Username").fill(username!);
        await page.getByLabel("Password").fill(password!);
        await page.getByRole("button", { name: /^Sign in$/ }).click();

        // Two acceptable outcomes:
        //   - The admin user is mapped to a kid: we land on /library.
        //   - It isn't (more likely with the test fixture): the form shows
        //     the "ask a parent" message.
        // Wait until either condition is true.
        await expect(async () => {
            const url = page.url();
            if (/\/player\/library/.test(url)) return;
            await expect(
                page.getByText(/isn't set up as a kid/),
            ).toBeVisible();
        }).toPass({ timeout: 10_000 });
    });

    test("Quick Connect mode: shows code, then flips to password on link", async ({
        page,
    }) => {
        await clearKidsLocalStorage(page);
        // Stub the three QC endpoints so we exercise the login UI
        // deterministically without depending on the upstream
        // Jellyfin's QC state (which an admin can flip at any time).
        await page.route(
            "**/api/kids/auth/quickconnect/enabled",
            async (route) =>
                await route.fulfill({
                    status: 200,
                    contentType: "application/json",
                    body: JSON.stringify({ enabled: true }),
                }),
        );
        await page.route(
            "**/api/kids/auth/quickconnect/start",
            async (route) =>
                await route.fulfill({
                    status: 200,
                    contentType: "application/json",
                    body: JSON.stringify({
                        id: "test-id",
                        code: "123456",
                        expiresAt: new Date(
                            Date.now() + 10 * 60_000,
                        ).toISOString(),
                    }),
                }),
        );
        await page.route(
            "**/api/kids/auth/quickconnect/poll**",
            async (route) =>
                await route.fulfill({
                    status: 200,
                    contentType: "application/json",
                    body: JSON.stringify({ status: "pending" }),
                }),
        );

        await page.goto("/player/login");

        // Code grid renders the 6 digits.
        const digits = page.locator(".kid-login-code-digit");
        await expect(digits).toHaveCount(6);
        for (let i = 0; i < 6; i++) {
            await expect(digits.nth(i)).toHaveText("123456".charAt(i));
        }
        // "Waiting for approval..." status is visible.
        await expect(
            page.getByText(/Waiting for approval/),
        ).toBeVisible();

        // Click "Use password instead" and the form takes over.
        await page.getByRole("button", { name: /Use password instead/ }).click();
        await expect(page.getByLabel("Username")).toBeVisible();
        await expect(page.getByLabel("Password")).toBeVisible();
    });
});

// Library / browse grid. Uses the admin preview path (?profileId=N)
// against the test-invariant Default profile so we don't need a kid
// mapping for the admin user.
async function gotoLibrary(page: import("@playwright/test").Page, profileId: number) {
    await clearKidsLocalStorage(page);
    await page.goto(`/player/library?profileId=${profileId}`);
    // The controls row (search + filter + sort + jump) is always
    // present on Library; wait for the search wrap as a stable anchor.
    await expect(page.locator(".library-search-wrap")).toBeVisible();
}

// selectFilter opens the Filter dropdown modal and clicks the named
// option. The dropdown lives in a portal on document.body, so we
// match the modal's option-picker-item buttons rather than scope to
// the page tree.
async function selectFilter(
    page: import("@playwright/test").Page,
    label: "All" | "Movies" | "Shows",
) {
    await page.locator(".library-dropdown-btn").filter({ hasText: "Filter:" }).click();
    await expect(page.locator(".alpha-picker-backdrop")).toBeVisible();
    await page.locator(".option-picker-item").filter({ hasText: label }).click();
    await expect(page.locator(".alpha-picker-backdrop")).toBeHidden();
}

// advanceWatchMenuIfPresent: when a Library tile click lands on the
// M7 watch menu (movies with resume progress, all series), press
// the primary action button (Play / Resume) so playback proceeds.
// No-op when the click went straight to /play.
async function advanceWatchMenuIfPresent(
    page: import("@playwright/test").Page,
) {
    // Give the URL a moment to settle.
    await page.waitForLoadState("domcontentloaded");
    if (!/\/player\/watch\//.test(page.url())) return;
    const primary = page.locator(".watch-action.primary").first();
    await primary.waitFor({ state: "visible", timeout: 5_000 });
    await primary.click();
}

test.describe("kids library", () => {
    test("controls row renders search, Filter, Sort, and Jump", async ({ page }) => {
        await gotoLibrary(page, 1);
        await expect(page.locator(".library-search-wrap")).toBeVisible();
        const filterBtn = page
            .locator(".library-dropdown-btn")
            .filter({ hasText: "Filter:" });
        const sortBtn = page
            .locator(".library-dropdown-btn")
            .filter({ hasText: "Sort:" });
        const jumpBtn = page.locator(".library-jump-btn");
        await expect(filterBtn).toBeVisible();
        await expect(sortBtn).toBeVisible();
        await expect(jumpBtn).toBeVisible();
        // Defaults: All + A - Z (sort=name).
        await expect(filterBtn).toContainText("All");
        await expect(sortBtn).toContainText("A - Z");
    });

    test("Filter dropdown -> Movies fires ?type=Movie", async ({ page }) => {
        await gotoLibrary(page, 1);
        // Wait for the initial fetch to finish so a click triggers a fresh
        // request we can observe.
        await page.locator(".tile-library, .library-state").first().waitFor();
        const moviesReq = page.waitForRequest((req) => {
            const url = req.url();
            return (
                url.includes("/api/kids/library") &&
                url.includes("type=Movie") &&
                !url.includes("type=Movie%2CSeries")
            );
        });
        await selectFilter(page, "Movies");
        await moviesReq;
    });

    test("library tiles render and clicking one navigates", async ({ page }) => {
        await gotoLibrary(page, 1);
        // Wait for at least one tile to render. Server returns visible items
        // for the Default profile; if empty the test data is misconfigured.
        const firstTile = page.locator(".tile-library").first();
        await expect(firstTile).toBeVisible({ timeout: 10_000 });
        await firstTile.click();
        // Movies route to /play directly; series + items with resume
        // progress route to /watch (M7 watch menu).
        await expect(page).toHaveURL(/\/player\/(play|watch)\//);
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
        await page.goto(`/player/library?profileId=1`);
        await expect(page.locator(".tile-library").first()).toBeVisible({
            timeout: 15_000,
        });
        await page.locator("input.library-search").fill("scoo");
        // Debounce is 300ms; allow up to a second for the request.
        await page.waitForTimeout(800);
        expect(searches).toContain("scoo");
    });

    test("D-pad: ArrowDown walks tab → search → first tile", async ({ page }) => {
        await gotoLibrary(page, 1);
        await page.locator(".tile-library").first().waitFor({ state: "visible" });
        // Page mounts with the tab nav focused. ArrowDown #1 hands
        // focus from the tab pill to the search wrap; ArrowDown #2
        // moves into the first grid tile.
        await page.keyboard.press("ArrowDown");
        await expect(page.locator(".library-search-wrap.focused")).toBeVisible();
        await page.keyboard.press("ArrowDown");
        await expect(page.locator(".tile.focused")).toHaveCount(1);
        // Enter doesn't activate in admin-preview (the kid-only
        // useLongPressEnter hook is disabled without a session, and
        // the page's keydown handler preventDefault's Enter). Verify
        // the equivalent click path instead.
        await page.locator(".tile.focused").click();
        await expect(page).toHaveURL(/\/player\/(play|watch)\//);
    });

    test("Series tiles get a TV badge when filtered to Shows", async ({ page }) => {
        await gotoLibrary(page, 1);
        await page.locator(".tile-library, .library-state").first().waitFor();
        const seriesReq = page.waitForRequest((req) =>
            req.url().includes("/api/kids/library") &&
            req.url().includes("type=Series"),
        );
        await selectFilter(page, "Shows");
        await seriesReq;
        const firstTile = page.locator(".tile-library").first();
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

        await page.goto(`/player/library?profileId=1`);
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
        // Cache key shape mirrors libraryCache.cacheKey:
        //   `${userId}:${section}:${type}:${limit}:${startIndex}:${search}:${sort}`
        // Library mounts with PAGE_SIZE=5000, sort=name, no search.
        const CACHE_KEY_ALL = `${FAKE_USER_ID}:all:Movie,Series:5000:0::name`;

        // Seed the kids client's localStorage + IDB before the SPA boots.
        // addInitScript runs in every page context within this test, so
        // the second navigation (the "reload") sees the same state.
        await page.addInitScript(
            ({ userId, etag, tileName, allKey }) => {
                if (location.pathname.startsWith("/player")) {
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
                (window as unknown as { __cacheSeed: Promise<void> }).__cacheSeed =
                    seed(allKey, allPage);
            },
            {
                userId: FAKE_USER_ID,
                etag: FAKE_ETAG,
                tileName: CACHE_TILE_NAME,
                allKey: CACHE_KEY_ALL,
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
        const tile = page.locator(".tile-library").first();
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
        // PAGE_SIZE=5000, sort=name, no search. Cache keys for each
        // filter the test will exercise.
        const KEY_MOVIE_ALL = `${FAKE_USER_ID}:all:Movie:5000:0::name`;
        const KEY_TV_ALL = `${FAKE_USER_ID}:all:Series:5000:0::name`;
        const KEY_BOTH_ALL = `${FAKE_USER_ID}:all:Movie,Series:5000:0::name`;

        await page.addInitScript(
            ({
                userId,
                etag,
                movieTile,
                tvTile,
                keyMovieAll,
                keyTvAll,
                keyBothAll,
            }) => {
                if (location.pathname.startsWith("/player")) {
                    localStorage.setItem("jellybean.kids.token", "fake-bearer-token");
                    localStorage.setItem("jellybean.kids.userId", userId);
                    localStorage.setItem("jellybean.kids.userName", "filter-switch");
                    localStorage.setItem("jellybean.kids.profileId", "1");
                    localStorage.setItem("jellybean.kids.kidName", "Filter Switch Kid");
                    // Force the default filter to "all" so the first
                    // render uses the All cache; the test then clicks
                    // Movies and Shows in turn.
                    localStorage.setItem("jellybean.kids.library.filter", "all");
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
                (window as unknown as { __cacheSeed: Promise<void> }).__cacheSeed =
                    Promise.all([
                        seed(keyMovieAll, moviePage),
                        seed(keyTvAll, tvPage),
                        seed(keyBothAll, bothPage),
                    ]).then(() => undefined);
            },
            {
                userId: FAKE_USER_ID,
                etag: FAKE_ETAG,
                movieTile: MOVIE_TILE,
                tvTile: TV_TILE,
                keyMovieAll: KEY_MOVIE_ALL,
                keyTvAll: KEY_TV_ALL,
                keyBothAll: KEY_BOTH_ALL,
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
        // contains both tiles, so .tile-library should be visible.
        await expect(page.locator(".tile-library").first()).toBeVisible({
            timeout: 5_000,
        });

        const loadingText = page.locator(".library-state");

        // Switch to Shows. The cache hit should swap tiles
        // synchronously; the loading text must never appear during
        // the transition. We poll .library-state across a short
        // window after the selection and assert it stayed hidden
        // the whole time.
        const sawLoadingDuringTv = pollVisibleEver(loadingText, 250);
        await selectFilter(page, "Shows");
        const tvFlash = await sawLoadingDuringTv;
        expect(tvFlash).toBe(false);
        await expect(page.locator(".tile-library").first()).toBeVisible();

        // Now switch to Movies, same assertion.
        const sawLoadingDuringMovies = pollVisibleEver(loadingText, 250);
        await selectFilter(page, "Movies");
        const moviesFlash = await sawLoadingDuringMovies;
        expect(moviesFlash).toBe(false);
        await expect(page.locator(".tile-library").first()).toBeVisible();
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
        const CACHE_KEY_ALL = `${FAKE_USER_ID}:all:Movie,Series:5000:0::name`;

        await page.addInitScript(
            ({ userId, etag, tileName, allKey }) => {
                if (location.pathname.startsWith("/player")) {
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
                (window as unknown as { __cacheSeed: Promise<void> }).__cacheSeed =
                    seed(allKey, allPage);
            },
            {
                userId: FAKE_USER_ID,
                etag: FAKE_ETAG,
                tileName: CACHE_TILE_NAME,
                allKey: CACHE_KEY_ALL,
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

        const tile = page.locator(".tile-library").first();
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
            if (location.pathname.startsWith("/player")) {
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
        await gotoLibrary(page, 1);
        await selectFilter(page, "Movies");
        const movieTile = page.locator(".tile-library").first();
        await expect(movieTile).toBeVisible({ timeout: 10_000 });

        const streamReq = page.waitForRequest((req) =>
            req.url().includes("/api/kids/items/") && req.url().includes("/stream"),
        );
        await movieTile.click();
        // Movies with resume progress route via the M7 watch menu;
        // click "Play" / "Resume" there to land on /play.
        await advanceWatchMenuIfPresent(page);
        await streamReq;
        await expect(page).toHaveURL(/\/player\/play\//);
        const video = page.locator("video");
        await expect(video).toBeVisible();
    });

    test("Esc returns to the watch menu (M7 #44)", async ({ page }) => {
        await gotoLibrary(page, 1);
        await selectFilter(page, "Movies");
        const movieTile = page.locator(".tile-library").first();
        await expect(movieTile).toBeVisible({ timeout: 10_000 });
        await movieTile.click();
        // The library tile may route to /watch (in-progress) or /play
        // (fresh). When it's the latter, Esc lands on the watch
        // interstitial; when it's the former we never enter /play to
        // begin with, so skip that branch.
        const url = page.url();
        if (!/\/player\/play\//.test(url)) {
            test.skip();
        }
        await page.keyboard.press("Escape");
        await expect(page).toHaveURL(/\/player\/watch\//);
    });

    test("back button returns to the watch menu (M7 #44)", async ({ page }) => {
        await gotoLibrary(page, 1);
        await selectFilter(page, "Movies");
        const movieTile = page.locator(".tile-library").first();
        await expect(movieTile).toBeVisible({ timeout: 10_000 });
        await movieTile.click();
        const url = page.url();
        if (!/\/player\/play\//.test(url)) {
            test.skip();
        }
        await page.getByRole("link", { name: /^Back$/ }).first().click();
        await expect(page).toHaveURL(/\/player\/watch\//);
    });

    test("custom transport mounts and reveals on keypress", async ({ page }) => {
        // Issue #33: replace native <video controls> with a kid-friendly
        // custom transport. Transport stays hidden during the initial
        // buffer state to avoid showing a "Play" button while the video
        // is loading; first user keypress reveals it. Verify it mounts
        // with a scrubber and at least the restart + play/pause buttons.
        await gotoLibrary(page, 1);
        await selectFilter(page, "Movies");
        const movieTile = page.locator(".tile-library").first();
        await expect(movieTile).toBeVisible({ timeout: 10_000 });
        await movieTile.click();
        await advanceWatchMenuIfPresent(page);
        await expect(page).toHaveURL(/\/player\/play\//);
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
