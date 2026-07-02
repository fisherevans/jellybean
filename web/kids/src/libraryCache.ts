// libraryCache: an IndexedDB-backed key/value store for cached
// /api/kids/* responses. Pairs with the server's ETag header to
// implement stale-while-revalidate: render the cached page immediately
// on mount, then revalidate against the server with `If-None-Match`.
//
// Originally this held only the /api/kids/library response (hence the
// name). As of jellybean#107 P1 it is the durable backing store for
// every catalog/curation surface the kid browses, so it can still find
// content when the Jellybean backend is unreachable (Jellyfin/LAN still
// up - the degraded-offline scope). Each surface gets its own object
// store; the value shape and ETag round-trip are identical across them.
//
// Failure modes: every operation is wrapped in try/catch and resolves to
// a no-op (or null) on error. IDB unavailability or quota errors must
// never break the app; the worst case is a fresh fetch (i.e. behaves
// exactly like today, online).
//
// Schema:
//   db   : "jellybean-kids" (v2)
//   stores (all out-of-line keys; key is the consumer's cacheKey string):
//     "library"   - GET /api/kids/library     (paged; key baked from paging params)
//     "browse"    - GET /api/kids/browse      (key: profileId-scoped)
//     "tags"      - GET /api/kids/tags        (key: profileId-scoped)
//     "tagDetail" - GET /api/kids/tags/{id}   (key: tag+profile+filter+sort)
//   value: { page, etag, savedAt }   (page is opaque JSON to this layer)
//
// The consumer bakes any scoping (userId / profileId) into the key
// itself, so two kids signing in on the same device can't cross over.
// `clear()` wipes ALL stores; it's invoked from `clearSession()` on
// sign-out and from the "Refresh from server" menu action.

const DB_NAME = "jellybean-kids";
const DB_VERSION = 2;

// STORES is the full set of object stores. openDB creates any that are
// missing on upgrade, so bumping DB_VERSION + adding a name here is all
// it takes to add a durable surface.
export const STORES = ["library", "browse", "tags", "tagDetail"] as const;
export type IdbStore = (typeof STORES)[number];

// LibraryResponse is the loose shape the library page happens to use.
// This layer treats every stored body as opaque JSON (see StoredValue),
// so the name is historical; browse/tags/tagDetail bodies flow through
// the same get/set unchanged and are cast at the call site in kidsCache.
export type LibraryResponse = {
    Items?: unknown[] | null;
    HasMore?: boolean;
    NextStartIndex?: number;
    ProfileId?: number;
    [key: string]: unknown;
};

export type CachedPage = {
    page: LibraryResponse;
    etag: string;
};

type StoredValue = {
    page: LibraryResponse;
    etag: string;
    savedAt: number;
};

// cacheKey is the canonical key shape for the library store. Including
// userId scopes entries to a specific kid so device-shared installs
// don't leak across accounts. Section / type / paging / search are
// everything the server keys its ETag on; matching those here means
// hits map 1:1 to ETags. Browse / Tags / TagDetail build their own
// keys inline (they have different scoping dimensions).
export function cacheKey(
    userId: string,
    section: string,
    type: string,
    limit: number,
    startIndex: number,
    search: string,
    sort: string,
): string {
    return `${userId}:${section}:${type}:${limit}:${startIndex}:${search}:${sort}`;
}

function openDB(): Promise<IDBDatabase | null> {
    return new Promise((resolve) => {
        try {
            if (typeof indexedDB === "undefined") {
                resolve(null);
                return;
            }
            const req = indexedDB.open(DB_NAME, DB_VERSION);
            req.onupgradeneeded = () => {
                const db = req.result;
                // Create any missing store. Additive across versions:
                // a v1 DB (library only) keeps its data and gains the
                // new stores; a fresh install gets all of them.
                for (const store of STORES) {
                    if (!db.objectStoreNames.contains(store)) {
                        db.createObjectStore(store);
                    }
                }
            };
            req.onsuccess = () => resolve(req.result);
            req.onerror = () => {
                console.warn("libraryCache: openDB failed", req.error);
                resolve(null);
            };
            req.onblocked = () => {
                console.warn("libraryCache: openDB blocked");
                resolve(null);
            };
        } catch (err) {
            console.warn("libraryCache: openDB threw", err);
            resolve(null);
        }
    });
}

export async function get(
    store: IdbStore,
    key: string,
): Promise<CachedPage | null> {
    try {
        const db = await openDB();
        if (!db) return null;
        return await new Promise<CachedPage | null>((resolve) => {
            try {
                const tx = db.transaction(store, "readonly");
                const req = tx.objectStore(store).get(key);
                req.onsuccess = () => {
                    const v = req.result as StoredValue | undefined;
                    if (!v) {
                        resolve(null);
                        return;
                    }
                    resolve({ page: v.page, etag: v.etag });
                };
                req.onerror = () => {
                    console.warn("libraryCache: get failed", req.error);
                    resolve(null);
                };
                tx.oncomplete = () => db.close();
                tx.onerror = () => db.close();
                tx.onabort = () => db.close();
            } catch (err) {
                console.warn("libraryCache: get threw", err);
                db.close();
                resolve(null);
            }
        });
    } catch (err) {
        console.warn("libraryCache: get outer", err);
        return null;
    }
}

export async function set(
    store: IdbStore,
    key: string,
    page: LibraryResponse,
    etag: string,
): Promise<void> {
    try {
        const db = await openDB();
        if (!db) return;
        await new Promise<void>((resolve) => {
            try {
                const tx = db.transaction(store, "readwrite");
                const value: StoredValue = { page, etag, savedAt: Date.now() };
                tx.objectStore(store).put(value, key);
                tx.oncomplete = () => {
                    db.close();
                    resolve();
                };
                tx.onerror = () => {
                    console.warn("libraryCache: set tx error", tx.error);
                    db.close();
                    resolve();
                };
                tx.onabort = () => {
                    console.warn("libraryCache: set tx abort", tx.error);
                    db.close();
                    resolve();
                };
            } catch (err) {
                console.warn("libraryCache: set threw", err);
                db.close();
                resolve();
            }
        });
    } catch (err) {
        console.warn("libraryCache: set outer", err);
    }
}

// clear wipes every store in one transaction. Used on sign-out (so the
// next kid can't see the previous kid's catalog) and by "Refresh from
// server" (so a forced reload re-fetches everything). Best-effort: any
// IDB failure is swallowed so the caller (sign-out) always succeeds.
export async function clear(): Promise<void> {
    try {
        const db = await openDB();
        if (!db) return;
        await new Promise<void>((resolve) => {
            try {
                const tx = db.transaction(STORES, "readwrite");
                for (const store of STORES) {
                    tx.objectStore(store).clear();
                }
                tx.oncomplete = () => {
                    db.close();
                    resolve();
                };
                tx.onerror = () => {
                    console.warn("libraryCache: clear tx error", tx.error);
                    db.close();
                    resolve();
                };
                tx.onabort = () => {
                    console.warn("libraryCache: clear tx abort", tx.error);
                    db.close();
                    resolve();
                };
            } catch (err) {
                console.warn("libraryCache: clear threw", err);
                db.close();
                resolve();
            }
        });
    } catch (err) {
        console.warn("libraryCache: clear outer", err);
    }
}
