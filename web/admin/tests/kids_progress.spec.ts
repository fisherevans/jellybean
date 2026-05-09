import { test, expect, type Page } from "@playwright/test";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

// Tiny valid MP4 (2x2 black, 1 frame, ~1.5KB). Used as a stand-in
// stream so HlsVideo can mount its <video> element without HLS.js
// (or the browser's native decoder) firing a fatal error and
// flipping the player into "needs a reset" state. ffmpeg one-liner
// to regenerate: ffmpeg -f lavfi -i color=black:s=2x2:r=1 -t 1
// -pix_fmt yuv420p tiny.mp4
const HERE = path.dirname(fileURLToPath(import.meta.url));
const TINY_MP4 = fs.readFileSync(path.join(HERE, "fixtures", "tiny.mp4"));

// Visual-state regression for the watched/progress badges added to
// Tile + the Watch episode accordion. These don't snapshot pixels;
// they assert the DOM shape we promised: tiles whose UserData carries
// a played/in-progress signal pick up the right CSS class so the
// kid sees the right visual.
//
// Hits the admin-preview path with a known seeded profile so the
// test is reproducible without standing up a kid bearer login.

const PREVIEW_PROFILE = 1;

async function gotoKids(page: Page, path: string) {
    await page.goto(path);
    await expect(page.locator(".kids-tabpill")).toBeVisible({
        timeout: 15_000,
    });
}

