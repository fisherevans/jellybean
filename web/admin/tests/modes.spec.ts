import { test, expect } from "@playwright/test";

// Profile modes via the new settings page.

test.describe("profile modes", () => {
    test("create + edit days + delete via settings page", async ({ page }) => {
        await page.goto("/profiles");
        await page.getByRole("link", { name: /Default/ }).click();
        await page.getByRole("tab", { name: "Modes" }).click();

        await page.getByRole("button", { name: /Add mode/ }).click();
        await expect(page.getByText("New mode")).toBeVisible();

        await page.getByLabel("Name").fill("E2E Bedtime");
        // Toggle Wed off - this is the regression that motivated the
        // settings overhaul; clicking the label has to flip the
        // wrapped native checkbox.
        const wedBox = page.getByRole("checkbox", { name: "Wed" });
        await expect(wedBox).toBeChecked();
        // Use a native HTMLElement.click() so we mimic the user-event
        // path (label-wrapped input would also flip from a real user
        // click on the label; Playwright's actionability check doesn't
        // cope with the flex-layout label as a click target, hence
        // evaluate() instead of click()).
        await wedBox.evaluate((el: HTMLInputElement) => el.click());
        await expect(wedBox).not.toBeChecked();

        await page.getByLabel("Start time").fill("21:00");
        await page.getByLabel("End time").fill("06:30");
        await page.getByLabel("Theme").selectOption("bedtime");
        await page.getByRole("button", { name: /^Save/ }).click();

        const created = page
            .locator(".modes-list-row")
            .filter({ hasText: "E2E Bedtime" });
        await expect(created).toBeVisible();
        // The mode summary should reflect Wed being toggled off.
        await expect(created).toContainText("Mon,Tue,Thu");
        await expect(created).not.toContainText("Wed");

        page.on("dialog", (d) => d.accept());
        await created.getByRole("button", { name: "Delete" }).click();
        await expect(created).not.toBeVisible();
    });
});
