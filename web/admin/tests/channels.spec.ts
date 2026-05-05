import { test, expect } from "@playwright/test";

// Profile channels via settings page. Sort order is now a pill-toggle
// segmented control (was a select).

test.describe("profile channels", () => {
    test("create + delete via settings page", async ({ page }) => {
        await page.goto("/profiles");
        await page.getByRole("link", { name: /Default/ }).click();
        await page.getByRole("tab", { name: "Channels" }).click();

        await page.getByRole("button", { name: /Add channel/ }).click();
        await expect(page.getByText("New channel")).toBeVisible();

        await page.getByLabel("Name").fill("Saturday Morning");

        // Sort order is a pill-toggle group inside the Sort order
        // fieldset. Click the "Round-robin" pill.
        await page
            .locator(".pill-fieldset")
            .filter({ hasText: "Sort order" })
            .locator(".pill-toggle")
            .filter({ hasText: "Round-robin" })
            .click();

        await page.getByLabel(/Explicit item ids/).fill("item-a\nitem-b");
        await page.getByRole("button", { name: /^Save/ }).click();

        const created = page
            .locator(".modes-list-row")
            .filter({ hasText: "Saturday Morning" });
        await expect(created).toBeVisible();

        page.on("dialog", (d) => d.accept());
        await created.getByRole("button", { name: "Delete" }).click();
        await expect(created).not.toBeVisible();
    });
});
