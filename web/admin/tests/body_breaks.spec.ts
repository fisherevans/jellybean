import { test, expect } from "@playwright/test";

// Profile body-breaks via the new settings page.

test.describe("profile body-breaks", () => {
    test("settings page body-breaks tab edits and persists", async ({ page }) => {
        await page.goto("/profiles");
        await page.getByRole("link", { name: /Default/ }).click();
        await page.getByRole("tab", { name: "Body breaks" }).click();

        await page
            .getByRole("checkbox", {
                name: "Enable body breaks for this profile",
            })
            .check();
        await page.getByLabel("Play before break (minutes)").fill("45");
        await page.getByLabel("Break duration (minutes)").fill("3");
        await page.getByLabel("Reasons (one per line)").fill(
            ["a glass of water", "a 5-minute walk"].join("\n"),
        );
        await page.getByRole("button", { name: /^Save/ }).click();
        await expect(page.getByText("Saved.")).toBeVisible();

        await page.reload();
        await page.getByRole("tab", { name: "Body breaks" }).click();
        await expect(page.getByLabel("Play before break (minutes)")).toHaveValue(
            "45",
        );
        await expect(page.getByLabel("Break duration (minutes)")).toHaveValue("3");
        await expect(page.getByLabel("Reasons (one per line)")).toContainText(
            "a glass of water",
        );
    });
});
