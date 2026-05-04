import { test, expect, type Page } from "@playwright/test";

// End-to-end smoke tests against a running daemon + the user's real
// Jellyfin. These don't seed the database; they trust whatever state is
// there. Shared assumption: the Default profile exists.

async function gotoAndWaitReady(page: Page, path: string) {
    await page.goto(path);
    // The brand link is rendered by Layout once the user is authenticated;
    // wait for it so we know the SPA hydrated.
    await expect(page.getByRole("link", { name: "Jellybean" })).toBeVisible();
}

test.describe("admin shell", () => {
    test("home loads and shows nav", async ({ page }) => {
        await gotoAndWaitReady(page, "/");
        await expect(page.getByRole("heading", { name: /Welcome/ })).toBeVisible();
        const nav = page.getByRole("navigation");
        for (const label of ["Bulk categorize", "Swipe", "Activity", "Search", "Profiles", "Kids"]) {
            await expect(nav.getByRole("link", { name: label })).toBeVisible();
        }
    });

    test("profile picker is populated", async ({ page }) => {
        await gotoAndWaitReady(page, "/");
        const picker = page.getByLabel("Profile");
        await expect(picker).toBeVisible();
        await expect(picker).toContainText("Default");
    });
});

test.describe("bulk", () => {
    test("loads with three columns and counts", async ({ page }) => {
        await gotoAndWaitReady(page, "/bulk");
        await expect(page.getByRole("heading", { name: "Bulk categorize" })).toBeVisible();

        // Initial fetch can take a while on large libraries (2300+ items).
        // The Loading state disappears once the columns mount; allow up to
        // 30s for that.
        await expect(
            page.getByRole("heading", { name: "Looks visible" }),
        ).toBeVisible({ timeout: 30_000 });
        await expect(page.getByRole("heading", { name: "Needs review" })).toBeVisible();
        await expect(
            page.getByRole("heading", { name: "Looks hidden / not for kids" }),
        ).toBeVisible();

        // Bulk bar exists.
        await expect(page.getByRole("button", { name: /Mark visible/ })).toBeVisible();
        await expect(page.getByRole("button", { name: /Mark hidden/ })).toBeVisible();
    });
});

test.describe("swipe", () => {
    test("loads (queue or empty state)", async ({ page }) => {
        await gotoAndWaitReady(page, "/swipe");
        // Either the queue is empty ("All caught up for X") or there's an
        // item to categorize and the ← Hide / ↓ Skip / Show → buttons are
        // present. Initial fetch can take up to ~10s on a large library
        // (the page shows a spinner while it waits); allow 30s like Bulk.
        const allCaughtUp = page.getByText(/All caught up/);
        const hide = page.getByRole("button", { name: /← Hide/ });
        await expect(allCaughtUp.or(hide)).toBeVisible({ timeout: 30_000 });

        const empty = await allCaughtUp.isVisible().catch(() => false);
        if (empty) return;
        await expect(hide).toBeVisible();
        await expect(page.getByRole("button", { name: /↓ Skip/ })).toBeVisible();
        await expect(page.getByRole("button", { name: /Show →/ })).toBeVisible();
    });
});

test.describe("profiles", () => {
    test("default profile cannot be deleted", async ({ page }) => {
        await gotoAndWaitReady(page, "/profiles");
        await expect(page.getByRole("heading", { name: "Profiles" })).toBeVisible();
        const defaultRow = page.locator("li").filter({ hasText: "Default" }).first();
        await expect(defaultRow).toBeVisible();
        const delBtn = defaultRow.getByRole("button", { name: "Delete" });
        await expect(delBtn).toBeDisabled();
    });

    test("create + delete a temporary profile", async ({ page }) => {
        await gotoAndWaitReady(page, "/profiles");
        const tempName = `e2e-temp-${Date.now()}`;
        // Profile create now happens through a modal opened by "+ Add profile".
        await page.getByRole("button", { name: /\+ Add profile/ }).click();
        const modal = page.locator(".modal");
        await expect(modal).toBeVisible();
        await modal.locator("input").first().fill(tempName);
        await modal.getByRole("button", { name: "Create" }).click();
        const row = page.locator("li").filter({ hasText: tempName });
        await expect(row).toBeVisible();
        page.once("dialog", (d) => d.accept());
        await row.getByRole("button", { name: "Delete" }).click();
        await expect(row).toHaveCount(0);
    });
});

test.describe("activity", () => {
    test("loads", async ({ page }) => {
        await gotoAndWaitReady(page, "/activity");
        await expect(page.getByRole("heading", { name: "Recent activity" })).toBeVisible();
    });
});

test.describe("search", () => {
    test("loads + reacts to typing", async ({ page }) => {
        await gotoAndWaitReady(page, "/search");
        await expect(page.getByRole("heading", { name: "Search" })).toBeVisible();
        await page.getByPlaceholder(/Type a title/).fill("the");
        // Either matches or an empty-state message; both are fine outcomes
        // for "the" against an arbitrary library.
        await expect(
            page.getByText(/Showing|No matches|Searching/),
        ).toBeVisible({ timeout: 5_000 });
    });
});
