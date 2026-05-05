import { test, expect } from "@playwright/test";

// M15 #96: profile channels admin UI - list, create, persist, delete.

test.describe("profile channels", () => {
    test("create + list + delete a channel", async ({ page }) => {
        await page.goto("/profiles");
        const defaultRow = page
            .locator("li")
            .filter({ has: page.locator(".profile-name", { hasText: /^Default$/ }) });
        await defaultRow.getByRole("button", { name: "Channels" }).click();
        await expect(page.getByRole("heading", { name: /^Channels/ })).toBeVisible();
        await page.getByRole("button", { name: /Add channel/ }).click();
        await expect(page.getByRole("heading", { name: /Add channel/ })).toBeVisible();

        await page.getByLabel("Name").fill("Saturday Morning");
        await page.getByLabel("Sort order").selectOption("round_robin_tags");
        await page.getByLabel(/Explicit item ids/).fill("item-a\nitem-b");
        await page.locator(".modal-actions button.primary").click();

        await expect(page.locator(".modes-list-row")).toContainText("Saturday Morning");

        page.on("dialog", (d) => d.accept());
        await page
            .locator(".modes-list-row")
            .filter({ hasText: "Saturday Morning" })
            .getByRole("button", { name: "Delete" })
            .click();
        await expect(page.locator(".modes-list-row")).not.toBeVisible();
    });
});
