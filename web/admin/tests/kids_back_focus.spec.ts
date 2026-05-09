import { test, expect, type Page } from "@playwright/test";

// Validates the back-then-down focus reset on Library + Browse.
//
// Contract (matches user's stated expectation):
//   1. Pressing Back from any content tile must:
//      a. Move DOM focus to the active tab pill button.
//      b. Scroll the page (or stack) all the way back to the top.
//      c. Clear any visual `.focused` class on tiles.
//   2. Pressing Down from the tab nav after a Back must:
//      a. Land on the page's "first content position" (search wrap on
//         Library, first tile on Browse) - the equivalent of a fresh
//         page load, NOT the previously-focused tile / row.
//
// We exercise both pages via the bridge handler (window.__jellybeanBack)
// since the in-browser back-button path is what the Kotlin shell calls.
//
// PROFILE_ID 5 (Nottingham) has 400+ items so the grid is deep enough
// that arrow-down 4-5 times scrolls the body off the top.

const PROFILE_ID = 5;

async function pressBack(page: Page): Promise<boolean> {
    return await page.evaluate(() => {
        const fn = (window as unknown as { __jellybeanBack?: () => boolean })
            .__jellybeanBack;
        return fn ? fn() : false;
    });
}

async function scrollY(page: Page): Promise<number> {
    return await page.evaluate(() => window.scrollY);
}

// stackTranslateY reads the negated translateY of a transform-based
// stack, returning a positive number representing how far the kid
// has scrolled down. Library / Tags / Browse all use a transform on
// a wrapper element (.kids-stack or .browse-stack) instead of body
// scroll because window.scrollTo on this WebView triggers a full
// repaint per call. Tests need to read the stack's transform to
// know "how far down is the kid."
async function stackScrollAmount(
    page: Page,
    selector: string,
): Promise<number> {
    return await page.evaluate((sel) => {
        const el = document.querySelector(sel) as HTMLElement | null;
        if (!el) return 0;
        const m = new DOMMatrixReadOnly(getComputedStyle(el).transform);
        // translate3d(0, -120, 0) means content moved up 120px ->
        // kid is scrolled 120px down. Return as positive.
        return -m.f;
    }, selector);
}

async function activeElementInfo(page: Page): Promise<{
    tag: string;
    cls: string;
    text: string;
}> {
    return await page.evaluate(() => {
        const el = document.activeElement as HTMLElement | null;
        if (!el) return { tag: "", cls: "", text: "" };
        return {
            tag: el.tagName,
            cls: el.className || "",
            text: (el.textContent ?? "").trim().slice(0, 80),
        };
    });
}

