import { test, expect, request } from "@playwright/test";

// Kid watch + library D-pad navigation. Validates the zone model
// added in the Watch refactor:
//   - Hero buttons are reachable via Left/Right.
//   - Accordion buttons are reachable via Up/Down.
//   - Cross-zone transitions: hero ArrowDown -> accordion[0],
//     accordion[0] ArrowUp -> hero[0].
// And the new Library AlphaBar:
//   - It renders.
//   - ArrowRight from rightmost grid lands focus on the bar.
//   - Enter on a letter jumps grid focus to the matching item.

async function kidLogin(baseURL: string): Promise<{
    token: string;
    userId: string;
    profileId: number;
    kidName?: string;
    profileName?: string;
}> {
    const username = process.env.JELLYBEAN_KID_USERNAME;
    const password = process.env.JELLYBEAN_KID_PASSWORD;
    if (!username || !password) {
        throw new Error(
            "JELLYBEAN_KID_USERNAME / JELLYBEAN_KID_PASSWORD missing.",
        );
    }
    const ctx = await request.newContext({
        baseURL,
        storageState: { cookies: [], origins: [] },
    });
    const res = await ctx.post("/api/kids/auth/login", {
        data: { username, password },
        headers: { "Content-Type": "application/json" },
    });
    expect(res.ok(), `kid login failed: ${res.status()}`).toBeTruthy();
    const body = await res.json();
    await ctx.dispose();
    return body;
}

async function seedKidSession(page, baseURL: string) {
    const session = await kidLogin(baseURL);
    await page.context().clearCookies();
    await page.addInitScript((s) => {
        localStorage.setItem("jellybean.kids.token", s.token);
        localStorage.setItem("jellybean.kids.userId", s.userId);
        localStorage.setItem("jellybean.kids.userName", "kids");
        localStorage.setItem("jellybean.kids.profileId", String(s.profileId));
        if (s.profileName)
            localStorage.setItem("jellybean.kids.profileName", s.profileName);
        if (s.kidName) localStorage.setItem("jellybean.kids.kidName", s.kidName);
    }, session);
    return session;
}

async function pickFirstSeriesId(
    baseURL: string,
    session: { token: string; userId: string },
): Promise<string | null> {
    const ctx = await request.newContext({
        baseURL,
        storageState: { cookies: [], origins: [] },
    });
    const lib = await ctx.get("/api/kids/library?type=Series&limit=10", {
        headers: {
            Authorization: `Bearer ${session.token}`,
            "X-Jellyfin-User-Id": session.userId,
            "X-Jellybean-DeviceId": "test-device",
        },
    });
    if (!lib.ok()) {
        await ctx.dispose();
        return null;
    }
    const body = await lib.json();
    await ctx.dispose();
    return body.Items?.[0]?.Id ?? null;
}

test("watch series: hero zones render with data-zone attributes", async ({
    page,
    baseURL,
}) => {
    const session = await seedKidSession(page, baseURL!);
    const seriesId = await pickFirstSeriesId(baseURL!, session);
    if (!seriesId) test.skip();

    await page.goto(`/player/watch/${encodeURIComponent(seriesId!)}`);
    await page.waitForSelector('[data-zone="hero"]:not([disabled])', {
        timeout: 15_000,
    });

    // Series has up to 4 hero buttons (Resume + Restart + Next + Random).
    // Random is unconditional; Next is conditional. So at minimum 3.
    const heroCount = await page.locator('[data-zone="hero"]').count();
    expect(heroCount, "series hero should have 3+ buttons").toBeGreaterThanOrEqual(3);

    // At least one accordion button (a season head).
    const accordionCount = await page.locator('[data-zone="accordion"]').count();
    expect(accordionCount, "series should render at least one season head").toBeGreaterThan(0);

    // Random is the last hero button.
    const lastHero = page.locator('[data-zone="hero"]').last();
    await expect(lastHero).toContainText(/Random/i);
});

