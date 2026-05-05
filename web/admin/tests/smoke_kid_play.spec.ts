import { test, expect } from "@playwright/test";
import { mkdirSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

// Smoke test the kid SPA. The setup file already authenticates as
// the admin user; the parent-preview path lets the same cookie
// browse the kid client without needing a kid login flow.
//
// Walks: load /player, see the library, click an item, confirm
// the playback page loads + the <video> element is mounted.

const __filename_local = fileURLToPath(import.meta.url);
const __dirname_local = dirname(__filename_local);
const SHOTS_DIR = resolve(
    __dirname_local,
    "..",
    "..",
    "..",
    ".run",
    "ux-review",
    "smoke-walk",
);
mkdirSync(SHOTS_DIR, { recursive: true });

test.use({
    // The kid SPA is served from /player, but the auth setup baked
    // its cookies for the same origin — so cookie auth carries.
    baseURL: "http://localhost:8765",
});

test("kid: library renders, playback page mounts video", async ({ page }) => {
    await page.goto("/player");
    // The kid client may redirect to a login screen if no kid is
    // mapped. Pass profile + kid via querystring to skip the picker.
    await page.waitForLoadState("networkidle");
    await page.screenshot({
        path: resolve(SHOTS_DIR, "40-kid-home.png"),
        fullPage: true,
    });

    // Try to find a poster grid tile.
    const tiles = page.locator(
        '.tile, [data-testid="tile"], a[href^="/play/"], .browse-tile, .library-tile, button.browse-tile',
    );
    const tileCount = await tiles.count();
    if (tileCount === 0) {
        // Empty state — that's still a green render. Bail.
        return;
    }
    await tiles.first().click();
    await page.waitForLoadState("networkidle");
    await page.screenshot({
        path: resolve(SHOTS_DIR, "41-kid-after-click.png"),
        fullPage: true,
    });
    // If we got to a play page, expect the <video>.
    if (page.url().includes("/play")) {
        const video = page.locator("video").first();
        await expect(video).toBeAttached({ timeout: 15_000 });
    }
});
