import { test, expect, type Page } from "@playwright/test";

// Durable offline-catalog cache (jellybean#107 P1).
//
// These tests prove the thing that changed: Browse / Tags / TagDetail
// responses now survive a full page reload because their cache backend is
// IndexedDB, not sessionStorage. They run entirely against the real
// production module (idbCache / idbEtags) driving real IndexedDB, with no
// Go backend and no Jellyfin - the harness page just imports the module.
//
// The full online -> offline -> reload-with-real-content path (SW poster
// art, actual /api revalidation) is exercised separately against the dev
// instance; this file isolates the durability guarantee.

const HARNESS = "/tests/harness/index.html";

async function gotoHarness(page: Page) {
    await page.goto(HARNESS);
    await page.waitForFunction(() => (window as unknown as { __idbReady?: boolean }).__idbReady === true);
}

const BROWSE_PAYLOAD = {
    rows: [
        {
            rowId: 7,
            title: "Dinosaurs",
            icon: "dinosaur",
            hasMore: false,
            items: [
                { Id: "abc123", Name: "Rex the Great", Type: "Movie" },
                { Id: "def456", Name: "Triceratops Tales", Type: "Series" },
            ],
        },
    ],
};

const KEY = "jellybean.kids.browse.cache.kid";
const ETAG = 'W/"catalog-v1"';

test.describe("durable browse cache", () => {
    test.beforeEach(async ({ page }) => {
        // Start from a clean DB so a prior run can't mask a regression.
        await gotoHarness(page);
        await page.evaluate(async () => {
            await new Promise<void>((resolve) => {
                const req = indexedDB.deleteDatabase("jellybean-kids");
                req.onsuccess = () => resolve();
                req.onerror = () => resolve();
                req.onblocked = () => resolve();
            });
        });
        await page.reload();
        await page.waitForFunction(() => (window as unknown as { __idbReady?: boolean }).__idbReady === true);
    });

    test("browse payload + etag survive a full reload", async ({ page }) => {
        // Write through the real backend, mirroring the hook's order:
        // etag first (so the cache backend picks it up), then the body.
        await page.evaluate(
            async ({ key, etag, payload }) => {
                const jb = (window as any).__jb;
                const cache = jb.idbCache("browse");
                const etags = jb.idbEtags("browse");
                etags.write(key, etag);
                await cache.write(key, payload);
            },
            { key: KEY, etag: ETAG, payload: BROWSE_PAYLOAD },
        );

        // Same-session read hits the cache.
        const before = await page.evaluate(async ({ key }) => {
            const jb = (window as any).__jb;
            return await jb.idbCache("browse").read(key);
        }, { key: KEY });
        expect(before).toEqual(BROWSE_PAYLOAD);

        // Full reload: the module + its in-memory etag map are re-created
        // from scratch, exactly as on an app restart.
        await page.reload();
        await page.waitForFunction(() => (window as unknown as { __idbReady?: boolean }).__idbReady === true);

        const after = await page.evaluate(async ({ key }) => {
            const jb = (window as any).__jb;
            const cache = jb.idbCache("browse");
            const etags = jb.idbEtags("browse");
            const body = await cache.read(key); // read() re-primes the etag map from IDB
            const etag = etags.read(key);
            return { body, etag };
        }, { key: KEY });

        // The body persisted (this is what sessionStorage could NOT do).
        expect(after.body).toEqual(BROWSE_PAYLOAD);
        // And the ETag is recoverable post-reload, so the next mount can
        // still send If-None-Match and get a 304 - the SWR behavior is
        // preserved, only its durability changed.
        expect(after.etag).toBe(ETAG);
    });

    test("stores are namespaced - tags cache is independent of browse", async ({ page }) => {
        await page.evaluate(async ({ key, payload }) => {
            const jb = (window as any).__jb;
            await jb.idbCache("browse").write(key, payload);
        }, { key: KEY, payload: BROWSE_PAYLOAD });

        await page.reload();
        await page.waitForFunction(() => (window as unknown as { __idbReady?: boolean }).__idbReady === true);

        // Same key string, different store -> no bleed.
        const tagsMiss = await page.evaluate(async ({ key }) => {
            const jb = (window as any).__jb;
            return await jb.idbCache("tags").read(key);
        }, { key: KEY });
        expect(tagsMiss).toBeNull();

        // And all four stores exist at the bumped schema version.
        const stores = await page.evaluate(() => (window as any).__jb.STORES);
        expect(stores).toEqual(["library", "browse", "tags", "tagDetail"]);
    });
});
