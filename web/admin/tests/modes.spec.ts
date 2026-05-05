import { test, expect } from "@playwright/test";

// M13 #86: profile modes admin UI - list, create, persist, delete.

test.describe("profile modes", () => {
    test("create + list + delete a mode", async ({ page }) => {
        await page.goto("/profiles");
        const defaultRow = page
            .locator("li")
            .filter({ has: page.locator(".profile-name", { hasText: /^Default$/ }) });
        await defaultRow.getByRole("button", { name: "Modes" }).click();
        await expect(page.getByRole("heading", { name: /^Modes/ })).toBeVisible();
        await page.getByRole("button", { name: /Add mode/ }).click();
        await expect(page.getByRole("heading", { name: /Add mode/ })).toBeVisible();

        await page.getByLabel("Name").fill("E2E Bedtime");
        await page.getByLabel("Start time (HH:MM 24h)").fill("21:00");
        await page.getByLabel(/End time/).fill("06:30");
        await page.getByLabel("Theme").selectOption("bedtime");
        await page.locator(".modal-actions button.primary").click();

        await expect(page.locator(".modes-list-row")).toContainText("E2E Bedtime");

        // Delete via the confirm prompt.
        page.on("dialog", (d) => d.accept());
        await page
            .locator(".modes-list-row")
            .filter({ hasText: "E2E Bedtime" })
            .getByRole("button", { name: "Delete" })
            .click();
        await expect(page.locator(".modes-list-row")).not.toBeVisible();
    });
});
