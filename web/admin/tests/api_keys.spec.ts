import { test, expect, type Page } from "@playwright/test";

// M14 #89/#90 e2e. Exercises the admin API keys page: create -> token
// reveal -> revoke -> delete, plus a bearer-auth check via fetch().

async function gotoAndWaitReady(page: Page, path: string) {
    await page.goto(path);
    await expect(page.getByRole("link", { name: "Jellybean" })).toBeVisible();
}

function uniqueName(prefix: string): string {
    return `${prefix}-e2e-${Date.now().toString(36)}`;
}

test.describe("api keys admin UI", () => {
    test("nav entry", async ({ page }) => {
        await gotoAndWaitReady(page, "/manage");
        await expect(
            page.getByRole("navigation").getByRole("link", { name: "API keys" }),
        ).toBeVisible();
    });

    test("create reveals plaintext token, revoke, delete", async ({ page }) => {
        const name = uniqueName("e2e-key");
        await gotoAndWaitReady(page, "/manage/api-keys");

        await page.getByLabel("Name").fill(name);
        await page.getByRole("button", { name: "Create key" }).click();

        // Token reveal panel.
        const reveal = page.locator(".apikey-revealed");
        await expect(reveal).toBeVisible();
        const tokenText = await reveal.locator(".apikey-token").innerText();
        expect(tokenText).toMatch(/^jb_[0-9a-f]{64}$/);

        // The token should immediately work as a bearer.
        const bearerProbe = await page.evaluate(async (token) => {
            const res = await fetch("/api/admin/profiles", {
                method: "GET",
                headers: { Authorization: `Bearer ${token}` },
                credentials: "omit",
            });
            return res.status;
        }, tokenText);
        expect(bearerProbe).toBe(200);

        // Dismiss the reveal.
        await reveal.getByRole("button", { name: "I have it, dismiss" }).click();
        await expect(reveal).toBeHidden();

        // The new key is in the list.
        const row = page.locator(".profile-row", { hasText: name });
        await expect(row).toBeVisible();

        // Revoke it.
        page.once("dialog", (d) => d.accept());
        await row.getByRole("button", { name: "Revoke" }).click();
        await expect(row.locator(".apikey-revoked-pill")).toBeVisible();

        // Bearer no longer works post-revoke.
        const postRevoke = await page.evaluate(async (token) => {
            const res = await fetch("/api/admin/profiles", {
                method: "GET",
                headers: { Authorization: `Bearer ${token}` },
                credentials: "omit",
            });
            return res.status;
        }, tokenText);
        expect(postRevoke).toBe(401);

        // Delete cleans up.
        page.once("dialog", (d) => d.accept());
        await row.getByRole("button", { name: "Delete" }).click();
        await expect(page.locator(".profile-row", { hasText: name })).toHaveCount(0);
    });

    test("access log surfaces bearer-authed calls", async ({ page }) => {
        const name = uniqueName("log-key");
        await gotoAndWaitReady(page, "/manage/api-keys");
        await page.getByLabel("Name").fill(name);
        await page.getByRole("button", { name: "Create key" }).click();
        const tokenText = await page.locator(".apikey-token").innerText();
        await page.getByRole("button", { name: "I have it, dismiss" }).click();

        // Make a bearer call so the access log gets a row.
        await page.evaluate(async (token) => {
            await fetch("/api/admin/profiles", {
                headers: { Authorization: `Bearer ${token}` },
                credentials: "omit",
            });
        }, tokenText);

        // Reload the page to refresh the log table; the page fetches
        // it on mount.
        await page.reload();

        // The log table should have at least one row whose path is
        // /api/admin/profiles. Loose check by .apikey-log existing
        // and containing the path text.
        await expect(page.locator(".apikey-log")).toBeVisible();
        await expect(page.locator(".apikey-log-path", { hasText: "/api/admin/profiles" }).first()).toBeVisible();

        // Cleanup.
        const row = page.locator(".profile-row", { hasText: name });
        page.once("dialog", (d) => d.accept());
        await row.getByRole("button", { name: "Delete" }).click();
        await expect(page.locator(".profile-row", { hasText: name })).toHaveCount(0);
    });
});
