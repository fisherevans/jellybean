import { test, expect, type Page } from "@playwright/test";

// M7 watch menu e2e. Uses the admin-preview path
// (/player/watch/:id?profileId=1 + admin cookie). The watch menu is
// supposed to render hero + actions; for series, additionally an
// episode accordion.

async function gotoWatch(page: Page, itemId: string) {
    await page.goto(`/player/watch/${itemId}?profileId=1`);
}

async function pickFirstSeriesId(page: Page): Promise<string | null> {
    const res = await page.request.get(
        "/api/kids/library?profileId=1&type=Series&pageSize=20",
    );
    if (!res.ok()) return null;
    const body = (await res.json()) as { Items?: Array<{ Id: string }> };
    return body.Items?.[0]?.Id ?? null;
}

async function pickFirstMovieId(page: Page): Promise<string | null> {
    const res = await page.request.get(
        "/api/kids/library?profileId=1&type=Movie&pageSize=20",
    );
    if (!res.ok()) return null;
    const body = (await res.json()) as { Items?: Array<{ Id: string }> };
    return body.Items?.[0]?.Id ?? null;
}

test.describe("kids watch menu", () => {
    test("movie watch menu renders hero with Play action", async ({ page }) => {
        const id = await pickFirstMovieId(page);
        test.skip(!id, "no visible movies in admin preview library");
        await gotoWatch(page, id!);
        await expect(page.locator(".watch-hero h1")).toBeVisible({
            timeout: 15_000,
        });
        // First action should be focusable; admin preview with no
        // resume progress means the primary button is "Play".
        const playBtn = page
            .locator(".watch-action.primary")
            .filter({ hasText: /Play|Resume|Watch again/ });
        await expect(playBtn).toBeVisible();
    });

    test("series watch menu renders the episode accordion", async ({ page }) => {
        const id = await pickFirstSeriesId(page);
        test.skip(!id, "no visible series in admin preview library");
        await gotoWatch(page, id!);
        await expect(page.locator(".watch-hero h1")).toBeVisible({
            timeout: 15_000,
        });
        // The accordion should render at least one season header.
        await expect(page.locator(".watch-season-head").first()).toBeVisible({
            timeout: 15_000,
        });
    });

    test("Back link returns to /browse", async ({ page }) => {
        const id = await pickFirstMovieId(page);
        test.skip(!id, "no visible movies in admin preview library");
        await gotoWatch(page, id!);
        await expect(page.locator(".watch-hero h1")).toBeVisible({
            timeout: 15_000,
        });
        await page.locator(".watch-back-btn").click();
        await expect(page).toHaveURL(/\/player\/browse/);
    });
});
