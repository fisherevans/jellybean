// kidsCache provides three small CacheBackend factories used by
// useKidsResource consumers. Kept intentionally minimal - each is
// just a {read, write} pair - because there are only three storage
// flavors in play across the kid pages and a heavier abstraction
// (TTLs, namespaces, eviction) would obscure the call sites.
//
// Backends:
//   memoryCache<T>()      - per-mount in-process Map. Useful when
//                           a page wants to avoid refetching during
//                           a single mount but doesn't need to
//                           survive route changes.
//   sessionCache<T>()     - sessionStorage JSON blob. Survives
//                           route changes within the same tab,
//                           wipes on tab close. Browse / Tags /
//                           TagDetail use this so back-from-/watch
//                           lands instantly on the previous page
//                           state without a fetch flash.
//   idbLibraryCache()     - IndexedDB-backed. Used by Library so
//                           the cached library survives reloads /
//                           restarts and pairs with the server's
//                           ETag round-trip.
//   idbLibraryEtags()     - in-memory mirror of the etags written
//                           alongside Library cache entries. Pulls
//                           from the same IDB record (libraryCache
//                           stores {page, etag, savedAt} per key)
//                           so the hook can supply If-None-Match
//                           without a second IDB read per fetch.

import {
    cacheKey as buildLibraryKey,
    get as libraryCacheGet,
    set as libraryCacheSet,
    type LibraryResponse,
} from "./libraryCache";
import type { CacheBackend, EtagBackend } from "./useKidsResource";

export { buildLibraryKey };
export type { LibraryResponse };

export function memoryCache<T>(): CacheBackend<T> {
    const m = new Map<string, T>();
    return {
        read: (key) => m.get(key) ?? null,
        write: (key, value) => {
            m.set(key, value);
        },
    };
}

export function sessionCache<T>(): CacheBackend<T> {
    return {
        read: (key) => {
            try {
                const raw = sessionStorage.getItem(key);
                if (!raw) return null;
                return JSON.parse(raw) as T;
            } catch {
                return null;
            }
        },
        write: (key, value) => {
            try {
                sessionStorage.setItem(key, JSON.stringify(value));
            } catch {
                /* quota exceeded / disabled - ignore, the page just
                 * pays the next-mount fetch flash. */
            }
        },
    };
}

// idbLibraryCache + idbLibraryEtags share a tiny in-memory etag map
// so the hook's first read primes the etag for the subsequent
// If-None-Match. The IDB read returns {page, etag}; we stash the
// etag here and let the EtagBackend pull it back in the same tick
// without re-reading IDB.
const lastEtags = new Map<string, string>();

// idbLibraryCache is generic over the consumer's local response type
// so Library can pass its tighter `LibraryResponse` (with its
// LibraryItem[] Items shape) without TS rejecting the looser
// libraryCache.LibraryResponse signature. The cast is sound because
// the consumer is the only writer + the cacheKey scopes by userId,
// so we never read shape-mismatched data on a successful round trip.
export function idbLibraryCache<T = LibraryResponse>(): CacheBackend<T> {
    return {
        read: async (key) => {
            const v = await libraryCacheGet(key);
            if (!v) return null;
            lastEtags.set(key, v.etag);
            return v.page as unknown as T;
        },
        write: async (key, value) => {
            const etag = lastEtags.get(key) ?? "";
            await libraryCacheSet(key, value as unknown as LibraryResponse, etag);
        },
    };
}

export function idbLibraryEtags(): EtagBackend {
    return {
        read: (key) => lastEtags.get(key) ?? null,
        write: (key, etag) => {
            lastEtags.set(key, etag);
        },
    };
}
