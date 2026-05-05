import { test, expect } from "@playwright/test";

// Profile time-limits via the new settings page. The daily-cap field
// is now a SnapSlider with a numeric input on the right; cadence and
// day-start sit side-by-side in a settings-row.

test.describe("profile time-limits", () => {
    test("settings page time-limits tab edits and persists", async ({ page }) => {
        await page.goto("/profiles");
        await page.getByRole("link", { name: /Default/ }).click();
        await expect(page).toHaveURL(/\/profiles\/\d+/);
        await page.getByRole("tab", { name: "Time limits" }).click();
        await page.waitForSelector(".snap-slider");

        // Toggle is now a custom switch, not a native checkbox role.
        const toggle = page
            .locator(".toggle-switch")
            .filter({ hasText: "Enable time limits for this profile" })
            .locator("input[type=checkbox]");
        await toggle.evaluate((el: HTMLInputElement) => {
            if (!el.checked) el.click();
        });

        // Daily cap: use the slider's numeric input (the second control
        // in the snap-slider row, with type=number).
        const dailyCapNumber = page
            .locator(".snap-slider")
            .filter({ hasText: "Daily cap" })
            .locator("input[type=number]");
        await dailyCapNumber.fill("180");

        await page.getByLabel("Refill interval").selectOption("4");
        await page.getByLabel("Day starts at").selectOption("6");

        await expect(page.locator(".refill-preview")).toContainText("Adds");

        await page.getByRole("button", { name: /^Save/ }).click();
        await expect(page.getByText("Saved.")).toBeVisible();

        await page.reload();
        await page.getByRole("tab", { name: "Time limits" }).click();
        await page.waitForSelector(".snap-slider");
        await expect(dailyCapNumber).toHaveValue("180");
        await expect(page.getByLabel("Refill interval")).toHaveValue("4");
        await expect(page.getByLabel("Day starts at")).toHaveValue("6");
        await expect(toggle).toBeChecked();
    });
});