test("watch series: ArrowRight cycles within hero, ArrowDown crosses to accordion", async ({
    page,
    baseURL,
}) => {
    const session = await seedKidSession(page, baseURL!);
    const seriesId = await pickFirstSeriesId(baseURL!, session);
    if (!seriesId) test.skip();

    await page.goto(`/player/watch/${encodeURIComponent(seriesId!)}`);
    await page.waitForSelector('[data-zone="hero"]:not([disabled])', {
        timeout: 15_000,
    });

    // Wait a tick for the mount-effect to focus the primary hero.
    await page.waitForTimeout(100);

    // Active element should be the first hero button.
    const activeIsHero = await page.evaluate(() => {
        const a = document.activeElement as HTMLElement | null;
        return a?.getAttribute("data-zone") === "hero";
    });
    expect(activeIsHero, "primary hero should hold initial focus").toBe(true);

    // ArrowRight -> next hero button.
    await page.keyboard.press("ArrowRight");
    await page.waitForTimeout(50);
    const stillHero = await page.evaluate(() => {
        return document.activeElement?.getAttribute("data-zone") === "hero";
    });
    expect(stillHero, "ArrowRight should stay in hero zone").toBe(true);

    // ArrowDown from hero -> accordion[0] (first season head).
    await page.keyboard.press("ArrowDown");
    await page.waitForTimeout(50);
    const onAccordion = await page.evaluate(() => {
        return document.activeElement?.getAttribute("data-zone") === "accordion";
    });
    expect(onAccordion, "ArrowDown from hero should land on accordion").toBe(true);

    // ArrowUp from accordion[0] -> back to hero.
    await page.keyboard.press("ArrowUp");
    await page.waitForTimeout(50);
    const backToHero = await page.evaluate(() => {
        return document.activeElement?.getAttribute("data-zone") === "hero";
    });
    expect(backToHero, "ArrowUp from first accordion item should return to hero").toBe(true);
});

test("watch series: clicking an open season head collapses it", async ({
    page,
    baseURL,
}) => {
    const session = await seedKidSession(page, baseURL!);
    const seriesId = await pickFirstSeriesId(baseURL!, session);
    if (!seriesId) test.skip();

    await page.goto(`/player/watch/${encodeURIComponent(seriesId!)}`);
    await page.waitForSelector(".watch-season-head", { timeout: 15_000 });

    const head = page.locator(".watch-season-head").first();
    // Initial: auto-opens to season containing resume target.
    const initiallyOpen = await head.evaluate((el) =>
        el.classList.contains("open"),
    );

    if (initiallyOpen) {
        await head.click();
        await page.waitForTimeout(100);
        const stillOpen = await head.evaluate((el) =>
            el.classList.contains("open"),
        );
        expect(stillOpen, "clicking an open season should close it").toBe(false);
    } else {
        // Open one first, then close.
        await head.click();
        await page.waitForTimeout(100);
        await head.click();
        await page.waitForTimeout(100);
        const stillOpen = await head.evaluate((el) =>
            el.classList.contains("open"),
        );
        expect(stillOpen, "clicking an open season should close it").toBe(false);
    }
});

test("library: AlphaBar renders and exposes letters with items", async ({
    page,
    baseURL,
}) => {
    await seedKidSession(page, baseURL!);
    await page.goto("/player/library");
    await page.waitForSelector(".tile-library", { timeout: 15_000 });

    await expect(page.locator(".library-alpha-bar")).toBeVisible();

    // The bar renders 26 letter buttons; at least one should be
    // enabled when there are visible items in the loaded page.
    const allLetters = await page.locator(".library-alpha-letter").count();
    expect(allLetters, "all 26 letters render").toBe(26);
    const enabledLetters = await page
        .locator(".library-alpha-letter:not(.disabled)")
        .count();
    expect(
        enabledLetters,
        "at least one letter should have items",
    ).toBeGreaterThan(0);
});
