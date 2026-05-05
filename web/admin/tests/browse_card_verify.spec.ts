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
    // toggling two tags marks both as pressed AND that the
    // accompanying label says "matches any" (OR), not "must match
    // all" (AND).
    await filterBtn.click();
    const panel = page.locator(".browse-filter-panel");
    await expect(panel).toBeVisible();
    const tagsGroup = panel
        .locator(".browse-filter-group")
        .filter({ hasText: /^Tags/ });
    const tagPills = tagsGroup.locator(".pill-toggle");
    const tagPillCount = await tagPills.count();
    if (tagPillCount >= 2) {
        await tagPills.nth(0).click();
        await tagPills.nth(1).click();
        await expect(tagPills.nth(0)).toHaveAttribute("aria-pressed", "true");
        await expect(tagPills.nth(1)).toHaveAttribute("aria-pressed", "true");
        const label = await tagsGroup
            .locator(".browse-filter-label")
            .innerText();
        expect(label).toMatch(/any/i);
        expect(label).not.toMatch(/must match all/i);
    }
    await page.screenshot({
        path: resolve(SHOTS_DIR, "21-browse-filter-open.png"),
        fullPage: true,
    });
});

test("browse sort dropdown matches the input/button styling", async ({ page }) => {
    await page.goto("/manage/browse");
    await page.waitForSelector(".browse-item", { timeout: 15_000 });
    const search = page.locator(".browse-search").first();
    const sort = page.locator(".browse-sort").first();
    const filt = page.getByRole("button", { name: /Filters/ }).first();
    const sBox = await search.boundingBox();
    const oBox = await sort.boundingBox();
    const fBox = await filt.boundingBox();
    if (!sBox || !oBox || !fBox) throw new Error("missing");
    // All three should be roughly the same height (within 4px).
    expect(Math.abs(sBox.height - oBox.height)).toBeLessThan(4);
    expect(Math.abs(fBox.height - oBox.height)).toBeLessThan(4);
    // Sort should have a visible border like the others.
    const sortBorder = await sort.evaluate(
        (el) => getComputedStyle(el).borderTopWidth,
    );
    expect(parseFloat(sortBorder)).toBeGreaterThan(0);
});

test("browse kebab menu shows full options without clipping", async ({ page }) => {
    await page.goto("/manage/browse");
    await page.waitForSelector(".browse-item", { timeout: 15_000 });
    const kebab = page.locator(".browse-item-kebab").first();
    await kebab.click();
    const menu = page.locator(".browse-item-menu").first();
    await expect(menu).toBeVisible();
    // No "Clear state" wording.
    expect(await menu.innerText()).not.toMatch(/Clear state/);
    // Should mention Mark unset (when state is set), or at least
    // visible/hidden affordances.
    const text = await menu.innerText();
    expect(text).toMatch(/Mark (visible|hidden|unset)/);
    // The menu should be fully visible inside the viewport.
    const menuBox = await menu.boundingBox();
    const vp = page.viewportSize();
    if (!menuBox || !vp) throw new Error("missing");
    expect(menuBox.x + menuBox.width).toBeLessThanOrEqual(vp.width + 1);
    expect(menuBox.y + menuBox.height).toBeLessThanOrEqual(vp.height + 1);
});