test.describe("kids tile progress + watched badges", () => {
    test("library tiles render either no marker, a progress bar, or a watched badge - never both", async ({
        page,
    }) => {
        await gotoKids(page, `/player/library?profileId=${PREVIEW_PROFILE}`);
        await expect(page.locator(".tile-library").first()).toBeVisible({
            timeout: 15_000,
        });
        // Across all rendered tiles, every tile has at most one of:
        //   .tile-watched-badge (Played || pct >= 90)
        //   .tile-progress      (5 <= pct < 90)
        // A tile with both would mean our threshold logic in Tile.tsx
        // shipped contradictory states.
        const violations = await page.evaluate(() => {
            const out: string[] = [];
            const tiles = document.querySelectorAll(".tile");
            for (const t of Array.from(tiles)) {
                const watched = t.querySelector(".tile-watched-badge");
                const progress = t.querySelector(".tile-progress");
                if (watched && progress) {
                    out.push(
                        t
                            .querySelector(".tile-title-text")
                            ?.textContent?.trim() ?? "(unnamed tile)",
                    );
                }
            }
            return out;
        });
        expect(
            violations,
            `These tiles have both .tile-watched-badge AND .tile-progress: ${violations.join(", ")}`,
        ).toEqual([]);
    });

    test("library tiles surface watched + progress states when data is present", async ({
        page,
    }) => {
        await gotoKids(page, `/player/library?profileId=${PREVIEW_PROFILE}`);
        await expect(page.locator(".tile-library").first()).toBeVisible({
            timeout: 15_000,
        });
        // The library is filtered to whatever the profile has, so
        // we can't guarantee a watched item exists. But we CAN
        // assert the styles are reachable: query computed styles on
        // a constructed tile via evaluate. This catches "the CSS
        // class went away" / "the rule got nuked" regressions
        // without depending on specific items in the live DB.
        const cssVisible = await page.evaluate(() => {
            const out: Record<string, string> = {};
            const div = document.createElement("div");
            div.className = "tile-poster is-watched";
            div.style.position = "absolute";
            div.style.top = "-9999px";
            const img = document.createElement("img");
            img.src = "data:image/gif;base64,R0lGODlhAQABAAAAACw=";
            div.appendChild(img);
            document.body.appendChild(div);
            const computed = getComputedStyle(img).filter;
            out.watchedFilter = computed;
            div.remove();
            return out;
        });
        expect(cssVisible.watchedFilter).not.toBe("none");
        expect(cssVisible.watchedFilter).toContain("brightness");
    });

    test("watch interstitial renders accordion with watched dim + checkmark when episodes are watched", async ({
        page,
    }) => {
        await gotoKids(page, `/player/library?profileId=${PREVIEW_PROFILE}`);
        // Find the first Series tile (TV badge present) and click
        // through. If no series exist on the seeded profile, skip.
        const seriesTile = page
            .locator(".tile-library")
            .filter({ has: page.locator(".tile-badge-tv") })
            .first();
        if ((await seriesTile.count()) === 0) {
            test.skip();
            return;
        }
        await seriesTile.scrollIntoViewIfNeeded();
        await seriesTile.click();
        await expect(page).toHaveURL(/\/player\/watch\//);
        // Wait for the accordion to materialize. If the series has
        // no seasons (rare but possible if the metadata is sparse),
        // skip - we can't assert state we don't have.
        const accordion = page.locator(".watch-accordion");
        await expect(accordion).toBeVisible({ timeout: 15_000 });
        const seasonHead = page.locator(".watch-season-head").first();
        if ((await seasonHead.count()) === 0) {
            test.skip();
            return;
        }
        // Auto-open behavior renders at least one season's
        // episodes. Confirm the inner shape is right: the
        // wrapper carries `.is-watched` only when the
        // server-reported state says so, and the badge is the
        // green check we added (not the old plain ✓).
        const sanity = await page.evaluate(() => {
            const wraps = document.querySelectorAll(".watch-episode-thumb-wrap");
            let watchedCount = 0;
            let withBadgeCount = 0;
            for (const w of Array.from(wraps)) {
                if (w.classList.contains("is-watched")) watchedCount++;
                if (w.querySelector(".watch-episode-thumb-watched")) {
                    withBadgeCount++;
                }
            }
            return { wraps: wraps.length, watchedCount, withBadgeCount };
        });
        // Every "is-watched" wrapper should carry a badge, and
        // every badge should be inside a watched wrapper. Mismatch
        // = the threshold logic split.
        expect(sanity.watchedCount).toEqual(sanity.withBadgeCount);
    });
});

// Stubbed-response tests. These don't depend on the live profile
// having specific items - they intercept the kid API endpoints with
// page.route() and serve synthetic JSON. The assertion target is the
// rendered DOM, which is what regressed in production.
//
// Auth: we spoof a kid session in localStorage so the page mounts
// without bouncing to /login. No server-side auth is exercised for
// these tests since the routed responses bypass the network entirely.
test.describe("kids tile state (stubbed)", () => {
    test("library renders watched + in-progress + unwatched tiles correctly", async ({
        page,
    }) => {
        await page.addInitScript(() => {
            localStorage.setItem("jellybean.kids.token", "spoof-token");
            localStorage.setItem("jellybean.kids.userId", "spoof-user");
            localStorage.setItem("jellybean.kids.profileId", "1");
            localStorage.setItem("jellybean.kids.userName", "spoof");
            localStorage.setItem("jellybean.kids.kidName", "Spoof");
        });

        await page.route("**/api/kids/library?**", async (route) => {
            await route.fulfill({
                status: 200,
                contentType: "application/json",
                headers: { ETag: '"stub-etag"' },
                body: JSON.stringify({
                    Items: [
                        {
                            Id: "watched-movie",
                            Name: "Watched Movie",
                            Type: "Movie",
                            ImageTags: { Primary: "tag-1" },
                            UserData: {
                                Played: true,
                                PlayedPercentage: 100,
                            },
                        },
                        {
                            Id: "inprogress-movie",
                            Name: "In-Progress Movie",
                            Type: "Movie",
                            ImageTags: { Primary: "tag-2" },
                            UserData: {
                                Played: false,
                                PlayedPercentage: 42,
                            },
                        },
                        {
                            Id: "fresh-movie",
                            Name: "Fresh Movie",
                            Type: "Movie",
                            ImageTags: { Primary: "tag-3" },
                            UserData: { Played: false, PlayedPercentage: 0 },
                        },
                    ],
                    HasMore: false,
                    NextStartIndex: 3,
                    LettersByName: { W: 0, I: 1, F: 2 },
                }),
            });
        });
        // Stop image fetches from hitting the network. Returning
        // a tiny pixel keeps the <img> tag in the DOM (so the
        // .tile-poster.is-watched > img selector still applies).
        await page.route("**/api/kids/items/**/image**", async (route) => {
            await route.fulfill({
                status: 200,
                contentType: "image/gif",
                body: Buffer.from(
                    "R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7",
                    "base64",
                ),
            });
        });

        await page.goto("/player/library?profileId=1");
        await expect(page.locator(".tile-library").first()).toBeVisible({
            timeout: 15_000,
        });

        // Watched tile carries .is-watched + the green badge.
        const watched = page
            .locator(".tile-library")
            .filter({ hasText: "Watched Movie" });
        await expect(watched.locator(".tile-poster.is-watched")).toHaveCount(1);
        await expect(watched.locator(".tile-watched-badge")).toHaveCount(1);
        await expect(watched.locator(".tile-progress")).toHaveCount(0);

        // In-progress tile has the bar at exactly its pct, no badge.
        const inProgress = page
            .locator(".tile-library")
            .filter({ hasText: "In-Progress Movie" });
        await expect(inProgress.locator(".tile-progress")).toHaveCount(1);
        await expect(inProgress.locator(".tile-watched-badge")).toHaveCount(0);
        await expect(inProgress.locator(".tile-poster.is-watched")).toHaveCount(
            0,
        );
        const barWidth = await inProgress
            .locator(".tile-progress")
            .evaluate((el) => (el as HTMLElement).style.width);
        expect(barWidth).toBe("42%");

        // Fresh tile (pct = 0) has neither marker.
        const fresh = page
            .locator(".tile-library")
            .filter({ hasText: "Fresh Movie" });
        await expect(fresh.locator(".tile-progress")).toHaveCount(0);
        await expect(fresh.locator(".tile-watched-badge")).toHaveCount(0);
    });
});

// Real Up Next overlay coverage. We can't actually play a video to
// 90% in headless Chrome, but we can stub the stream + next-up
// endpoints, mount /player/play, then dispatch a synthetic
// timeupdate against the <video> element with a forced
// currentTime/duration that crosses the threshold. That's exactly
// what the production trigger reads, so the overlay state machine
// runs end to end - covering the bug surface for #1/#3 (countdown
// post-unmount + state leak across episode swaps).
test.describe("kids up-next overlay (stubbed)", () => {
    test("overlay appears at 90%, counts down, and cancel hides it", async ({
        page,
    }) => {
        await page.addInitScript(() => {
            localStorage.setItem("jellybean.kids.token", "spoof-token");
            localStorage.setItem("jellybean.kids.userId", "spoof-user");
            localStorage.setItem("jellybean.kids.profileId", "1");
            localStorage.setItem("jellybean.kids.userName", "spoof");
            localStorage.setItem("jellybean.kids.kidName", "Spoof");
            // Prevent the test fixture mp4 from actually playing.
            // Without this the 1s clip plays through, fires `ended`,
            // and Play.tsx's onEnded auto-advances to a non-stubbed
            // EP2 - which derails the test mid-flight.
            const realPlay = HTMLMediaElement.prototype.play;
            HTMLMediaElement.prototype.play = function () {
                // Resolve the promise so callers awaiting play()
                // don't hang. Don't actually start playback.
                return Promise.resolve();
            };
            // Reference realPlay so TypeScript's noUnused doesn't
            // strip it; also leaves an escape hatch if a future
            // test needs the real method.
            (window as unknown as { __realPlay: unknown }).__realPlay =
                realPlay;
        });

        await page.route("**/api/kids/items/EP1/stream", async (route) => {
            await route.fulfill({
                status: 200,
                contentType: "application/json",
                body: JSON.stringify({
                    streamUrl: "/__test/tiny.mp4",
                    itemId: "EP1",
                    itemName: "Test Episode 1",
                    itemType: "Episode",
                    seriesId: "SERIES1",
                    seriesName: "Test Series",
                    indexNumber: 1,
                    parentIndexNumber: 1,
                    runtimeTicks: 24 * 60 * 10_000_000,
                    userData: { PlaybackPositionTicks: 0, PlayedPercentage: 0 },
                }),
            });
        });
        // Serve a tiny valid mp4 for the streamUrl so HlsVideo's
        // non-HLS branch can attach the <video> element without
        // tripping the player's media-error -> "needs a reset" path.
        await page.route("**/__test/tiny.mp4", async (route) => {
            await route.fulfill({
                status: 200,
                contentType: "video/mp4",
                body: TINY_MP4,
            });
        });
        await page.route(
            "**/api/kids/items/SERIES1/next-up?**",
            async (route) => {
                await route.fulfill({
                    status: 200,
                    contentType: "application/json",
                    body: JSON.stringify({
                        episodeId: "EP2",
                        name: "The Magic Shop",
                        seriesId: "SERIES1",
                        seriesName: "Test Series",
                        indexNumber: 4,
                        parentIndexNumber: 2,
                    }),
                });
            },
        );
        // Playback events: 204 for everything so the queue drainer is happy.
        await page.route("**/api/kids/playback/**", async (route) => {
            await route.fulfill({ status: 204, body: "" });
        });

        await page.goto("/player/play/EP1");

        // Wait for the video element to be in the DOM before
        // synthesizing events. HlsVideo mounts a <video>, even if
        // the stub's data URI source fails to play.
        await page.waitForSelector(".play-screen video", { timeout: 15_000 });

        // Force a duration + currentTime past the 90% threshold,
        // then dispatch timeupdate. The page's onTimeUpdate reads
        // both off the element directly.
        await page.evaluate(() => {
            const v = document.querySelector(".play-screen video");
            if (!(v instanceof HTMLVideoElement)) {
                throw new Error("video element not found");
            }
            Object.defineProperty(v, "duration", {
                value: 100,
                configurable: true,
            });
            Object.defineProperty(v, "currentTime", {
                value: 92,
                configurable: true,
            });
            v.dispatchEvent(new Event("timeupdate"));
        });

        // Overlay should mount; Skip Now button gets DOM focus per
        // the autoFocus useEffect inside UpNextOverlay.
        const overlay = page.locator(".up-next-overlay");
        await expect(overlay).toBeVisible({ timeout: 5_000 });
        await expect(overlay.locator(".up-next-title")).toContainText(
            "The Magic Shop",
        );
        await expect(overlay.locator(".up-next-badge")).toContainText("S2E04");
        // Initial label reads "Up Next in 10".
        await expect(overlay.locator(".up-next-label")).toContainText(
            /Up Next in 10/,
        );
        // Skip Now is focused so an Enter press would auto-advance.
        const skip = overlay.locator(".up-next-btn.primary");
        await expect(skip).toBeFocused();

        // Wait long enough for at least one countdown tick (1s + buffer).
        await page.waitForTimeout(1200);
        const labelAfter = await overlay
            .locator(".up-next-label")
            .textContent();
        expect(labelAfter).toMatch(/Up Next in [0-9]/);
        // The label shouldn't still read 10 - that'd mean the
        // countdown effect never ran.
        expect(labelAfter).not.toMatch(/Up Next in 10/);

        // Cancel hides the overlay.
        await overlay.locator(".up-next-btn:not(.primary)").click();
        await expect(overlay).toBeHidden({ timeout: 2_000 });
    });
});

test.describe("up-next overlay structure", () => {
    test("UpNextOverlay markup is reachable via direct DOM probe", async ({
        page,
    }) => {
        // Confirm the CSS for the overlay loads (catches "styles got
        // dropped" regressions). The end-to-end render test below
        // exercises the actual component.
        await gotoKids(page, `/player/library?profileId=${PREVIEW_PROFILE}`);
        const cssOK = await page.evaluate(() => {
            const probe = document.createElement("div");
            probe.className = "up-next-card";
            probe.style.position = "absolute";
            probe.style.top = "-9999px";
            document.body.appendChild(probe);
            const bg = getComputedStyle(probe).background;
            const ok = bg.includes("rgb") && bg !== "";
            probe.remove();
            return ok;
        });
        expect(cssOK).toBe(true);
    });
});
