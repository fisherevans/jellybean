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

// sessionEtagCache stores the per-key ETag returned by the server in
// sessionStorage so the next mount can hand it back as
// If-None-Match. Pairs with sessionCache(): same key, separate
// ".etag"-suffixed storage slot so the cached body and its ETag
// rotate independently when the server rewrites one without the
// other (defensive; in practice both move together).
//
// Used by Browse / Tags / TagDetail to opt into catalog_version-
// driven invalidation (t60): the page keeps showing its sessionStorage
// body on mount, fires a conditional GET in the background, and only
// swaps state when the server returns 200. Unchanged data stays put;
// a parent mutation rotates catalog_version, the server returns a
// new ETag with 200, and the kid sees the update without a manual
// "Refresh from server."
export function sessionEtagCache(): EtagBackend {
    const slot = (key: string) => `${key}.etag`;
    return {
        read: (key) => {
            try {
                return sessionStorage.getItem(slot(key));
            } catch {
                return null;
            }
        },
        write: (key, etag) => {
            try {
                if (etag) sessionStorage.setItem(slot(key), etag);
            } catch {
                /* ignore */
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