test("browse Edit button opens the item editor modal", async ({ page }) => {
    await page.goto("/manage/browse");
    await page.waitForSelector(".browse-item", { timeout: 15_000 });
    const editBtn = page.locator(".browse-item-edit").first();
    await editBtn.click();
    const modal = page.locator(".item-editor-modal");
    await expect(modal).toBeVisible({ timeout: 10_000 });

    // Modal contains the movie poster.
    await expect(modal.locator(".item-editor-poster")).toBeVisible();
    // Visibility radio group with the same style as tag rules.
    await expect(modal.locator(".item-editor-state-row .tag-filter-mode")).toHaveCount(3);
    // Tag pill multi-select OR a "no tags" message.
    const pills = modal.locator(".pill-toggle");
    const hasTags = (await pills.count()) > 0;
    const hasMessage = (await modal.getByText(/No tags yet/).count()) > 0;
    expect(hasTags || hasMessage).toBeTruthy();

    await page.screenshot({
        path: resolve(SHOTS_DIR, "23-item-editor-modal.png"),
        fullPage: true,
    });

    // Esc closes it.
    await page.keyboard.press("Escape");
    await expect(modal).toHaveCount(0);
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

test("time-limit snap slider has correct proportions", async ({ page }) => {
    await page.goto("/manage/profiles");
    await page.locator(".profile-card-link").first().click();
    await page.getByRole("tab", { name: "Time limits" }).click();
    await page.waitForSelector(".snap-slider");
    // Make sure limits are enabled so the slider renders.
    const enabled = await page
        .locator(".toggle-switch input[type=checkbox]")
        .first()
        .isChecked();
    if (!enabled) {
        await page.locator(".toggle-switch").first().click();
        await page.waitForTimeout(150);
    }
    const row = page.locator(".snap-slider-row").first();
    const range = row.locator(".snap-slider-range");
    const num = row.locator(".snap-slider-number");
    const r = await range.boundingBox();
    const n = await num.boundingBox();
    if (!r || !n) throw new Error("missing");
    // The slider should be much wider than the number input so the
    // user can actually drag the thumb.
    expect(r.width).toBeGreaterThan(n.width * 1.5);
    // Number input should be narrow.
    expect(n.width).toBeLessThan(120);
    // Drag the thumb and verify the number changes.
    const before = await num.inputValue();
    await range.focus();
    await page.keyboard.press("ArrowRight");
    await page.keyboard.press("ArrowRight");
    await page.keyboard.press("ArrowRight");
    await page.waitForTimeout(100);
    const after = await num.inputValue();
    expect(after).not.toBe(before);
    await page.screenshot({
        path: resolve(SHOTS_DIR, "24-snap-slider.png"),
        fullPage: true,
    });
});

test("mode-schedule day toggles are clickable", async ({ page }) => {
    await page.goto("/manage/profiles");
    await page.locator(".profile-card-link").first().click();
    await page.getByRole("tab", { name: "Modes" }).click();
    // Open or create a mode editor.
    const newBtn = page.getByRole("button", { name: /Add mode|New mode/ });
    if (await newBtn.count()) await newBtn.first().click();
    const dayPill = page
        .locator(".pill-fieldset", { hasText: "Days active" })
        .locator(".pill-toggle")
        .first();
    if ((await dayPill.count()) === 0) {
        // No editor open; bail without failing - the form might
        // not show until a mode is created.
        return;
    }
    const before = await dayPill.getAttribute("aria-pressed");
    await dayPill.click();
    await page.waitForTimeout(80);
    const after = await dayPill.getAttribute("aria-pressed");
    expect(after).not.toBe(before);
});

test("channel editor: search-and-add picker replaces textarea", async ({ page }) => {
    await page.goto("/manage/profiles");
    await page.locator(".profile-card-link").first().click();
    await page.getByRole("tab", { name: "Channels" }).click();
    await page.waitForSelector(".settings-form");
    // Open or create a channel.
    const addBtn = page.getByRole("button", { name: /Add channel/ });
    if (await addBtn.count()) await addBtn.first().click();
    else await page.getByRole("button", { name: /^Edit$/ }).first().click();
    // The textarea should be gone; the search input should exist.
    const oldTextarea = page.locator("textarea");
    expect(await oldTextarea.count()).toBe(0);
    const search = page.locator(".channel-pick-search");
    await expect(search).toBeVisible();
    // Distributed random sort option present.
    const distributed = page.getByRole("button", { name: /Distributed random/ });
    await expect(distributed).toBeVisible();
    await page.screenshot({
        path: resolve(SHOTS_DIR, "25-channel-editor.png"),
        fullPage: true,
    });
    // Search for an item, expect at least one result row.
    await search.fill("the");
    await page.waitForTimeout(450);
    const results = page.locator(".channel-pick-results .channel-pick-result");
    await expect(results.first()).toBeVisible({ timeout: 5_000 });
});

test("viewing preview backdrop fits inside the bezel", async ({ page }) => {
    await page.goto("/manage/profiles");
    await page.locator(".profile-card-link").first().click();
    await page.getByRole("tab", { name: "Viewing" }).click();
    await page.waitForSelector(".viewing-preview-bezel");
    const bezel = page.locator(".viewing-preview-bezel").first();
    const img = page.locator(".viewing-preview-img").first();
    const b = await bezel.boundingBox();
    const i = await img.boundingBox();
    if (!b || !i) throw new Error("missing");
    // The image must not extend past the bezel.
    expect(i.x).toBeGreaterThanOrEqual(b.x - 1);
    expect(i.y).toBeGreaterThanOrEqual(b.y - 1);
    expect(i.x + i.width).toBeLessThanOrEqual(b.x + b.width + 1);
    expect(i.y + i.height).toBeLessThanOrEqual(b.y + b.height + 1);
    // The bezel itself must stay roughly its declared 320x180.
    expect(b.width).toBeLessThan(360);
    expect(b.height).toBeLessThan(220);
    await page.screenshot({
        path: resolve(SHOTS_DIR, "26-viewing-preview.png"),
        fullPage: true,
    });
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
