import { test, expect } from "@playwright/test";

// Profile modes via settings page. Day toggles + required tags now
// use the pill-toggle pattern (button with aria-pressed); sort order
// in channels uses the same.

test.describe("profile modes", () => {
    test("create + toggle days + delete via settings page", async ({ page }) => {
        await page.goto("/profiles");
        await page.getByRole("link", { name: /Default/ }).click();
        await page.getByRole("tab", { name: "Modes" }).click();

        await page.getByRole("button", { name: /Add mode/ }).click();
        await expect(page.getByText("New mode")).toBeVisible();

        await page.getByLabel("Name").fill("E2E Bedtime");

        // Toggle Wed off via the pill button (it's the regression that
        // motivated the redesign - the button must visually flip).
        const wedPill = page
            .locator(".pill-toggle")
            .filter({ hasText: /^Wed$/ });
        await expect(wedPill).toHaveAttribute("aria-pressed", "true");
        await wedPill.click();
        await expect(wedPill).toHaveAttribute("aria-pressed", "false");

        await page.getByLabel("Start time").fill("21:00");
        await page.getByLabel("End time").fill("06:30");
        await page.getByLabel("Theme").selectOption("bedtime");
        await page.getByRole("button", { name: /^Save/ }).click();

        const created = page
            .locator(".modes-list-row")
            .filter({ hasText: "E2E Bedtime" });
        await expect(created).toBeVisible();
        await expect(created).toContainText("Mon,Tue,Thu");
        await expect(created).not.toContainText("Wed");

        page.on("dialog", (d) => d.accept());
        await created.getByRole("button", { name: "Delete" }).click();
        await expect(created).not.toBeVisible();
    });
});
