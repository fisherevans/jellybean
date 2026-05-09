import { test, expect, type Page } from "@playwright/test";

// Validates the sectioned-grid D-pad navigation on Library when sort
// is recently_added / recently_watched. Specifically:
//   - Down always advances by exactly one row, even when the next
//     row is the "short" tail of a section.
//   - From a long row, Down clamps the column to the last item of
//     the short next row.
//   - When a section's last row is exhausted, Down hops to the
//     first row of the next section, clamped to that row's width.
//   - Up is symmetric.
//
// Bug we're guarding against: useGridColumns previously measured
// columns from the FIRST non-empty section's grid. With sectioned
// rendering, that section can be tiny ("Added today" with one item),
// which collapsed the reported column count to 1 and made every
// Down press advance by a single item instead of a full row.

const PROFILE_ID = 5; // Nottingham profile - >400 visible items, plenty for sectioning.

type TileLayout = {
    section: number;
    row: number;
    col: number;
    name: string;
};

// readLayout snapshots every rendered tile's section / row / col by
// reading offsetTop within its parent grid. Done in browser context
// so we get real layout measurements.
async function readLayout(page: Page): Promise<TileLayout[]> {
    return await page.evaluate(() => {
        const sections = Array.from(
            document.querySelectorAll(".kids-section"),
        );
        const out: Array<{
            section: number;
            row: number;
            col: number;
            name: string;
        }> = [];
        sections.forEach((sec, sIdx) => {
            const grid = sec.querySelector(".grid");
            if (!grid) return;
            const tiles = Array.from(grid.children) as HTMLElement[];
            // Group by offsetTop to discover rows.
            const rowKeys: number[] = [];
            const tilesByRow: HTMLElement[][] = [];
            for (const t of tiles) {
                const top = t.offsetTop;
                let rowIdx = rowKeys.findIndex((k) => Math.abs(k - top) < 2);
                if (rowIdx === -1) {
                    rowIdx = rowKeys.length;
                    rowKeys.push(top);
                    tilesByRow.push([]);
                }
                tilesByRow[rowIdx].push(t);
            }
            tilesByRow.forEach((row, rIdx) => {
                row.forEach((t, cIdx) => {
                    const name =
                        t.querySelector(".tile-title-text")?.textContent ?? "";
                    out.push({
                        section: sIdx,
                        row: rIdx,
                        col: cIdx,
                        name,
                    });
                });
            });
        });
        return out;
    });
}

async function focusedTileName(page: Page): Promise<string | null> {
    return await page.evaluate(() => {
        const el = document.querySelector(".tile.focused");
        if (!el) return null;
        return el.querySelector(".tile-title-text")?.textContent ?? null;
    });
}

async function lookupLayout(
    layout: TileLayout[],
    name: string,
): Promise<TileLayout | undefined> {
    return layout.find((l) => l.name === name);
}

// Navigate from "tab nav focused" (page initial state) into the
// first grid tile by pressing Down twice (tab → search → first
// tile). Bails out if the second Down didn't land on a tile.
async function focusFirstTile(page: Page): Promise<void> {
    await page.keyboard.press("ArrowDown"); // tab → search
    await page.keyboard.press("ArrowDown"); // search → first grid tile
    await expect(page.locator(".tile.focused")).toHaveCount(1, {
        timeout: 5_000,
    });
}

// changeSortTo opens the Sort dropdown and selects the named option,
// waiting for the new sections to render.
async function changeSortTo(page: Page, label: string): Promise<void> {
    // Press ArrowDown then ArrowRight to walk from tab → search → filter,
    // then ArrowRight again to land on Sort.
    await page.keyboard.press("ArrowDown"); // tab → search
    await page.keyboard.press("ArrowRight"); // search → filter
    await page.keyboard.press("ArrowRight"); // filter → sort
    await page.keyboard.press("Enter"); // open sort modal
    await expect(page.locator(".alpha-picker-backdrop")).toBeVisible();
    await page.getByRole("button", { name: label, exact: true }).click();
    // Modal closes; wait for at least one section title (recency mode).
    await expect(page.locator(".kids-section-title").first()).toBeVisible({
        timeout: 10_000,
    });
}

