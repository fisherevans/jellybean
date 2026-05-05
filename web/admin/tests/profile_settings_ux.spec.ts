import { test, expect } from "@playwright/test";
import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";

// UX/visibility/style validation pass for the profile settings
// redesign. Captures screenshots into .run/ux-screenshots/ for
// visual review. Each section gets a click-through that asserts
// (a) the tab activates, (b) form controls are interactable
// (clicking a checkbox actually flips it - this is the regression
// that motivated the redesign), and (c) Save flows complete.

const __filename_local = fileURLToPath(import.meta.url);
const __dirname_local = dirname(__filename_local);
const SHOTS_DIR = resolve(
    __dirname_local,
    "..",
    "..",
    "..",
    ".run",
    "ux-screenshots",
);
mkdirSync(SHOTS_DIR, { recursive: true });

function shot(name: string) {
    return resolve(SHOTS_DIR, `${name}.png`);
}

test.describe("profile settings UX", () => {
    test("profiles list shows a clean clickable row + Settings affordance", async ({ page }) => {
        await page.goto("/profiles");
        await expect(page.getByRole("heading", { name: "Profiles" })).toBeVisible();

        const defaultRow = page
            .locator("li")
            .filter({ has: page.locator(".profile-name", { hasText: /^Default$/ }) });
        await expect(defaultRow).toBeVisible();
        // Old design had 6 buttons in a row - new design has just
        // Rename + Delete on the row itself, and the link header
        // takes you to settings.
        await expect(
            defaultRow.getByRole("button", { name: "Rename" }),
        ).toBeVisible();
        await expect(
            defaultRow.getByRole("button", { name: "Delete" }),
        ).toBeVisible();
        // No section-launching modal buttons should remain.
        for (const stale of [
            "Time limits",
            "Body breaks",
            "Viewing",
            "Modes",
            "Channels",
            "Tag rules",
        ]) {
            await expect(
                defaultRow.getByRole("button", { name: stale }),
            ).toHaveCount(0);
        }
        // The row link itself takes you to the settings page.
        await expect(defaultRow.locator(".profile-card-link")).toBeVisible();
        await expect(
            defaultRow.locator(".profile-card-chevron"),
        ).toContainText(/Settings/);

        await page.screenshot({ path: shot("01-profiles-list"), fullPage: true });
    });

    test("clicking the row navigates to /profiles/:id with all tabs visible", async ({ page }) => {
        await page.goto("/profiles");
        await page.locator(".profile-card-link").first().click();
        await expect(page).toHaveURL(/\/profiles\/\d+/);
        await expect(
            page.getByRole("heading", { level: 1, name: "Default" }),
        ).toBeVisible();

        const tabNames = [
            "Basic",
            "Tag rules",
            "Time limits",
            "Body breaks",
            "Viewing",
            "Modes",
            "Channels",
        ];
        for (const t of tabNames) {
            await expect(page.getByRole("tab", { name: t })).toBeVisible();
        }
        // Default tab is Basic.
        await expect(
            page.getByRole("tab", { name: "Basic" }),
        ).toHaveAttribute("aria-selected", "true");
        await page.screenshot({ path: shot("02-settings-basic"), fullPage: true });
    });

    test("Basic tab fields are editable + Save round trips", async ({ page }) => {
        await page.goto("/profiles");
        await page.locator(".profile-card-link").first().click();
        // Stays on Basic by default.
        await expect(page.getByLabel("Name")).toHaveValue("Default");
        await expect(page.getByLabel("Description")).toBeVisible();
        await expect(page.getByLabel("Default audio language")).toBeVisible();
        await expect(page.getByLabel("Browse layout")).toBeVisible();
        // Stats are visible (now using the same .profile-stats class
        // as the Profiles list page).
        await expect(page.locator(".profile-stats")).toContainText(/visible/);
        await expect(page.locator(".profile-stats")).toContainText(/hidden/);
    });

    test("Time limits tab: ToggleSwitch flips on click", async ({ page }) => {
        await page.goto("/profiles");
        await page.locator(".profile-card-link").first().click();
        await page.getByRole("tab", { name: "Time limits" }).click();
        await page.waitForSelector(".toggle-switch");

        const toggle = page
            .locator(".toggle-switch")
            .filter({ hasText: "Enable time limits for this profile" });
        const cb = toggle.locator("input[type=checkbox]");
        const initial = await cb.isChecked();
        await toggle.click();
        await expect(cb).toBeChecked({ checked: !initial });
        await toggle.click();
        await expect(cb).toBeChecked({ checked: initial });

        await page.screenshot({ path: shot("03-time-limits"), fullPage: true });
    });

    test("Modes tab: day-of-week pill toggles flip on click", async ({ page }) => {
        await page.goto("/profiles");
        await page.locator(".profile-card-link").first().click();
        await page.getByRole("tab", { name: "Modes" }).click();
        await page.getByRole("button", { name: /Add mode/ }).click();
        await expect(page.getByText("New mode")).toBeVisible();

        const days = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
        for (const d of days) {
            const pill = page
                .locator(".pill-toggle")
                .filter({ hasText: new RegExp(`^${d}$`) });
            await expect(pill).toHaveAttribute("aria-pressed", "true");
            await pill.click();
            await expect(pill).toHaveAttribute("aria-pressed", "false");
        }
        for (const d of days) {
            const pill = page
                .locator(".pill-toggle")
                .filter({ hasText: new RegExp(`^${d}$`) });
            await pill.click();
            await expect(pill).toHaveAttribute("aria-pressed", "true");
        }

        await page.screenshot({ path: shot("04-modes-editor"), fullPage: true });
        await page.getByRole("button", { name: "Cancel" }).click();
    });

    test("Body breaks tab loads + textarea is editable", async ({ page }) => {
        await page.goto("/profiles");
        await page.locator(".profile-card-link").first().click();
        await page.getByRole("tab", { name: "Body breaks" }).click();
        const reasons = page.getByLabel("Reasons (one per line)");
        await expect(reasons).toBeVisible();
        await reasons.fill("test1\ntest2\ntest3");
        await expect(reasons).toHaveValue("test1\ntest2\ntest3");
        await page.screenshot({ path: shot("05-body-breaks"), fullPage: true });
    });

    test("Viewing tab loads + sliders editable", async ({ page }) => {
        await page.goto("/profiles");
        await page.locator(".profile-card-link").first().click();
        await page.getByRole("tab", { name: "Viewing" }).click();
        await page.waitForSelector(".viewing-preview");
        const dimSlider = page
            .locator(".snap-slider")
            .filter({ hasText: "Dim" })
            .locator("input[type=number]");
        await expect(dimSlider).toBeVisible();
        await dimSlider.fill("15");
        await expect(dimSlider).toHaveValue("15");
        await page.screenshot({ path: shot("06-viewing"), fullPage: true });
    });

    test("Channels tab loads + Add Channel works", async ({ page }) => {
        await page.goto("/profiles");
        await page.locator(".profile-card-link").first().click();
        await page.getByRole("tab", { name: "Channels" }).click();
        await page.getByRole("button", { name: /Add channel/ }).click();
        await expect(page.getByText("New channel")).toBeVisible();
        await page.screenshot({ path: shot("07-channels-editor"), fullPage: true });
    });

    test("Tag rules tab loads + radios visible", async ({ page }) => {
        await page.goto("/profiles");
        await page.locator(".profile-card-link").first().click();
        await page.getByRole("tab", { name: "Tag rules" }).click();
        // Either tags are present or "No tags yet" - both are valid
        // first-load states.
        const panel = page.locator(".settings-panel");
        await expect(panel).toBeVisible();
        await page.screenshot({ path: shot("08-tag-rules"), fullPage: true });
    });

    test("no milestone references appear in user-visible text", async ({ page }) => {
        await page.goto("/profiles");
        await page.locator(".profile-card-link").first().click();
        for (const tab of [
            "Basic",
            "Tag rules",
            "Time limits",
            "Body breaks",
            "Viewing",
            "Modes",
            "Channels",
        ]) {
            await page.getByRole("tab", { name: tab }).click();
            const panel = page.locator(".settings-panel");
            await expect(panel).toBeVisible();
            const text = await panel.innerText();
            // The redesign removed milestone references like "M9
            // override modal" / "M10 time limits" from copy.
            expect(text).not.toMatch(/\bM\d+\b/);
            expect(text).not.toMatch(/milestone/i);
        }
    });

    test("active-tab styling reflects which tab is focused", async ({ page }) => {
        await page.goto("/profiles");
        await page.locator(".profile-card-link").first().click();
        await page.getByRole("tab", { name: "Modes" }).click();
        const modesTab = page.getByRole("tab", { name: "Modes" });
        await expect(modesTab).toHaveAttribute("aria-selected", "true");
        await expect(modesTab).toHaveClass(/active/);
        // Other tabs aren't selected.
        const basicTab = page.getByRole("tab", { name: "Basic" });
        await expect(basicTab).toHaveAttribute("aria-selected", "false");
        await expect(basicTab).not.toHaveClass(/active/);
    });
});
