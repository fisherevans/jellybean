// libraryCache: an IndexedDB-backed key/value store for cached
// /api/kids/library responses. Pairs with the server's ETag header to
// implement stale-while-revalidate: render the cached page immediately
// on mount, then revalidate against the server with `If-None-Match`.
//
// Failure modes: every operation is wrapped in try/catch and resolves to
// a no-op (or null) on error. IDB unavailability or quota errors must
// never break the app; the worst case is a fresh fetch.
//
// Schema:
//   db   : "jellybean-kids"
//   store: "library" (out-of-line keys; key is the cacheKey() string)
//   value: { page, etag, savedAt }
//
// The userId is part of the key itself, not just the DB name, so two
// kids signing in on the same device can't accidentally cross over.
// `clear()` is invoked from `clearSession()` to wipe the previous kid's
// data on sign-out.

const DB_NAME = "jellybean-kids";
const DB_VERSION = 1;
const STORE = "library";

// LibraryResponse is structurally compatible with the type in
// Library.tsx. Kept loose here so we don't need to publish the full
// shape from a separate types module; the cache treats the body as
// opaque JSON.
export type LibraryResponse = {
    Items: unknown[] | null;
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

// cacheKey is the canonical key shape. Including userId scopes entries
// to a specific kid so device-shared installs don't leak across
// accounts. Section / type / paging / search are everything the server
// keys its ETag on; matching those here means hits map 1:1 to ETags.
export function cacheKey(
    userId: string,
    section: string,
    type: string,
    limit: number,
    startIndex: number,
    search: string,
): string {
    return `${userId}:${section}:${type}:${limit}:${startIndex}:${search}`;
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
                if (!db.objectStoreNames.contains(STORE)) {
                    db.createObjectStore(STORE);
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

export async function get(key: string): Promise<CachedPage | null> {
    try {
        const db = await openDB();
        if (!db) return null;
        return await new Promise<CachedPage | null>((resolve) => {
            try {
                const tx = db.transaction(STORE, "readonly");
                const req = tx.objectStore(STORE).get(key);
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
    key: string,
    page: LibraryResponse,
    etag: string,
): Promise<void> {
    try {
        const db = await openDB();
        if (!db) return;
        await new Promise<void>((resolve) => {
            try {
                const tx = db.transaction(STORE, "readwrite");
                const value: StoredValue = { page, etag, savedAt: Date.now() };
                tx.objectStore(STORE).put(value, key);
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

export async function clear(): Promise<void> {
    try {
        const db = await openDB();
        if (!db) return;
        await new Promise<void>((resolve) => {
            try {
                const tx = db.transaction(STORE, "readwrite");
                tx.objectStore(STORE).clear();
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