test.describe("kids library sectioned-grid D-pad navigation", () => {
    test.beforeEach(async ({ page }) => {
        // Pre-clear localStorage so prior runs don't carry sort/filter
        // preferences over.
        await page.addInitScript(() => {
            try {
                localStorage.removeItem("jellybean.kids.library.sort");
                localStorage.removeItem("jellybean.kids.library.filter");
            } catch {
                /* noop */
            }
        });
        await page.goto(`/player/library?profileId=${PROFILE_ID}`);
        await expect(page.locator(".tile-library").first()).toBeVisible({
            timeout: 15_000,
        });
    });

    test("recently_added: Down advances exactly one row at a time", async ({
        page,
    }) => {
        await changeSortTo(page, "Recently added");
        const layout = await readLayout(page);
        expect(layout.length).toBeGreaterThan(20);

        await focusFirstTile(page);
        let prevName = await focusedTileName(page);
        expect(prevName).not.toBeNull();
        const visited: string[] = [prevName!];

        // Walk Down up to 30 times. Each press must move focus to a
        // tile that is in a STRICTLY LATER row in reading order
        // (section ascending, then row ascending). Pressing Down
        // should never produce two presses landing on tiles within
        // the same row.
        for (let i = 0; i < 30; i++) {
            await page.keyboard.press("ArrowDown");
            const cur = await focusedTileName(page);
            if (cur === null) throw new Error("focus lost");
            const prev = await lookupLayout(layout, prevName!);
            const next = await lookupLayout(layout, cur);
            if (!prev || !next) {
                throw new Error(
                    `tile not in layout snapshot: prev=${prevName} next=${cur}`,
                );
            }
            // Strict reading-order advance: same section + next row,
            // OR later section.
            const advanced =
                next.section > prev.section ||
                (next.section === prev.section && next.row === prev.row + 1);
            expect(
                advanced,
                `Down from "${prevName}" (sec=${prev.section} row=${prev.row} col=${prev.col}) ` +
                    `should advance one row; landed on "${cur}" (sec=${next.section} row=${next.row} col=${next.col})`,
            ).toBe(true);
            visited.push(cur);
            prevName = cur;
        }
        // Sanity: we visited 31 distinct tiles.
        expect(new Set(visited).size).toBe(visited.length);
    });

    test("recently_added: Down clamps column to short next row", async ({
        page,
    }) => {
        await changeSortTo(page, "Recently added");
        const layout = await readLayout(page);

        // Find a section whose last row is shorter than another row
        // in the same section, so we can step from a "wide" row
        // into the short last row.
        const sectionRowCounts = new Map<number, number[]>();
        for (const t of layout) {
            const arr = sectionRowCounts.get(t.section) ?? [];
            arr[t.row] = (arr[t.row] ?? 0) + 1;
            sectionRowCounts.set(t.section, arr);
        }
        let shortStep: { sec: number; lastRow: number; widthOfLastRow: number } | null =
            null;
        for (const [sec, rows] of sectionRowCounts) {
            if (rows.length < 2) continue;
            const last = rows.length - 1;
            if (rows[last] < rows[last - 1]) {
                shortStep = {
                    sec,
                    lastRow: last,
                    widthOfLastRow: rows[last],
                };
                break;
            }
        }
        test.skip(
            !shortStep,
            "no section has a partial last row in this fixture",
        );
        const step = shortStep!;

        // Move focus to the rightmost tile of the second-to-last row
        // of that section.
        const target = layout.find(
            (t) =>
                t.section === step.sec &&
                t.row === step.lastRow - 1 &&
                t.col === step.widthOfLastRow, // first column past the last-row's width
        );
        if (!target) {
            // No "out of bounds" col exists - section's penultimate
            // row isn't wider than its last by much. Pick max col.
            const wide = layout
                .filter(
                    (t) =>
                        t.section === step.sec && t.row === step.lastRow - 1,
                )
                .reduce((a, b) => (a.col > b.col ? a : b));
            // Manually navigate to that tile.
            await navigateTo(page, layout, wide);
            await page.keyboard.press("ArrowDown");
            const cur = await focusedTileName(page);
            const next = layout.find((t) => t.name === cur);
            expect(next?.section).toBe(step.sec);
            expect(next?.row).toBe(step.lastRow);
            expect(next?.col).toBe(Math.min(wide.col, step.widthOfLastRow - 1));
            return;
        }
        await navigateTo(page, layout, target);
        await page.keyboard.press("ArrowDown");
        const cur = await focusedTileName(page);
        const next = layout.find((t) => t.name === cur);
        expect(next?.section).toBe(step.sec);
        expect(next?.row).toBe(step.lastRow);
        // Last item of the short row.
        expect(next?.col).toBe(step.widthOfLastRow - 1);
    });

    test("recently_added: Up is symmetric to Down", async ({ page }) => {
        await changeSortTo(page, "Recently added");
        const layout = await readLayout(page);
        await focusFirstTile(page);

        // Walk Down 10 times, then Up 10 times. End state should
        // be the first tile.
        const startName = await focusedTileName(page);
        for (let i = 0; i < 10; i++) {
            await page.keyboard.press("ArrowDown");
        }
        const downSettled = await focusedTileName(page);
        expect(downSettled).not.toBe(startName);
        for (let i = 0; i < 10; i++) {
            await page.keyboard.press("ArrowUp");
        }
        const back = await focusedTileName(page);
        expect(back).toBe(startName);
        // Quiet the unused `layout` warning for now.
        void layout;
    });

    test("Jump button always says 'Jump' regardless of sort", async ({
        page,
    }) => {
        // Default load is sort=name.
        const jumpBtn = page.locator(".library-jump-btn");
        await expect(jumpBtn).toBeVisible();
        await expect(jumpBtn).toContainText("Jump");

        // Switch to recently_added; the button still says Jump.
        await changeSortTo(page, "Recently added");
        await expect(jumpBtn).toContainText("Jump");
    });
});

// navigateTo walks the focus from wherever it currently is to a
// specific (section, row, col) target by pressing Down/Up to reach
// the row, then Left/Right to reach the column. Limits each leg to
// 100 presses so a buggy implementation can't loop forever.
async function navigateTo(
    page: Page,
    layout: TileLayout[],
    target: TileLayout,
): Promise<void> {
    // Make sure focus is on a grid tile to begin with.
    if ((await focusedTileName(page)) === null) {
        await focusFirstTile(page);
    }
    for (let guard = 0; guard < 200; guard++) {
        const cur = await focusedTileName(page);
        if (cur === target.name) return;
        const here = layout.find((t) => t.name === cur);
        if (!here) {
            throw new Error(`focus on unknown tile: ${cur}`);
        }
        if (here.section < target.section || here.row < target.row) {
            await page.keyboard.press("ArrowDown");
            continue;
        }
        if (here.section > target.section || here.row > target.row) {
            await page.keyboard.press("ArrowUp");
            continue;
        }
        if (here.col < target.col) {
            await page.keyboard.press("ArrowRight");
            continue;
        }
        if (here.col > target.col) {
            await page.keyboard.press("ArrowLeft");
            continue;
        }
        return;
    }
    throw new Error(
        `failed to navigate to (${target.section}, ${target.row}, ${target.col})`,
    );
}
