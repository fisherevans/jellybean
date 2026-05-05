import { test, expect } from "@playwright/test";
import { mkdirSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

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

// 404 surfaces:
//   - server-level (any unmatched path outside /manage and /player)
//   - in-app SPA catch-all (any /manage/<unknown>)
//   - JSON for /api/<unknown>

test.describe("404 surfaces", () => {
    test("server-level HTML 404 page renders for unmatched root paths", async ({
        page,
    }) => {
        const res = await page.goto("/totally-bogus-path");
        expect(res?.status()).toBe(404);
        await expect(page.getByText("404", { exact: true })).toBeVisible();
        await expect(
            page.getByText("Page not found", { exact: true }),
        ).toBeVisible();
        await expect(page.getByRole("link", { name: "Open admin" })).toHaveAttribute(
            "href",
            "/manage",
        );
        await page.screenshot({
            path: resolve(SHOTS_DIR, "16-404-server.png"),
            fullPage: true,
        });
    });

    test("in-app catch-all renders inside the admin Layout shell", async ({
        page,
    }) => {
        await page.goto("/manage/this-route-does-not-exist");
        // Top nav is visible (sign-out, brand link, etc.) so the
        // catch-all is rendering inside Layout.
        await expect(
            page.getByRole("link", { name: "Jellybean" }),
        ).toBeVisible();
        // The 404 content is the larger, accent-styled "404" code.
        await expect(page.locator(".not-found-code")).toContainText("404");
        await expect(
            page.getByRole("heading", { name: "Page not found" }),
        ).toBeVisible();
        await expect(
            page.getByRole("link", { name: "← Home" }),
        ).toHaveAttribute("href", "/manage");
        await page.screenshot({
            path: resolve(SHOTS_DIR, "17-404-inapp.png"),
            fullPage: true,
        });
    });

    test("API 404 returns JSON", async ({ request }) => {
        const res = await request.get("/api/totally-not-a-real-endpoint");
        expect(res.status()).toBe(404);
        const body = await res.json();
        expect(body.error).toBe("not found");
    });
});
