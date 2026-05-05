import { test, expect } from "@playwright/test";
import { mkdirSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

// Verify Browse card structure end-to-end against the rendered DOM.
// Replaces eyeballing the full-page thumbnails with concrete
// assertions about the layout, plus a tight per-card screenshot for
// visual confirmation.

const __filename_local = fileURLToPath(import.meta.url);
const __dirname_local = dirname(__filename_local);
const SHOTS_DIR = resolve(__dirname_local, "..", "..", "..", ".run", "ux-review");
mkdirSync(SHOTS_DIR, { recursive: true });

test("browse card layout + interactions match feedback spec", async ({ page }) => {
    await page.goto("/manage/browse");
    await page.waitForSelector(".browse-item", { timeout: 15_000 });

    // Crop the first card so we can see what the cards actually look
    // like at full resolution.
    const firstCard = page.locator(".browse-item").first();
    await firstCard.screenshot({
        path: resolve(SHOTS_DIR, "20-browse-card-zoom.png"),
    });

    // Geometry checks: poster on LEFT of body, title/meta to the
    // RIGHT, tag pills at the BOTTOM-RIGHT.
    const cardBox = await firstCard.boundingBox();
    if (!cardBox) throw new Error("no card box");
    const poster = firstCard.locator(".browse-item-poster").first();
    const name = firstCard.locator(".browse-item-name").first();
    const meta = firstCard.locator(".browse-item-meta").first();

    const posterBox = await poster.boundingBox();
    const nameBox = await name.boundingBox();
    const metaBox = await meta.boundingBox();
    if (!posterBox || !nameBox || !metaBox)
        throw new Error("missing inner boxes");

    // Title sits to the RIGHT of the poster (its left edge is past
    // the poster's right edge).
    expect(nameBox.x).toBeGreaterThan(posterBox.x + posterBox.width - 1);
    // Meta is on the same horizontal band as the title (within the
    // card body). Just sanity-check it's also right of the poster.
    expect(metaBox.x).toBeGreaterThan(posterBox.x + posterBox.width - 1);

    // Tag pills (when the item has any) live in the bottom-right of
    // the card body.
    const tagsBlock = firstCard.locator(".browse-item-tags").first();
    if (await tagsBlock.count()) {
        const tagsBox = await tagsBlock.boundingBox();
        if (!tagsBox) throw new Error("tags box missing");
        // Below the title.
        expect(tagsBox.y).toBeGreaterThan(nameBox.y + nameBox.height - 1);
        // The tags row right edge should be at the right edge of the
        // card's content (within ~30px of the kebab button).
        const rightEdge = cardBox.x + cardBox.width;
        expect(tagsBox.x + tagsBox.width).toBeGreaterThan(rightEdge - 80);
    }

    // Filter chevron isn't the tiny ▾ anymore - it's a real triangle
    // we render at 0.95rem.
    const filterBtn = page.getByRole("button", { name: /Filters/ });
    const caret = filterBtn.locator(".browse-filter-caret");
    await expect(caret).toBeVisible();
    const caretFontSize = await caret.evaluate((el) =>
        getComputedStyle(el).fontSize,
    );
    expect(parseFloat(caretFontSize)).toBeGreaterThan(12);

    // Sort dropdown is wired up.
    const sort = page.locator(".browse-sort").first();
    await expect(sort).toBeVisible();
    const options = await sort.locator("option").allInnerTexts();
    expect(options.some((o) => /^Name/.test(o))).toBeTruthy();
    expect(options.some((o) => /^Date added/.test(o))).toBeTruthy();
    expect(options.some((o) => /^Year/.test(o))).toBeTruthy();
    expect(options.some((o) => /^Rating/.test(o))).toBeTruthy();

    // Filter panel: tags multi-select. Open the panel and confirm
    // toggling two tags marks both as pressed.
    await filterBtn.click();
    const panel = page.locator(".browse-filter-panel");
    await expect(panel).toBeVisible();
    const tagPills = panel
        .locator(".browse-filter-group")
        .filter({ hasText: /^Tags/ })
        .locator(".pill-toggle");
    const tagPillCount = await tagPills.count();
    if (tagPillCount >= 2) {
        await tagPills.nth(0).click();
        await tagPills.nth(1).click();
        await expect(tagPills.nth(0)).toHaveAttribute("aria-pressed", "true");
        await expect(tagPills.nth(1)).toHaveAttribute("aria-pressed", "true");
    }
    await page.screenshot({
        path: resolve(SHOTS_DIR, "21-browse-filter-open.png"),
        fullPage: true,
    });
});

test("browse search actually filters", async ({ page }) => {
    await page.goto("/manage/browse");
    await page.waitForSelector(".browse-item", { timeout: 15_000 });
    const beforeCount = await page.locator(".browse-item").count();
    await page.getByPlaceholder(/Search by name/).fill("scoo");
    await page.waitForTimeout(800); // debounce
    await page.waitForLoadState("networkidle");
    const afterCount = await page.locator(".browse-item").count();
    expect(afterCount).toBeLessThan(beforeCount);
    expect(afterCount).toBeGreaterThan(0);
    // At least one card should mention scooby
    const names = await page
        .locator(".browse-item-name")
        .allInnerTexts();
    expect(names.some((n) => /scoo/i.test(n))).toBeTruthy();
});

test("toggle switch sits on the right of the darker card", async ({ page }) => {
    await page.goto("/manage/profiles");
    await page.locator(".profile-card-link").first().click();
    await page.getByRole("tab", { name: "Time limits" }).click();
    await page.waitForSelector(".toggle-switch");

    const toggle = page.locator(".toggle-switch").first();
    const text = toggle.locator(".toggle-switch-text");
    const control = toggle.locator(".toggle-switch-control");
    const tBox = await toggle.boundingBox();
    const tx = await text.boundingBox();
    const cx = await control.boundingBox();
    if (!tBox || !tx || !cx) throw new Error("missing box");

    // Text starts at the left edge of the card (within padding).
    expect(tx.x - tBox.x).toBeLessThan(40);
    // Control's right edge sits at the right edge of the card.
    expect(tBox.x + tBox.width - (cx.x + cx.width)).toBeLessThan(40);
    // And the control sits well to the right of the text.
    expect(cx.x).toBeGreaterThan(tx.x + 60);

    // State label uses "Enabled" / "Disabled" not "On" / "Off".
    const state = control.locator(".toggle-switch-state");
    const text_ = await state.textContent();
    expect(text_).toMatch(/Enabled|Disabled/);
});

test("layout preview uses friendly labels + summary", async ({ page }) => {
    await page.goto("/manage/profiles");
    await page.locator(".profile-card-link").first().click();
    await page.waitForSelector(".settings-form");
    await page.getByRole("button", { name: "Preview", exact: true }).click();
    await page.waitForSelector(".layout-preview");

    const titles = await page
        .locator(".layout-preview-title")
        .allInnerTexts();
    // No raw enum names should appear as a title.
    for (const t of titles) {
        expect(t).not.toMatch(/^(continue_watching|tag_fanout|recently_added|random_unwatched|watch_again)$/);
    }
    // We expect to see at least one human label.
    expect(titles.some((t) => /Continue Watching|Recently Added|Random Unwatched|Tag fanout|Favorites/.test(t))).toBeTruthy();

    await page.screenshot({
        path: resolve(SHOTS_DIR, "22-layout-preview-verify.png"),
        fullPage: true,
    });
});

test("PIN is single field + read-only when set", async ({ page }) => {
    await page.goto("/manage/settings");
    await page.waitForSelector(".pin-input");
    // Either we're in read-only mode (Edit PIN button visible) or
    // the no-pin-set entry mode (Set PIN button visible).
    const editBtn = page.getByRole("button", { name: "Edit PIN" });
    const setBtn = page.getByRole("button", { name: /^Set PIN/ });
    const editVisible = await editBtn.isVisible().catch(() => false);
    const setVisible = await setBtn.isVisible().catch(() => false);
    expect(editVisible || setVisible).toBeTruthy();
    // No "Confirm" PIN field.
    expect(await page.getByText("Confirm").count()).toBe(0);
});

test("warm tint filter expression matches kid SPA target", async ({ page }) => {
    await page.goto("/manage/profiles");
    await page.locator(".profile-card-link").first().click();
    await page.getByRole("tab", { name: "Viewing" }).click();
    await page.waitForSelector(".viewing-preview-bezel");
    // Move the warm-tint slider all the way up.
    const warm = page
        .locator(".snap-slider")
        .filter({ hasText: /Warm tint|Red shift/ })
        .locator("input[type=number]");
    await warm.fill("100");
    await page.waitForTimeout(150);
    const filter = await page
        .locator(".viewing-preview-bezel")
        .first()
        .evaluate((el) => getComputedStyle(el).filter);
    // Should contain sepia, hue-rotate AND saturate now (the new
    // formula). Old formula was sepia + hue-rotate only.
    expect(filter).toMatch(/sepia\(/);
    expect(filter).toMatch(/hue-rotate\(/);
    expect(filter).toMatch(/saturate\(/);
});
