import { test, expect, type Page } from "@playwright/test";

// M8 admin UI smoke. Exercises the layout list + editor without
// drag-and-drop (which we deferred). Self-cleans created layouts so
// re-runs are stable.

async function gotoAndWaitReady(page: Page, path: string) {
    await page.goto(path);
    await expect(page.getByRole("link", { name: "Jellybean" })).toBeVisible();
}

function uniqueName(prefix: string): string {
    return `${prefix}-e2e-${Date.now().toString(36)}`;
}

test.describe("layouts admin UI", () => {
    test("layouts nav entry is visible", async ({ page }) => {
        await gotoAndWaitReady(page, "/");
        await expect(
            page.getByRole("navigation").getByRole("link", { name: "Layouts" }),
        ).toBeVisible();
    });

    test("layouts list page loads with seeded Default", async ({ page }) => {
        await gotoAndWaitReady(page, "/layouts");
        await expect(page.getByRole("heading", { name: "Layouts" })).toBeVisible();
        // Seeded default layout is always present.
        await expect(page.getByRole("link", { name: /Default/ })).toBeVisible();
    });

    test("create layout, append rows of every type, delete layout", async ({
        page,
    }) => {
        const name = uniqueName("BrowseTest");
        await gotoAndWaitReady(page, "/layouts");

        // Create.
        await page.getByRole("button", { name: "+ New layout" }).click();
        const createModal = page.locator(".modal");
        await expect(createModal).toBeVisible();
        await createModal.getByLabel("Name").fill(name);
        await createModal.getByRole("button", { name: "Create" }).click();
        await expect(createModal).toBeHidden();

        // List should now have it.
        const link = page.getByRole("link", { name: new RegExp(`^${name}$`) });
        await expect(link).toBeVisible();
        await link.click();
        await expect(page.getByRole("heading", { name })).toBeVisible();
        await expect(
            page.getByText("No rows yet. Click \"+ Add row\" to get started."),
        ).toBeVisible();

        // Append a continue_watching row (simplest type).
        await page.getByRole("button", { name: "+ Add row" }).click();
        let editor = page.locator(".modal");
        await expect(editor).toBeVisible();
        // Type defaults to continue_watching; just save.
        await editor.getByRole("button", { name: "Add" }).click();
        await expect(editor).toBeHidden();
        await expect(page.locator(".layout-row-card")).toHaveCount(1);
        await expect(
            page.locator(".layout-row-card .layout-row-title"),
        ).toHaveText("Continue Watching");

        // Append a tag_fanout row to exercise the per-type config UI.
        await page.getByRole("button", { name: "+ Add row" }).click();
        editor = page.locator(".modal");
        await editor.locator('select').first().selectOption("tag_fanout");
        // The fanout config UI should now show two TagMultiPicker
        // fieldsets + the row_order + within_row_sort selects.
        await expect(editor.getByText("Include tags (empty = all)")).toBeVisible();
        await expect(editor.getByText("Exclude tags")).toBeVisible();
        await expect(editor.getByText("Row order")).toBeVisible();
        await editor.getByRole("button", { name: "Add" }).click();
        await expect(editor).toBeHidden();

        // Now move the second row up so it becomes first.
        const rows = page.locator(".layout-row-card");
        await expect(rows).toHaveCount(2);
        await rows.nth(1).getByRole("button", { name: "Move up" }).click();
        // The card at index 0 should now show "Tag fanout..." in its
        // title (also appears in the type label - assert specifically
        // on the title element to avoid strict-mode collision).
        await expect(rows.nth(0).locator(".layout-row-title")).toContainText(
            "Tag fanout",
        );

        // Edit the now-second row's title.
        await rows.nth(1).getByRole("button", { name: "Edit" }).click();
        editor = page.locator(".modal");
        await editor.getByLabel("Title (optional)").fill("Pick Up Where You Left Off");
        await editor.getByRole("button", { name: "Save" }).click();
        await expect(editor).toBeHidden();
        await expect(page.getByText("Pick Up Where You Left Off")).toBeVisible();

        // Delete the row, confirming the dialog.
        page.once("dialog", (d) => d.accept());
        await page.locator(".layout-row-card")
            .filter({ hasText: "Pick Up Where You Left Off" })
            .getByRole("button", { name: "Delete" })
            .click();
        await expect(
            page.getByText("Pick Up Where You Left Off"),
        ).toHaveCount(0);

        // Cleanup: delete the whole layout via the header button.
        page.once("dialog", (d) => d.accept());
        await page.getByRole("button", { name: "Delete" }).first().click();
        await expect(page).toHaveURL(/\/layouts$/);
        await expect(
            page.getByRole("link", { name: new RegExp(`^${name}$`) }),
        ).toHaveCount(0);
    });

    test("default layout cannot be deleted", async ({ page }) => {
        await gotoAndWaitReady(page, "/layouts");
        const defaultRow = page
            .locator(".profile-row")
            .filter({ has: page.locator(".profile-name", { hasText: /Default/ }) });
        const deleteBtn = defaultRow.getByRole("button", { name: "Delete" });
        await expect(deleteBtn).toBeDisabled();
    });

    test("profile settings shows the Browse layout dropdown", async ({ page }) => {
        await gotoAndWaitReady(page, "/profiles");
        await page.getByRole("link", { name: /Default/ }).click();
        await expect(page).toHaveURL(/\/profiles\/\d+/);
        // Basic tab is the default; the Browse layout select lives there.
        await expect(page.getByLabel("Browse layout")).toBeVisible();
    });
});
