import { test, expect } from "@playwright/test";

// M11 #73 admin UI: profile body-breaks config edits + persists.

test.describe("profile body-breaks", () => {
    test("modal opens, edits, persists", async ({ page }) => {
        await page.goto("/profiles");
        const defaultRow = page
            .locator("li")
            .filter({ has: page.locator(".profile-name", { hasText: /^Default$/ }) });
        await expect(defaultRow).toBeVisible();
        await defaultRow.getByRole("button", { name: "Body breaks" }).click();
        await expect(page.getByRole("heading", { name: /Body breaks/ })).toBeVisible();

        await page
            .getByRole("checkbox", { name: "Enable body breaks for this profile" })
            .check();
        await page.getByLabel("Play before break (minutes)").fill("45");
        await page.getByLabel("Break duration (minutes)").fill("3");
        await page.getByLabel("Reasons (one per line)").fill(
            ["a glass of water", "a 5-minute walk"].join("\n"),
        );
        await page.locator(".modal-actions button.primary").click();
        await expect(page.getByRole("heading", { name: /Body breaks/ })).not.toBeVisible();

        await defaultRow.getByRole("button", { name: "Body breaks" }).click();
        await expect(page.getByLabel("Play before break (minutes)")).toHaveValue("45");
        await expect(page.getByLabel("Break duration (minutes)")).toHaveValue("3");
        await expect(page.getByLabel("Reasons (one per line)")).toContainText(
            "a glass of water",
        );
    });
});
