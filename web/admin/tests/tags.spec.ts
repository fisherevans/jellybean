import { test, expect, type Page } from "@playwright/test";

// M6 admin UI smoke. Exercises the full tag lifecycle (create, see in
// list, navigate to detail, delete) plus the profile tag rules modal
// that came along with #38. Storage layer + endpoint logic are
// covered by Go tests; this file is about the React surface working
// end-to-end against a real daemon + real Jellyfin.

async function gotoAndWaitReady(page: Page, path: string) {
    await page.goto(path);
    await expect(page.getByRole("link", { name: "Jellybean" })).toBeVisible();
}

// uniqueName returns a tag name unlikely to collide with anything the
// admin has manually created. Each test run generates fresh names so
// re-runs don't bump into UNIQUE-name conflicts left behind by a
// previous failure.
function uniqueName(prefix: string): string {
    return `${prefix}-e2e-${Date.now().toString(36)}`;
}

test.describe("tags admin UI", () => {
    test("tags nav entry is visible", async ({ page }) => {
        await gotoAndWaitReady(page, "/");
        await expect(
            page.getByRole("navigation").getByRole("link", { name: "Tags" }),
        ).toBeVisible();
    });

    test("tags page loads + create modal stacks fields vertically", async ({
        page,
    }) => {
        await gotoAndWaitReady(page, "/tags");
        await expect(page.getByRole("heading", { name: "Tags" })).toBeVisible();

        // Open the modal.
        await page.getByRole("button", { name: "+ Add tag" }).click();
        const modal = page.locator(".modal");
        await expect(modal).toBeVisible();
        await expect(modal.getByRole("heading", { name: "New tag" })).toBeVisible();

        // The styling regression I just fixed: fields should stack
        // vertically inside the modal-form. Check the input is below
        // the label and the textarea is below its own label.
        const nameInput = modal.locator('input[type="text"]');
        const descTextarea = modal.locator("textarea");
        await expect(nameInput).toBeVisible();
        await expect(descTextarea).toBeVisible();

        const nameBox = await nameInput.boundingBox();
        const descBox = await descTextarea.boundingBox();
        expect(nameBox, "name input should have a layout box").not.toBeNull();
        expect(descBox, "description textarea should have a layout box").not.toBeNull();
        // Name input lives above the description textarea.
        expect(nameBox!.y).toBeLessThan(descBox!.y);

        await modal.getByRole("button", { name: "Cancel" }).click();
        await expect(modal).toBeHidden();
    });

    test("full tag lifecycle: create -> appear in list -> open detail -> delete", async ({
        page,
    }) => {
        const name = uniqueName("Adventure");
        const description = "End-to-end exercised tag";

        await gotoAndWaitReady(page, "/tags");

        // Create.
        await page.getByRole("button", { name: "+ Add tag" }).click();
        const modal = page.locator(".modal");
        await modal.locator('input[type="text"]').fill(name);
        await modal.locator("textarea").fill(description);
        await modal.getByRole("button", { name: "Create" }).click();
        await expect(modal).toBeHidden();

        // The new tag should be visible as a link in the list.
        const tagLink = page.getByRole("link", { name });
        await expect(tagLink).toBeVisible();

        // Navigate into detail.
        await tagLink.click();
        await expect(page.getByRole("heading", { name })).toBeVisible();
        await expect(page.getByText(description)).toBeVisible();
        await expect(
            page.getByRole("heading", { name: "Items in this tag" }),
        ).toBeVisible();
        await expect(
            page.getByRole("heading", { name: "Add items" }),
        ).toBeVisible();

        // Delete from the detail page; confirm via the native dialog.
        page.once("dialog", (d) => d.accept());
        await page.getByRole("button", { name: "Delete" }).click();
        await expect(page).toHaveURL(/\/tags$/);
        await expect(page.getByRole("link", { name })).toHaveCount(0);
    });

    test("rename via the rename modal", async ({ page }) => {
        const original = uniqueName("Bedtime");
        const renamed = uniqueName("Bedtime-renamed");

        await gotoAndWaitReady(page, "/tags");

        // Seed a tag to rename.
        await page.getByRole("button", { name: "+ Add tag" }).click();
        const createModal = page.locator(".modal");
        await createModal.locator('input[type="text"]').fill(original);
        await createModal.getByRole("button", { name: "Create" }).click();
        await expect(createModal).toBeHidden();

        // Rename it from the list row.
        const row = page.locator(".tag-row", { hasText: original });
        await row.getByRole("button", { name: "Rename" }).click();
        const editModal = page.locator(".modal");
        await expect(
            editModal.getByRole("heading", { name: new RegExp(`Rename "${original}"`) }),
        ).toBeVisible();
        const nameInput = editModal.locator('input[type="text"]');
        await nameInput.fill(renamed);
        await editModal.getByRole("button", { name: "Save" }).click();
        await expect(editModal).toBeHidden();

        // List reflects the new name; old name is gone.
        await expect(page.getByRole("link", { name: renamed })).toBeVisible();
        await expect(page.getByRole("link", { name: original })).toHaveCount(0);

        // Cleanup.
        const renamedRow = page.locator(".tag-row", { hasText: renamed });
        page.once("dialog", (d) => d.accept());
        await renamedRow.getByRole("button", { name: "Delete" }).click();
        await expect(page.getByRole("link", { name: renamed })).toHaveCount(0);
    });

    test("profile tag rules modal opens and lists tags", async ({ page }) => {
        // Seed one tag so the modal has at least one row to render.
        const tagName = uniqueName("Scary");
        await gotoAndWaitReady(page, "/tags");
        await page.getByRole("button", { name: "+ Add tag" }).click();
        const createModal = page.locator(".modal");
        await createModal.locator('input[type="text"]').fill(tagName);
        await createModal.getByRole("button", { name: "Create" }).click();
        await expect(createModal).toBeHidden();

        // Now open the rules modal on the Default profile. Scoping
        // by `.profile-name` because every profile row's muted line
        // contains "default lang eng" which would match a hasText
        // filter on "Default" too.
        await page.goto("/profiles");
        await expect(page.getByRole("heading", { name: "Profiles" })).toBeVisible();
        const defaultRow = page
            .locator(".profile-row")
            .filter({ has: page.locator(".profile-name", { hasText: /^Default$/ }) });
        await defaultRow.getByRole("button", { name: "Tag rules" }).click();
        const rulesModal = page.locator(".modal");
        await expect(
            rulesModal.getByRole("heading", { name: "Tag rules for Default" }),
        ).toBeVisible();
        await expect(rulesModal.getByText(tagName)).toBeVisible();

        // Three radios per row: None | Always show | Always hide.
        const row = rulesModal.locator(".tag-filter-row", { hasText: tagName });
        await expect(row.getByText("None")).toBeVisible();
        await expect(row.getByText("Always show")).toBeVisible();
        await expect(row.getByText("Always hide")).toBeVisible();

        // Default state is None.
        const noneRadio = row.locator(`input[value="none"]`);
        await expect(noneRadio).toBeChecked();

        // Save button starts disabled (no changes yet).
        await expect(rulesModal.getByRole("button", { name: "Save" })).toBeDisabled();

        // Pick Always hide -> Save enables.
        await row.locator(`input[value="always_hidden"]`).check();
        await expect(rulesModal.getByRole("button", { name: "Save" })).toBeEnabled();
        await rulesModal.getByRole("button", { name: "Save" }).click();

        // Re-read should keep the rule.
        await expect(rulesModal.getByRole("button", { name: "Save" })).toBeDisabled();
        await rulesModal.getByRole("button", { name: "Close" }).click();
        await expect(rulesModal).toBeHidden();

        // Cleanup the seeded tag (this also clears the filter via cascade).
        await page.goto("/tags");
        const tagRow = page.locator(".tag-row", { hasText: tagName });
        page.once("dialog", (d) => d.accept());
        await tagRow.getByRole("button", { name: "Delete" }).click();
        await expect(page.getByRole("link", { name: tagName })).toHaveCount(0);
    });
});
