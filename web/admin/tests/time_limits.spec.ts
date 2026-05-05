import { test, expect } from "@playwright/test";

// Profile time-limits via the new settings page.

test.describe("profile time-limits", () => {
    test("settings page time-limits tab edits and persists", async ({ page }) => {
        await page.goto("/profiles");
        await page.getByRole("link", { name: /Default/ }).click();
        await expect(page).toHaveURL(/\/profiles\/\d+/);
        await page.getByRole("tab", { name: "Time limits" }).click();

        await page
            .getByRole("checkbox", {
                name: "Enable time limits for this profile",
            })
            .check();
        await page.getByLabel("Daily cap (minutes)").fill("180");
        await page.getByLabel("Refill interval").selectOption("4");
        await page.getByLabel("Day starts at").selectOption("6");
        await expect(page.locator(".time-limits-preview")).toContainText(
            "+30 min",
        );
        await page.getByRole("button", { name: /^Save/ }).click();
        await expect(page.getByText("Saved.")).toBeVisible();

        await page.reload();
        await page.getByRole("tab", { name: "Time limits" }).click();
        await expect(page.getByLabel("Daily cap (minutes)")).toHaveValue("180");
        await expect(page.getByLabel("Refill interval")).toHaveValue("4");
        await expect(page.getByLabel("Day starts at")).toHaveValue("6");
        await expect(
            page.getByRole("checkbox", {
                name: "Enable time limits for this profile",
            }),
        ).toBeChecked();
    });
});
