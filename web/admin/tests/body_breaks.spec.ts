import { test, expect } from "@playwright/test";

// Profile body-breaks: numeric inputs migrated to SnapSlider, the
// Enable checkbox migrated to ToggleSwitch.

test.describe("profile body-breaks", () => {
    test("settings page body-breaks tab edits and persists", async ({ page }) => {
        await page.goto("/manage/profiles");
        await page.locator(".profile-card-link").filter({ has: page.locator(".profile-name", { hasText: /^Default$/ }) }).click();
        await page.getByRole("tab", { name: "Body breaks" }).click();
        await page.waitForSelector(".snap-slider");

        const toggle = page
            .locator(".toggle-switch")
            .filter({ hasText: "Enable body breaks for this profile" })
            .locator("input[type=checkbox]");
        await toggle.evaluate((el: HTMLInputElement) => {
            if (!el.checked) el.click();
        });

        const playSlider = page
            .locator(".snap-slider")
            .filter({ hasText: "Play time before break" })
            .locator("input[type=number]");
        await playSlider.fill("45");

        const breakSlider = page
            .locator(".snap-slider")
            .filter({ hasText: "Break duration" })
            .locator("input[type=number]");
        await breakSlider.fill("3");

        await page.getByLabel("Reasons (one per line)").fill(
            ["a glass of water", "a 5-minute walk"].join("\n"),
        );
        await page.getByRole("button", { name: /^Save/ }).click();
        await expect(page.getByText("Saved.")).toBeVisible();

        await page.reload();
        await page.getByRole("tab", { name: "Body breaks" }).click();
        await page.waitForSelector(".snap-slider");
        await expect(playSlider).toHaveValue("45");
        await expect(breakSlider).toHaveValue("3");
        await expect(page.getByLabel("Reasons (one per line)")).toContainText(
            "a glass of water",
        );
    });
});
