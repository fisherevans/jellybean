import { test, expect } from "@playwright/test";

// Profile viewing controls via the new settings page.

test.describe("profile viewing controls", () => {
    test("settings page viewing tab edits and persists", async ({ page }) => {
        await page.goto("/profiles");
        await page.getByRole("link", { name: /Default/ }).click();
        await page.getByRole("tab", { name: "Viewing" }).click();

        await page.getByLabel("Dim (% darker, 0-80)").fill("25");
        await page.getByLabel("Red shift (% warm, 0-100)").fill("40");
        await page.getByLabel(/Auto-off at clock time/).fill("20:30");
        await page.getByRole("button", { name: /^Save/ }).click();
        await expect(page.getByText("Saved.")).toBeVisible();

        await page.reload();
        await page.getByRole("tab", { name: "Viewing" }).click();
        await expect(page.getByLabel("Dim (% darker, 0-80)")).toHaveValue("25");
        await expect(page.getByLabel("Red shift (% warm, 0-100)")).toHaveValue(
            "40",
        );
        await expect(page.getByLabel(/Auto-off at clock time/)).toHaveValue(
            "20:30",
        );
    });

    test("invalid clock time is rejected with an inline error", async ({ page }) => {
        await page.goto("/profiles");
        await page.getByRole("link", { name: /Default/ }).click();
        await page.getByRole("tab", { name: "Viewing" }).click();
        await page.getByLabel(/Auto-off at clock time/).fill("nope");
        await page.getByRole("button", { name: /^Save/ }).click();
        await expect(page.locator(".error")).toBeVisible();
    });
});
