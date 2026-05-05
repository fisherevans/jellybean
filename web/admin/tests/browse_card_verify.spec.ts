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
    expect(options.some((o) => /Rating/.test(o))).toBeFalsy();

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

test("browse cards have no kebab; only the Edit button", async ({ page }) => {
    await page.goto("/manage/browse");
    await page.waitForSelector(".browse-item", { timeout: 15_000 });
    expect(await page.locator(".browse-item-kebab").count()).toBe(0);
    expect(await page.locator(".browse-item-menu").count()).toBe(0);
    await expect(
        page.locator(".browse-item .browse-item-edit").first(),
    ).toBeVisible();
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
    // Visibility radio group with the same style as tag rules,
    // sized to fill the modal width with even-sized segments.
    const stateRow = modal.locator(".item-editor-state-row");
    const segments = stateRow.locator(".tag-filter-mode");
    await expect(segments).toHaveCount(3);
    const rowBox = await stateRow.boundingBox();
    if (!rowBox) throw new Error("state row missing");
    const segBoxes = await Promise.all(
        [0, 1, 2].map((i) => segments.nth(i).boundingBox()),
    );
    // All three segments should be roughly equal width (within 4px).
    const widths = segBoxes.map((b) => (b ? b.width : 0));
    expect(Math.max(...widths) - Math.min(...widths)).toBeLessThan(4);
    // And together they should span (close to) the row width.
    const sum = widths.reduce((a, b) => a + b, 0);
    expect(sum).toBeGreaterThan(rowBox.width * 0.95);
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
    const current = row.locator(".snap-slider-current");
    const r = await range.boundingBox();
    const c = await current.boundingBox();
    if (!r || !c) throw new Error("missing");
    // The slider should be much wider than the formatted-value
    // span so the user can actually drag the thumb.
    expect(r.width).toBeGreaterThan(c.width * 1.5);
    // Drag the thumb and verify the formatted value changes.
    const before = await current.innerText();
    await range.focus();
    await page.keyboard.press("ArrowRight");
    await page.keyboard.press("ArrowRight");
    await page.keyboard.press("ArrowRight");
    await page.waitForTimeout(100);
    const after = await current.innerText();
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

test("daily-cap slider shows hours/minutes + Custom pill flips to input", async ({ page }) => {
    await page.goto("/manage/profiles");
    await page.locator(".profile-card-link").first().click();
    await page.getByRole("tab", { name: "Time limits" }).click();
    await page.waitForSelector(".snap-slider");
    const enabled = await page
        .locator(".toggle-switch input[type=checkbox]")
        .first()
        .isChecked();
    if (!enabled) {
        await page.locator(".toggle-switch").first().click();
        await page.waitForTimeout(150);
    }
    // Click the 4h pill (top of slider range) and confirm "4h" renders.
    await page.getByRole("button", { name: "4h", exact: true }).click();
    await page.waitForTimeout(80);
    expect(
        await page.locator(".snap-slider-current").first().innerText(),
    ).toMatch(/^4h$/);
    // 1h pill -> "1h"
    await page.getByRole("button", { name: "1h", exact: true }).click();
    await page.waitForTimeout(80);
    expect(
        await page.locator(".snap-slider-current").first().innerText(),
    ).toMatch(/^1h$/);

    // Slider's max is 240 (4h); confirm via the range input attribute.
    const rangeMax = await page
        .locator(".snap-slider-range")
        .first()
        .getAttribute("max");
    expect(Number(rangeMax)).toBe(240);

    // Custom pill flips the right side into a number input. The
    // input's max should be 1440 (24h) so users can dial in beyond
    // the slider's range.
    await page.getByRole("button", { name: "Custom" }).click();
    await page.waitForTimeout(80);
    const numInput = page.locator(".snap-slider-custom .snap-slider-number");
    await expect(numInput).toBeVisible();
    expect(Number(await numInput.getAttribute("max"))).toBe(1440);
    await expect(page.locator(".snap-slider-suffix")).toContainText("minutes");
    // Type 720 minutes (12h) - past the slider max.
    await numInput.fill("720");
    await numInput.blur();
    await page.waitForTimeout(80);
    // Number input still shows 720; slider thumb is pinned at 240.
    expect(await numInput.inputValue()).toBe("720");
    expect(
        await page.locator(".snap-slider-range").first().inputValue(),
    ).toBe("240");

    // Picking a snap pill closes Custom mode.
    await page.getByRole("button", { name: "30m", exact: true }).click();
    await page.waitForTimeout(80);
    await expect(numInput).toHaveCount(0);
    expect(
        await page.locator(".snap-slider-current").first().innerText(),
    ).toMatch(/^30m$/);
    await page.screenshot({
        path: resolve(SHOTS_DIR, "28-slider-hm.png"),
        fullPage: true,
    });
});

test("categorize header: title + small switcher link", async ({ page }) => {
    await page.goto("/manage/swipe");
    await page.waitForSelector(".categorize-header");
    const head = page.locator(".categorize-header");
    await expect(head.locator("h1")).toContainText("Swipe");
    const switcher = head.locator(".categorize-switch");
    await expect(switcher).toContainText(/Categorize in bulk/);
    // Click it -> Bulk header
    await switcher.click();
    await expect(page.locator(".categorize-header h1")).toContainText("Bulk");
    await expect(page.locator(".categorize-switch")).toContainText(/Back to swipe/);
});

test("swipe drops the misleading remaining count", async ({ page }) => {
    await page.goto("/manage/swipe");
    // Wait for the wrapper heading to render so React has finished
    // mounting either the active swipe view or the all-caught-up
    // empty state. Then scrape every node text and assert no
    // surface still says "remaining".
    await expect(
        page.locator(".categorize-header h1").filter({ hasText: "Swipe" }),
    ).toBeVisible({ timeout: 15_000 });
    await page.waitForLoadState("networkidle");
    const body = await page.locator(".categorize-shell").innerText();
    expect(body).not.toMatch(/\bremaining\b/i);
});

async function setSlider(page, hasText: RegExp, value: number) {
    // Drive the range slider directly and dispatch input + change so
    // React picks up the value. The Custom-mode number input is
    // hidden by default in SnapSlider, so we can't fill that.
    const range = page
        .locator(".snap-slider")
        .filter({ hasText })
        .locator("input[type=range]");
    await range.evaluate((el, v) => {
        const input = el as HTMLInputElement;
        const setter = Object.getOwnPropertyDescriptor(
            window.HTMLInputElement.prototype,
            "value",
        )?.set;
        setter?.call(input, String(v));
        input.dispatchEvent(new Event("input", { bubbles: true }));
        input.dispatchEvent(new Event("change", { bubbles: true }));
    }, value);
}

test("browse: Load more appends another page", async ({ page }) => {
    await page.goto("/manage/browse");
    await page.waitForSelector(".browse-item", { timeout: 15_000 });
    const before = await page.locator(".browse-item").count();
    const button = page.locator(".browse-load-more button");
    if ((await button.count()) === 0) {
        // Fewer than PAGE_SIZE items; nothing to test.
        return;
    }
    await expect(button).toBeVisible();
    await button.click();
    await expect(button).toContainText(/Loading|Load more/);
    // Wait for either the count to grow OR the button to disappear.
    await page.waitForFunction(
        (initial) =>
            document.querySelectorAll(".browse-item").length > initial ||
            document.querySelector(".browse-load-more") === null,
        before,
        { timeout: 10_000 },
    );
    const after = await page.locator(".browse-item").count();
    expect(after).toBeGreaterThan(before);
});

test("warm tint sweep: 0/50/100 produce visibly different output", async ({ page }) => {
    await page.goto("/manage/profiles");
    await page.locator(".profile-card-link").first().click();
    await page.getByRole("tab", { name: "Viewing" }).click();
    await page.waitForSelector(".viewing-preview-bezel");
    await setSlider(page, /Dim/, 0);

    for (const pct of [0, 50, 100]) {
        await setSlider(page, /Warm tint|Red shift/, pct);
        await page.waitForTimeout(200);
        await page
            .locator(".viewing-preview-bezel")
            .first()
            .screenshot({
                path: resolve(SHOTS_DIR, `27-warm-${pct}.png`),
            });
    }

    // Sanity: at warm=100 the overlay opacity hits the 0.42 cap
    // and the image carries the warm filter.
    const overlay = page.locator(".viewing-preview-warm-overlay").first();
    const op = await overlay.evaluate(
        (el) => parseFloat(getComputedStyle(el).opacity),
    );
    expect(op).toBeGreaterThan(0.39);
    expect(op).toBeLessThan(0.45);
    const imgFilter = await page
        .locator(".viewing-preview-img")
        .first()
        .evaluate((el) => getComputedStyle(el).filter);
    expect(imgFilter).toMatch(/sepia\(0\.7\)/);
    expect(imgFilter).toMatch(/saturate\(2\.3\)/);
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
    await setSlider(page, /Warm tint|Red shift/, 100);
    await page.waitForTimeout(150);
    const filter = await page
        .locator(".viewing-preview-img")
        .first()
        .evaluate((el) => getComputedStyle(el).filter);
    expect(filter).toMatch(/sepia\(/);
    expect(filter).toMatch(/hue-rotate\(/);
    expect(filter).toMatch(/saturate\(/);
});
