import { test, expect, type Page } from "@playwright/test";

// M8 #48 + #47 e2e. Hits /kids/browse via the admin preview path
// (?profileId=N + admin cookie). Confirms:
//   - tab pill renders with Browse active
//   - rows from the seeded default layout show up
//   - clicking the Library tab navigates to /library with the pill
//     re-anchored to Library

async function gotoKids(page: Page, path: string) {
    await page.goto(path);
    // Tab pill is universal across browse + library; wait for it.
    await expect(page.locator(".kids-tabpill")).toBeVisible();
}

test.describe("kids browse + tab pill", () => {
    test("browse page loads with the active tab pill + at least one row", async ({
        page,
    }) => {
        await gotoKids(page, "/kids/browse?profileId=1");
        const browseBtn = page
            .locator(".kids-tabpill-btn")
            .filter({ hasText: "Browse" });
        await expect(browseBtn).toHaveClass(/active/);
        // Wait for at least one row title to render. The seeded
        // default layout includes a tag_fanout row, which expands
        // to one row per tag - if there are any tags applied to
        // visible items the page will have rows.
        await expect(page.locator(".browse-row").first()).toBeVisible({
            timeout: 15_000,
        });
    });

    test("clicking Library tab navigates to /library", async ({ page }) => {
        await gotoKids(page, "/kids/browse?profileId=1");
        await page
            .locator(".kids-tabpill-btn")
            .filter({ hasText: "Library" })
            .click();
        await expect(page).toHaveURL(/\/kids\/library/);
        const libraryBtn = page
            .locator(".kids-tabpill-btn")
            .filter({ hasText: "Library" });
        await expect(libraryBtn).toHaveClass(/active/);
    });

    test("clicking a tile navigates to /play or /watch", async ({ page }) => {
        // M7: Series + in-progress movies route to /watch; fresh
        // movies still go straight to /play. Either is a valid
        // outcome for "the first tile."
        await gotoKids(page, "/kids/browse?profileId=1");
        const firstTile = page.locator(".browse-tile").first();
        await expect(firstTile).toBeVisible({ timeout: 15_000 });
        await firstTile.click();
        await expect(page).toHaveURL(/\/kids\/(play|watch)\//);
    });
});
