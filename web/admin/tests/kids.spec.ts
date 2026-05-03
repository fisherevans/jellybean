import { test, expect } from "@playwright/test";

// End-to-end checks for the kids client's profile picker + deviceId
// scaffolding (#19). Reuses the admin storageState (which authenticates
// kids endpoints too) and runs each test in a fresh context so localStorage
// state from one test doesn't bleed into another.

const KIDS_BASE = "/kids/";

async function clearKidsLocalStorage(page: import("@playwright/test").Page) {
    // Visit the kids origin first so localStorage is scoped right.
    await page.goto(KIDS_BASE);
    await page.evaluate(() => {
        localStorage.removeItem("jellybean.kids.profiles");
        localStorage.removeItem("jellybean.kids.activeKey");
        localStorage.removeItem("jellybean.kids.deviceId");
        localStorage.removeItem("jellybean.kids.key");
    });
}

test.describe("kids picker", () => {
    test("zero profiles + admin: shows admin preview with profiles list", async ({ page }) => {
        await clearKidsLocalStorage(page);
        await page.goto(KIDS_BASE);
        await expect(
            page.getByRole("heading", { name: /Kids client preview/ }),
        ).toBeVisible();
        // Server-side Default profile is the test invariant.
        await expect(page.getByRole("link", { name: /Default/ })).toBeVisible();
    });

    test("one profile auto-selects and routes to /library", async ({ page }) => {
        await clearKidsLocalStorage(page);
        await page.evaluate(() => {
            localStorage.setItem(
                "jellybean.kids.profiles",
                JSON.stringify([{ name: "TestKid", apiKey: "fake-key-only-for-routing" }]),
            );
        });
        await page.goto(KIDS_BASE);
        // Library page renders. Even if the API rejects the fake key, the
        // route + heading should show up. Admin cookie carries us past the
        // 401 anyway, so we expect a real heading.
        await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
        await expect(page).toHaveURL(/\/kids\/library/);
    });

    test("two profiles: shows picker with both tiles", async ({ page }) => {
        await clearKidsLocalStorage(page);
        await page.evaluate(() => {
            localStorage.setItem(
                "jellybean.kids.profiles",
                JSON.stringify([
                    { name: "Dex", apiKey: "key-dex" },
                    { name: "Zoey", apiKey: "key-zoey" },
                ]),
            );
        });
        await page.goto(KIDS_BASE);
        await expect(page.getByRole("heading", { name: /Who's watching/ })).toBeVisible();
        await expect(page.getByRole("button", { name: /Dex/ })).toBeVisible();
        await expect(page.getByRole("button", { name: /Zoey/ })).toBeVisible();
    });

    test("/setup query-param shortcut appends a profile and redirects", async ({ page }) => {
        await clearKidsLocalStorage(page);
        await page.goto("/kids/setup?key=qp-key&name=QPKid");
        // Single profile after redirect should auto-route to library.
        await expect(page).toHaveURL(/\/kids\/library/);
        const stored = await page.evaluate(() =>
            localStorage.getItem("jellybean.kids.profiles"),
        );
        expect(stored).toBeTruthy();
        const parsed = JSON.parse(stored!);
        expect(parsed).toEqual([{ name: "QPKid", apiKey: "qp-key" }]);
    });

    test("deviceId is generated lazily and sent on /api/kids/library", async ({ page }) => {
        await clearKidsLocalStorage(page);
        await page.evaluate(() => {
            localStorage.setItem(
                "jellybean.kids.profiles",
                JSON.stringify([{ name: "TestKid", apiKey: "test-key" }]),
            );
        });

        const seen: string[] = [];
        page.on("request", (req) => {
            const id = req.headers()["x-jellybean-deviceid"];
            if (id && req.url().includes("/api/kids/")) seen.push(id);
        });

        await page.goto(KIDS_BASE);
        // Wait for at least one /api/kids/library call.
        await page.waitForRequest(
            (req) => req.url().includes("/api/kids/library"),
            { timeout: 10_000 },
        );
        // Storage now has a deviceId.
        const stored = await page.evaluate(() =>
            localStorage.getItem("jellybean.kids.deviceId"),
        );
        expect(stored).toMatch(
            /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
        );
        expect(seen.length).toBeGreaterThan(0);
        expect(seen[0]).toBe(stored);
    });

    test("manual setup form adds a profile and updates the count", async ({ page }) => {
        await clearKidsLocalStorage(page);
        await page.goto("/kids/setup");
        await page.getByRole("heading", { name: /Add kid profile/ }).waitFor();
        // Two label inputs in order: Display name, Kid API key.
        const inputs = page.locator(".setup label input");
        await inputs.nth(0).fill("Manual");
        await inputs.nth(1).fill("manual-key");
        await page.getByRole("button", { name: "Add profile" }).click();
        await expect(page.getByText(/1 profile configured/)).toBeVisible();
        const stored = await page.evaluate(() =>
            localStorage.getItem("jellybean.kids.profiles"),
        );
        expect(JSON.parse(stored!)).toEqual([
            { name: "Manual", apiKey: "manual-key" },
        ]);
    });
});
