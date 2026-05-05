import { test, expect } from "@playwright/test";

// Profile channels via the new settings page.

test.describe("profile channels", () => {
    test("create + delete via settings page", async ({ page }) => {
        await page.goto("/profiles");
        await page.getByRole("link", { name: /Default/ }).click();
        await page.getByRole("tab", { name: "Channels" }).click();

        await page.getByRole("button", { name: /Add channel/ }).click();
        await expect(page.getByText("New channel")).toBeVisible();

        await page.getByLabel("Name").fill("Saturday Morning");
        await page.getByLabel("Sort order").selectOption("round_robin_tags");
        await page.getByLabel(/Explicit item ids/).fill("item-a\nitem-b");
        await page.getByRole("button", { name: /^Save/ }).click();

        await expect(page.locator(".modes-list-row")).toContainText(
            "Saturday Morning",
        );

        page.on("dialog", (d) => d.accept());
        await page
            .locator(".modes-list-row")
            .filter({ hasText: "Saturday Morning" })
            .getByRole("button", { name: "Delete" })
            .click();
        await expect(page.locator(".modes-list-row")).not.toBeVisible();
    });
});
