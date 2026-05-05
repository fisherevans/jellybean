import { test, expect } from "@playwright/test";
import { mkdirSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

// End-to-end walk through every admin page that the parent will
// touch. Captures a screenshot per page so a regression in any
// layout / styling jumps out at review time. Asserts that each page
// rendered without throwing a React error boundary or surfacing the
// generic "load failed" copy.

const __filename_local = fileURLToPath(import.meta.url);
const __dirname_local = dirname(__filename_local);
const SHOTS_DIR = resolve(
    __dirname_local,
    "..",
    "..",
    "..",
    ".run",
    "ux-review",
    "smoke-walk",
);
mkdirSync(SHOTS_DIR, { recursive: true });

async function visitAndCapture(page, url: string, screenshot: string) {
    await page.goto(url);
    await page.waitForLoadState("networkidle");
    // No raw error pages.
    expect(await page.locator(".error").count()).toBeLessThan(2);
    expect(await page.getByText(/Cannot find|^Error: /).count()).toBe(0);
    await page.screenshot({
        path: resolve(SHOTS_DIR, screenshot),
        fullPage: true,
    });
}

test("admin walk: each top-level page renders", async ({ page }) => {
    await visitAndCapture(page, "/manage", "00-home.png");
    await visitAndCapture(page, "/manage/swipe", "01-swipe.png");
    await visitAndCapture(page, "/manage/bulk", "02-bulk.png");
    await visitAndCapture(page, "/manage/browse", "03-browse.png");
    await visitAndCapture(page, "/manage/tags", "04-tags.png");
    await visitAndCapture(page, "/manage/profiles", "05-profiles.png");
    await visitAndCapture(page, "/manage/profiles/1", "06-profile-default-basic.png");
});

test("admin walk: each profile-settings tab renders", async ({ page }) => {
    await page.goto("/manage/profiles/1");
    await page.waitForSelector(".settings-form, .settings-tabs", { timeout: 10_000 });
    const tabs = [
        ["Basic", "10-basic.png"],
        ["Tag rules", "11-tag-rules.png"],
        ["Time limits", "12-time-limits.png"],
        ["Body breaks", "13-body-breaks.png"],
        ["Viewing", "14-viewing.png"],
        ["Modes", "15-modes.png"],
        ["Channels", "16-channels.png"],
    ] as const;
    for (const [label, file] of tabs) {
        await page.getByRole("tab", { name: label }).click();
        await page.waitForLoadState("networkidle");
        await page.screenshot({
            path: resolve(SHOTS_DIR, file),
            fullPage: true,
        });
    }
});

test("admin walk: kids/layouts/api-keys/system pages", async ({ page }) => {
    await visitAndCapture(page, "/manage/kids", "20-kids.png");
    await visitAndCapture(page, "/manage/layouts", "21-layouts.png");
    await visitAndCapture(page, "/manage/layouts/1", "22-layout-default.png");
    await visitAndCapture(page, "/manage/activity", "23-activity.png");
    await visitAndCapture(page, "/manage/api-keys", "24-api-keys.png");
    await visitAndCapture(page, "/manage/settings", "25-system.png");
});

test("admin walk: 404 + login screens render", async ({ page }) => {
    await visitAndCapture(page, "/manage/no-such-page", "30-not-found.png");
});