test.describe("kids back-then-down focus reset", () => {
    test("Library: back from a deep tile lands on tab nav, scroll resets, next Down lands on search", async ({
        page,
    }) => {
        await page.goto(`/player/library?profileId=${PROFILE_ID}`);
        await expect(page.locator(".tile-library").first()).toBeVisible({
            timeout: 15_000,
        });

        // Walk into the grid. ArrowDown #1: tab → search. #2: search → tile (0,0).
        // Then keep going down so we end up several rows in.
        await page.keyboard.press("ArrowDown");
        await page.keyboard.press("ArrowDown");
        for (let i = 0; i < 5; i++) await page.keyboard.press("ArrowDown");
        // Sanity: focus is on a tile and the stack has scrolled into
        // the grid (Library uses transform-based scroll on
        // .library-stack, not body scroll).
        await expect(page.locator(".tile.focused")).toHaveCount(1);
        const deepScroll = await stackScrollAmount(page, ".library-stack");
        expect(
            deepScroll,
            `expected stack scrolled into the grid; got translateY=${deepScroll}`,
        ).toBeGreaterThan(80);

        // Press Back. Tab pill should regain DOM focus, stack should
        // reset to the top, and no tile should retain `.focused`.
        const consumed = await pressBack(page);
        expect(consumed).toBe(true);
        await page.waitForFunction(
            () => {
                const el = document.querySelector(
                    ".library-stack",
                ) as HTMLElement | null;
                if (!el) return false;
                const m = new DOMMatrixReadOnly(
                    getComputedStyle(el).transform,
                );
                return Math.abs(m.f) < 1;
            },
            undefined,
            { timeout: 2_000 },
        );
        await expect(page.locator(".tile.focused")).toHaveCount(0);
        const tabActive = page.locator(
            ".kids-tabpill-tab.active",
        );
        await expect(tabActive).toBeFocused();

        // Next Down: from tab → page content. The user expectation is
        // "fresh page load" — Library's first content slot is the
        // search wrap, NOT the previously-focused tile.
        await page.keyboard.press("ArrowDown");
        // Library's focus DOM-management focuses the search wrap.
        await expect(
            page.locator(".library-search-wrap.focused"),
        ).toBeVisible({ timeout: 2_000 });
        // Defensive: no tile should be focused at this moment.
        await expect(page.locator(".tile.focused")).toHaveCount(0);
    });

    test("Library: filter dropdown isn't restored after back", async ({
        page,
    }) => {
        // If the kid was on the filter pill (right of search) and pressed
        // Back, we still want a fresh "first position" (search wrap) on
        // the next Down — not the filter pill they were last on.
        await page.goto(`/player/library?profileId=${PROFILE_ID}`);
        await expect(page.locator(".tile-library").first()).toBeVisible({
            timeout: 15_000,
        });
        await page.keyboard.press("ArrowDown"); // tab → search
        await page.keyboard.press("ArrowRight"); // search → filter
        await expect(
            page
                .locator(".library-dropdown-btn.focused")
                .filter({ hasText: "Filter:" }),
        ).toBeVisible();
        await pressBack(page);
        await expect(page.locator(".kids-tabpill-tab.active")).toBeFocused();
        await page.keyboard.press("ArrowDown");
        await expect(
            page.locator(".library-search-wrap.focused"),
        ).toBeVisible();
    });

    test("Browse: back from a deep tile lands on tab nav, stack resets, next Down lands on row 0 col 0", async ({
        page,
    }) => {
        await page.goto(`/player/browse?profileId=${PROFILE_ID}`);
        // Wait for at least one row of tiles to render.
        await expect(page.locator(".tile-browse").first()).toBeVisible({
            timeout: 15_000,
        });

        // ArrowDown twice: tab → row 0; row 0 → row 1.
        await page.keyboard.press("ArrowDown");
        await page.keyboard.press("ArrowDown");
        await page.keyboard.press("ArrowDown");
        // Verify a tile has focus and we're at row > 0.
        const focusedRow = await page.evaluate(() => {
            const el = document.querySelector(".tile.focused");
            if (!el) return -1;
            const row = el.closest(".browse-row") as HTMLElement | null;
            const all = Array.from(document.querySelectorAll(".browse-row"));
            return row ? all.indexOf(row) : -1;
        });
        expect(
            focusedRow,
            "expected focus to be in a row past row 0",
        ).toBeGreaterThan(0);

        // Browse uses a transform on .browse-stack rather than body
        // scroll, so check the stack's transform Y component.
        const stackY = await page.evaluate(() => {
            const stack = document.querySelector(
                ".browse-stack",
            ) as HTMLElement | null;
            if (!stack) return 0;
            const m = new DOMMatrixReadOnly(getComputedStyle(stack).transform);
            return m.f; // y translation
        });
        expect(
            stackY,
            `expected stack translated up; got translateY=${stackY}`,
        ).toBeLessThan(0);

        // Press Back: tab pill focused, stack should snap to 0.
        const consumed = await pressBack(page);
        expect(consumed).toBe(true);
        await page.waitForFunction(
            () => {
                const stack = document.querySelector(
                    ".browse-stack",
                ) as HTMLElement | null;
                if (!stack) return false;
                const m = new DOMMatrixReadOnly(
                    getComputedStyle(stack).transform,
                );
                return Math.abs(m.f) < 1;
            },
            undefined,
            { timeout: 2_000 },
        );
        await expect(page.locator(".tile.focused")).toHaveCount(0);
        await expect(page.locator(".kids-tabpill-tab.active")).toBeFocused();

        // Next Down: should land on the FIRST tile (row 0 col 0), not
        // the previously-focused tile.
        await page.keyboard.press("ArrowDown");
        await expect(page.locator(".tile.focused")).toHaveCount(1, {
            timeout: 2_000,
        });
        const landedRow = await page.evaluate(() => {
            const el = document.querySelector(".tile.focused");
            if (!el) return -1;
            const row = el.closest(".browse-row") as HTMLElement | null;
            const all = Array.from(document.querySelectorAll(".browse-row"));
            return row ? all.indexOf(row) : -1;
        });
        expect(landedRow, "Down after Back should land on row 0").toBe(0);
    });

    test("Tags: back from a deep card lands on tab nav, scroll resets, next Down lands on first card", async ({
        page,
    }) => {
        // Fresh session storage so the saved focusIdx from a prior
        // run doesn't pre-select a card on mount.
        await page.addInitScript(() => {
            try {
                for (const k of Object.keys(sessionStorage)) {
                    if (k.startsWith("jellybean.kids.tags."))
                        sessionStorage.removeItem(k);
                }
            } catch {
                /* noop */
            }
        });
        await page.goto(`/player/tags?profileId=${PROFILE_ID}`);
        await expect(page.locator(".kids-tag-card").first()).toBeVisible({
            timeout: 15_000,
        });

        // Walk into the list. ArrowDown #1: tab → first card. Then
        // a few more downs to reach a card past the first row.
        await page.keyboard.press("ArrowDown");
        for (let i = 0; i < 4; i++) await page.keyboard.press("ArrowDown");
        await expect(page.locator(".kids-tag-card.focused")).toHaveCount(1);
        const deepScroll = await stackScrollAmount(page, ".kids-tags-stack");
        expect(
            deepScroll,
            `expected stack scrolled into the tag list; got translateY=${deepScroll}`,
        ).toBeGreaterThan(80);

        // Back: tab pill focused, stack reset to 0, no card focused.
        const consumed = await pressBack(page);
        expect(consumed).toBe(true);
        await page.waitForFunction(
            () => {
                const el = document.querySelector(
                    ".kids-tags-stack",
                ) as HTMLElement | null;
                if (!el) return false;
                const m = new DOMMatrixReadOnly(
                    getComputedStyle(el).transform,
                );
                return Math.abs(m.f) < 1;
            },
            undefined,
            { timeout: 2_000 },
        );
        await expect(page.locator(".kids-tag-card.focused")).toHaveCount(0);
        await expect(page.locator(".kids-tabpill-tab.active")).toBeFocused();

        // Next Down lands on the FIRST card, not the previously
        // selected one.
        await page.keyboard.press("ArrowDown");
        const firstFocused = await page.evaluate(() => {
            const cards = Array.from(
                document.querySelectorAll(".kids-tag-card"),
            );
            const focused = document.querySelector(".kids-tag-card.focused");
            return focused ? cards.indexOf(focused) : -1;
        });
        expect(firstFocused, "Down after Back should land on card 0").toBe(0);
    });

    test("TagDetail: back navigates to /tags with the entered tag re-highlighted", async ({
        page,
    }) => {
        // expectBackFromDetail path: the kid clicks a tag, navigates
        // into the detail view, then presses Back. They land on
        // /tags with the same card highlighted. This is the one
        // case where "back returns to the previous selection" is
        // intentional - the kid hasn't left the tags context.
        await page.addInitScript(() => {
            try {
                for (const k of Object.keys(sessionStorage)) {
                    if (k.startsWith("jellybean.kids.tags."))
                        sessionStorage.removeItem(k);
                }
            } catch {
                /* noop */
            }
        });
        await page.goto(`/player/tags?profileId=${PROFILE_ID}`);
        await expect(page.locator(".kids-tag-card").first()).toBeVisible({
            timeout: 15_000,
        });

        // Walk to the third card and enter it.
        await page.keyboard.press("ArrowDown"); // tab → card 0
        await page.keyboard.press("ArrowDown");
        await page.keyboard.press("ArrowDown");
        const enteredTagText = await page.evaluate(
            () =>
                document.querySelector(".kids-tag-card.focused")
                    ?.textContent ?? "",
        );
        await page.keyboard.press("Enter");
        await expect(page).toHaveURL(/\/player\/tags\/\d+/, {
            timeout: 5_000,
        });

        // Walk down through the detail grid.
        await expect(page.locator(".tile-library").first()).toBeVisible({
            timeout: 15_000,
        });
        for (let i = 0; i < 4; i++) await page.keyboard.press("ArrowDown");

        // Back: should land back on /tags with the same tag card
        // restored as the highlighted card.
        const consumed = await pressBack(page);
        expect(consumed).toBe(true);
        await expect(page).toHaveURL(/\/player\/tags(\?|$)/, {
            timeout: 5_000,
        });
        await expect(page.locator(".kids-tag-card.focused")).toHaveCount(1, {
            timeout: 5_000,
        });
        const restoredTagText = await page.evaluate(
            () =>
                document.querySelector(".kids-tag-card.focused")
                    ?.textContent ?? "",
        );
        expect(restoredTagText.length).toBeGreaterThan(0);
        expect(restoredTagText).toBe(enteredTagText);
    });

    test("Library: rapid Back press from deep grid resets scroll consistently", async ({
        page,
    }) => {
        // Repro for "sometimes it doesn't scroll back to the top".
        // We exercise Back several times back-to-back across different
        // grid depths and assert scrollY is always 0 after each.
        await page.goto(`/player/library?profileId=${PROFILE_ID}`);
        await expect(page.locator(".tile-library").first()).toBeVisible({
            timeout: 15_000,
        });

        for (const depth of [3, 6, 10, 4]) {
            await page.keyboard.press("ArrowDown"); // tab → search
            await page.keyboard.press("ArrowDown"); // search → tile (0,0)
            for (let i = 0; i < depth; i++)
                await page.keyboard.press("ArrowDown");
            const beforeBack = await stackScrollAmount(page, ".library-stack");
            expect(beforeBack).toBeGreaterThan(0);
            await pressBack(page);
            await page.waitForFunction(
                () => {
                    const el = document.querySelector(
                        ".library-stack",
                    ) as HTMLElement | null;
                    if (!el) return false;
                    const m = new DOMMatrixReadOnly(
                        getComputedStyle(el).transform,
                    );
                    return Math.abs(m.f) < 1;
                },
                undefined,
                { timeout: 2_000 },
            );
            expect(
                await stackScrollAmount(page, ".library-stack"),
                `depth=${depth}`,
            ).toBeLessThan(1);
            await expect(
                page.locator(".kids-tabpill-tab.active"),
            ).toBeFocused();
        }
    });
});
