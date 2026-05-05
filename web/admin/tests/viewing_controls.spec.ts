import { test, expect } from "@playwright/test";

// M12 #78: viewing-controls admin modal end-to-end.

test.describe("profile viewing controls", () => {
    test("modal opens, edits, persists", async ({ page }) => {
        await page.goto("/profiles");
        const defaultRow = page
            .locator("li")
            .filter({ has: page.locator(".profile-name", { hasText: /^Default$/ }) });
        await defaultRow.getByRole("button", { name: "Viewing" }).click();
        await expect(page.getByRole("heading", { name: /Viewing controls/ })).toBeVisible();

        await page.getByLabel("Dim (% darker, 0-80)").fill("25");
        await page.getByLabel("Red shift (% warm, 0-100)").fill("40");
        await page.getByLabel(/Auto-off at clock time/).fill("20:30");
        await page.locator(".modal-actions button.primary").click();
        await expect(page.getByRole("heading", { name: /Viewing controls/ })).not.toBeVisible();

        await defaultRow.getByRole("button", { name: "Viewing" }).click();
        await expect(page.getByLabel("Dim (% darker, 0-80)")).toHaveValue("25");
        await expect(page.getByLabel("Red shift (% warm, 0-100)")).toHaveValue("40");
        await expect(page.getByLabel(/Auto-off at clock time/)).toHaveValue("20:30");
    });

    test("invalid clock time is rejected with an error", async ({ page }) => {
        await page.goto("/profiles");
        const defaultRow = page
            .locator("li")
            .filter({ has: page.locator(".profile-name", { hasText: /^Default$/ }) });
        await defaultRow.getByRole("button", { name: "Viewing" }).click();
        await page.getByLabel(/Auto-off at clock time/).fill("nope");
        await page.locator(".modal-actions button.primary").click();
        await expect(page.locator(".error")).toBeVisible();
    });
});
