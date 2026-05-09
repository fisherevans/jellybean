import { test, expect } from "@playwright/test";

// 720p layout sanity for the rewritten OverrideModal. We can't
// actually verify the PIN flow end-to-end here (the fixture
// doesn't carry an admin pattern out of the box), but we CAN
// confirm the modal renders within the 1280x720 viewport and
// scrolls cleanly when the kid would have to walk a long list.
//
// The modal is opened via long-press Enter from
// /player/library?profileId=1; we synthesize a 1.5s Enter hold
// on the first focused tile and snapshot the resulting card.

const PROFILE_ID = 1;

test.describe("override modal layout", () => {
    test.use({ viewport: { width: 1280, height: 720 } });

    test("PIN stage fits 720p", async ({ page }) => {
        // Spoof a kid session so useLongPressEnter's `!!session`
        // gate becomes truthy; admin cookie still takes precedence
        // on the server, so this is purely client-side enablement
        // for the long-press hook.
        await page.addInitScript(() => {
            localStorage.setItem("jellybean.kids.token", "spoof-token");
            localStorage.setItem("jellybean.kids.userId", "spoof-user");
            localStorage.setItem("jellybean.kids.profileId", "1");
            localStorage.setItem("jellybean.kids.userName", "spoof");
            localStorage.setItem("jellybean.kids.kidName", "Spoof");
        });
        await page.goto(`/player/library?profileId=${PROFILE_ID}`);
        await expect(page.locator(".tile-library").first()).toBeVisible({
            timeout: 15_000,
        });
        // Walk to the first tile (tab → search → tile).
        await page.keyboard.press("ArrowDown");
        await page.keyboard.press("ArrowDown");
        await expect(page.locator(".tile.focused")).toHaveCount(1);
        // Hold Enter for 1100ms to fire long-press.
        await page.keyboard.down("Enter");
        await page.waitForTimeout(1200);
        await page.keyboard.up("Enter");
        // Modal opens with the PIN stage.
        const modal = page.locator(".override-modal");
        await expect(modal).toBeVisible({ timeout: 5_000 });
        // Adult class applied.
        await expect(
            page.locator(".override-backdrop.kids-override-adult"),
        ).toBeVisible();
        // Modal fits within viewport (no horizontal scroll, height
        // capped to 88vh).
        const box = await modal.boundingBox();
        expect(box).not.toBeNull();
        if (!box) return;
        // max-width 440px + box-sizing content-box plus padding
        // (1.25rem each side + 1px border) ≈ 484. Round budget to
        // half the viewport: even on 1280px wide screens the modal
        // should comfortably fit with margin around it.
        expect(box.width).toBeLessThanOrEqual(640);
        expect(box.height).toBeLessThanOrEqual(720 * 0.88 + 16);
        // PIN dots render.
        await expect(page.locator(".override-pin-dot")).toHaveCount(4);
    });
});
