import { test, expect } from "@playwright/test";

// M10 #67: profile time-limits modal end-to-end. Validates the GET +
// PUT round trip via the admin UI.

test.describe("profile time-limits", () => {
    test("modal opens, edits, persists", async ({ page }) => {
        await page.goto("/profiles");
        const defaultRow = page
            .locator("li")
            .filter({ has: page.locator(".profile-name", { hasText: /^Default$/ }) });
        await expect(defaultRow).toBeVisible();
        await defaultRow.getByRole("button", { name: "Time limits" }).click();
        await expect(page.getByRole("heading", { name: /Time limits/ })).toBeVisible();

        // Toggle enable + adjust the cap.
        const enable = page.getByRole("checkbox", {
            name: "Enable time limits for this profile",
        });
        await enable.check();
        await page.getByLabel("Daily cap (minutes)").fill("180");
        await page.getByLabel("Refill interval").selectOption("4");
        await page.getByLabel("Day starts at").selectOption("6");
        // Refill preview should reflect the new cadence (180/6 = 30 per refill).
        await expect(page.locator(".time-limits-preview")).toContainText("+30 min");
        await page.locator(".modal-actions button.primary").click();
        await expect(page.getByRole("heading", { name: /Time limits/ })).not.toBeVisible();

        // Reopen the modal and confirm persistence.
        await defaultRow.getByRole("button", { name: "Time limits" }).click();
        await expect(page.getByLabel("Daily cap (minutes)")).toHaveValue("180");
        await expect(page.getByLabel("Refill interval")).toHaveValue("4");
        await expect(page.getByLabel("Day starts at")).toHaveValue("6");
        await expect(
            page.getByRole("checkbox", { name: "Enable time limits for this profile" }),
        ).toBeChecked();
    });
});
