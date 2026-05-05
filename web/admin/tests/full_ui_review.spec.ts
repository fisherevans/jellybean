import { test } from "@playwright/test";
import { mkdirSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

// Captures screenshots of every admin page so a human + the agent
// can do a critical-design review pass. Not asserting much; the
// goal is the full-page PNG.

const __filename_local = fileURLToPath(import.meta.url);
const __dirname_local = dirname(__filename_local);
const SHOTS_DIR = resolve(
    __dirname_local,
    "..",
    "..",
    "..",
    ".run",
    "ux-review",
);
mkdirSync(SHOTS_DIR, { recursive: true });

function shot(name: string) {
    return resolve(SHOTS_DIR, `${name}.png`);
}

test.describe.configure({ mode: "serial" });

test.describe("full admin UI review", () => {
    test("dashboard / home", async ({ page }) => {
        await page.goto("/");
        await page.waitForLoadState("networkidle");
        await page.screenshot({ path: shot("01-home"), fullPage: true });
    });

    test("bulk categorize", async ({ page }) => {
        await page.goto("/bulk");
        await page.waitForLoadState("networkidle");
        await page.waitForTimeout(2000);
        await page.screenshot({ path: shot("02-bulk"), fullPage: true });
    });

    test("swipe", async ({ page }) => {
        await page.goto("/swipe");
        await page.waitForLoadState("networkidle");
        await page.waitForTimeout(1500);
        await page.screenshot({ path: shot("03-swipe"), fullPage: true });
    });

    test("activity", async ({ page }) => {
        await page.goto("/activity");
        await page.waitForLoadState("networkidle");
        await page.screenshot({ path: shot("04-activity"), fullPage: true });
    });

    test("search", async ({ page }) => {
        await page.goto("/search");
        await page.waitForLoadState("networkidle");
        await page.screenshot({ path: shot("05-search-empty"), fullPage: true });
        // With a query.
        const search = page.getByPlaceholder(/search/i).first();
        if (await search.isVisible().catch(() => false)) {
            await search.fill("scooby");
            await page.waitForTimeout(800);
            await page.screenshot({
                path: shot("05-search-results"),
                fullPage: true,
            });
        }
    });

    test("tags list", async ({ page }) => {
        await page.goto("/tags");
        await page.waitForLoadState("networkidle");
        await page.screenshot({ path: shot("06-tags"), fullPage: true });
    });

    test("layouts list", async ({ page }) => {
        await page.goto("/layouts");
        await page.waitForLoadState("networkidle");
        await page.screenshot({ path: shot("07-layouts"), fullPage: true });
    });

    test("layout detail", async ({ page }) => {
        await page.goto("/layouts");
        await page.waitForLoadState("networkidle");
        const link = page.locator("a.profile-name").first();
        if (await link.isVisible().catch(() => false)) {
            await link.click();
            await page.waitForLoadState("networkidle");
            await page.screenshot({
                path: shot("07b-layout-detail"),
                fullPage: true,
            });
        }
    });

    test("profiles list", async ({ page }) => {
        await page.goto("/profiles");
        await page.waitForLoadState("networkidle");
        await page.screenshot({ path: shot("08-profiles"), fullPage: true });
    });

    test("profile settings - basic", async ({ page }) => {
        await page.goto("/profiles");
        await page.locator(".profile-card-link").first().click();
        await page.waitForLoadState("networkidle");
        await page.screenshot({
            path: shot("09a-settings-basic"),
            fullPage: true,
        });
    });

    test("profile settings - tag rules", async ({ page }) => {
        await page.goto("/profiles");
        await page.locator(".profile-card-link").first().click();
        await page.getByRole("tab", { name: "Tag rules" }).click();
        await page.waitForTimeout(500);
        await page.screenshot({
            path: shot("09b-settings-tag-rules"),
            fullPage: true,
        });
    });

    test("profile settings - time limits", async ({ page }) => {
        await page.goto("/profiles");
        await page.locator(".profile-card-link").first().click();
        await page.getByRole("tab", { name: "Time limits" }).click();
        await page
            .getByRole("checkbox", { name: "Enable time limits for this profile" })
            .check();
        await page.screenshot({
            path: shot("09c-settings-time-limits"),
            fullPage: true,
        });
    });

    test("profile settings - body breaks", async ({ page }) => {
        await page.goto("/profiles");
        await page.locator(".profile-card-link").first().click();
        await page.getByRole("tab", { name: "Body breaks" }).click();
        await page.waitForSelector(".snap-slider", { timeout: 5_000 });
        await page.screenshot({
            path: shot("09d-settings-body-breaks"),
            fullPage: true,
        });
    });

    test("profile settings - time limits steady state", async ({ page }) => {
        await page.goto("/profiles");
        await page.locator(".profile-card-link").first().click();
        await page.getByRole("tab", { name: "Time limits" }).click();
        await page.waitForSelector(".snap-slider", { timeout: 5_000 });
        await page.screenshot({
            path: shot("09c2-settings-time-limits-loaded"),
            fullPage: true,
        });
    });

    test("profile settings - viewing", async ({ page }) => {
        await page.goto("/profiles");
        await page.locator(".profile-card-link").first().click();
        await page.getByRole("tab", { name: "Viewing" }).click();
        await page.waitForSelector(".viewing-preview", { timeout: 5_000 });
        await page.screenshot({
            path: shot("09e-settings-viewing"),
            fullPage: true,
        });
    });

    test("profile settings - modes empty", async ({ page }) => {
        await page.goto("/profiles");
        await page.locator(".profile-card-link").first().click();
        await page.getByRole("tab", { name: "Modes" }).click();
        await page.screenshot({
            path: shot("09f-settings-modes"),
            fullPage: true,
        });
    });

    test("profile settings - mode editor", async ({ page }) => {
        await page.goto("/profiles");
        await page.locator(".profile-card-link").first().click();
        await page.getByRole("tab", { name: "Modes" }).click();
        await page.getByRole("button", { name: /Add mode/ }).click();
        await page.screenshot({
            path: shot("09g-settings-mode-editor"),
            fullPage: true,
        });
    });

    test("profile settings - channels", async ({ page }) => {
        await page.goto("/profiles");
        await page.locator(".profile-card-link").first().click();
        await page.getByRole("tab", { name: "Channels" }).click();
        await page.screenshot({
            path: shot("09h-settings-channels"),
            fullPage: true,
        });
    });

    test("profile settings - channel editor", async ({ page }) => {
        await page.goto("/profiles");
        await page.locator(".profile-card-link").first().click();
        await page.getByRole("tab", { name: "Channels" }).click();
        await page.getByRole("button", { name: /Add channel/ }).click();
        await page.screenshot({
            path: shot("09i-settings-channel-editor"),
            fullPage: true,
        });
    });

    test("manage kids", async ({ page }) => {
        await page.goto("/manage-kids");
        await page.waitForLoadState("networkidle");
        await page.screenshot({ path: shot("10-kids"), fullPage: true });
    });

    test("api keys", async ({ page }) => {
        await page.goto("/api-keys");
        await page.waitForLoadState("networkidle");
        await page.screenshot({ path: shot("11-api-keys"), fullPage: true });
    });

    test("settings (global)", async ({ page }) => {
        await page.goto("/settings");
        await page.waitForLoadState("networkidle");
        await page.screenshot({ path: shot("12-settings"), fullPage: true });
    });
});
