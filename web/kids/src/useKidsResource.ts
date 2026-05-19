// useKidsResource is the shared fetch dance for /api/kids/* JSON
// endpoints. Five consumer pages (Browse, Library, Tags, TagDetail,
// Watch) used to hand-roll the same sequence: build URL, withAuthRetry
// + authHeaders + same-origin credentials, on 401 clearSession +
// nav("/login"), on success setState, plus a per-page cancelled flag.
// Each page also bolted on its own cache (sessionStorage / IDB /
// in-memory). This hook collapses that duplication into one place.
//
// Behavior:
//   - On mount (or deps change), reads the cache synchronously when
//     possible (sync backends) or via promise (async backends like
//     IDB). When the cache hits, `data` is populated and `loading`
//     stays false; the network fetch still runs in the background and
//     updates `data` on success (stale-while-revalidate).
//   - On 401 in either the first request or the withAuthRetry retry,
//     clears the kid session, dispatches `jellybean:auth-expired` so
//     other resources mounted in the same page bounce too, and
//     navigates to /login. That same event is observed by the hook;
//     any sibling resource sees it and skips its own pending state
//     update without firing a duplicate redirect.
//   - Optional ETag round-trip (Library): when an `etag` backend is
//     supplied, the hook reads the cached etag, sends If-None-Match,
//     and treats 304 as "cache is current" (no state update; the
//     cached data is already on screen).
//
// The hook intentionally does NOT support: paginated load-more, POST
// requests, or any fetch where the consumer needs to react to the raw
// Response (e.g. inspecting a non-JSON body). Those stay manual at
// the call site - Library's load-more, Watch's favorite toggle, etc.

import { useCallback, useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { authHeaders, clearSession, withAuthRetry } from "./auth";

export type CacheBackend<T> = {
    read: (key: string) => Promise<T | null> | T | null;
    write: (key: string, value: T) => Promise<void> | void;
};

export type EtagBackend = {
    read: (key: string) => string | null;
    write: (key: string, etag: string) => void;
};

export type UseKidsResourceOptions<T> = {
    /** URL to fetch. Falsy disables the hook (`data` stays null,
     *  `loading` stays false). Useful for gating on "session not
     *  loaded yet" without changing render order. */
    url: string | null | undefined;
    /** Optional cache backend. Sync backends (sessionStorage,
     *  in-memory) deliver data synchronously on mount; async backends
     *  (IDB) deliver after the first microtask. */
    cache?: CacheBackend<T>;
    /** Cache key. Defaults to the URL when omitted - safe for
     *  single-shape endpoints, but Library / Browse pass an explicit
     *  key keyed by userId / profileId so two kids sharing a device
     *  can't see each other's cached data. */
    cacheKey?: string;
    /** Optional ETag round-trip. Library is the only consumer; Tags
     *  / Browse / TagDetail leave this off. */
    etag?: EtagBackend;
    /** Re-run the fetch when any of these change. Defaults to [url].
     *  Pass an empty array to fetch exactly once per mount. */
    deps?: ReadonlyArray<unknown>;
    /** When true, suppress the network fetch and only consume the
     *  cache. Used by Browse/Tags whose cached responses are
     *  intentionally pinned across remounts (kid backs out of /watch
     *  and expects the same poster strip / row order). The "Refresh
     *  from server" menu action is what invalidates them. */
    skipFetchWhenCacheHit?: boolean;
};

export type UseKidsResourceState<T> = {
    data: T | null;
    error: string | null;
    loading: boolean;
    /** True while a cache hit is showing AND a network revalidation
     *  is in flight. Flips back to false when revalidation lands
     *  (whether 200 or 304). */
    isStale: boolean;
    /** Set when a revalidation fetch failed but the cache is still
     *  rendering. Distinct from `error` (which signals "no data at
     *  all"). Two specific tokens: "unauthorized" (401 with cache;
     *  consumer probably wants a "Sign-in expired" pill) and any
     *  other error message string. Library renders this as its
     *  refresh-error banner. */
    refreshError: string | null;
    /** Triggers a fresh fetch ignoring any cache. Returns the same
     *  promise the internal effect would return so callers can await
     *  it (e.g. pull-to-refresh). */
    refresh: () => Promise<void>;
};

// AUTH_EXPIRED_EVENT lets one resource's 401 propagate to siblings
// mounted in the same page. Without it, two parallel hooks could each
// fire clearSession + nav("/login") and the second navigation would
// race the first. The dispatcher fires once; observers drop their
// pending state updates.
export const AUTH_EXPIRED_EVENT = "jellybean:auth-expired";

export function useKidsResource<T>(
    opts: UseKidsResourceOptions<T>,
): UseKidsResourceState<T> {
    const {
        url,
        cache,
        cacheKey,
        etag,
        skipFetchWhenCacheHit = false,
    } = opts;
    const deps = opts.deps ?? [url];

    const nav = useNavigate();
    const [data, setData] = useState<T | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [refreshError, setRefreshError] = useState<string | null>(null);
    const [loading, setLoading] = useState<boolean>(!!url);
    const [isStale, setIsStale] = useState<boolean>(false);

    // Refs so the run() closure can read them without becoming stale
    // across renders. Especially important for `cache` / `etag` -
    // consumers may pass freshly-constructed backend objects each
    // render (e.g. sessionCache()), and we don't want those identity
    // changes to retrigger the effect.
    const cacheRef = useRef(cache);
    const etagRef = useRef(etag);
    const cacheKeyRef = useRef(cacheKey);
    const skipFetchRef = useRef(skipFetchWhenCacheHit);
    const urlRef = useRef(url);
    cacheRef.current = cache;
    etagRef.current = etag;
    cacheKeyRef.current = cacheKey;
    skipFetchRef.current = skipFetchWhenCacheHit;
    urlRef.current = url;

    // run() reads from refs only so the function identity is stable
    // across renders. Bumping runIdRef in the effect cleanup serves
    // as the cancelled flag - any in-flight run() comparing its
    // captured myId against runIdRef will bail before calling
    // setState. StrictMode-safe: the double-mount cycle increments
    // runIdRef twice, the first run sees its id is stale + returns.
    const runIdRef = useRef(0);
    const run = useCallback(
        async (forceFresh: boolean): Promise<void> => {
            const myUrl = urlRef.current;
            if (!myUrl) return;
            const myId = ++runIdRef.current;
            const cacheBackend = cacheRef.current;
            const etagBackend = etagRef.current;
            const key = cacheKeyRef.current ?? myUrl;

            // Cache read. Sync backends settle in the same tick, so
            // `loading` flips to false before the first paint after
            // mount. Async backends (IDB) deliver after a microtask.
            let cached: T | null = null;
            if (!forceFresh && cacheBackend) {
                try {
                    const v = cacheBackend.read(key);
                    cached = v instanceof Promise ? await v : v;
                } catch {
                    cached = null;
                }
                if (myId !== runIdRef.current) return;
                if (cached !== null) {
                    setData(cached);
                    setLoading(false);
                    // skipFetchWhenCacheHit + no etag backend = the
                    // legacy "trust the cache until the user hits
                    // 'Refresh from server'" path. Browse / Tags /
                    // TagDetail used this before t60 to keep the
                    // stable random preview pinned across remounts.
                    //
                    // skipFetchWhenCacheHit + etag backend = the
                    // t60 path: we STILL fire the conditional GET so
                    // a server-side catalog_version bump can rotate
                    // the ETag and force a refresh. The 304 branch
                    // below leaves state alone (preserving the stable
                    // preview); a 200 swaps in the fresh body. This
                    // is what lets a parent's admin mutation show up
                    // on the TV without a manual refresh.
                    if (skipFetchRef.current && !etagBackend) {
                        setIsStale(false);
                        return;
                    }
                    setIsStale(true);
                }
            }

            try {
                const headers: Record<string, string> = { ...authHeaders() };
                let cachedEtag: string | null = null;
                if (!forceFresh && etagBackend && cached !== null) {
                    cachedEtag = etagBackend.read(key);
                    if (cachedEtag) headers["If-None-Match"] = cachedEtag;
                }
                const res = await withAuthRetry(() =>
                    fetch(myUrl, {
                        credentials: "same-origin",
                        headers,
                    }),
                );
                if (myId !== runIdRef.current) return;
                if (res.status === 304) {
                    setIsStale(false);
                    setLoading(false);
                    setError(null);
                    setRefreshError(null);
                    return;
                }
                if (!res.ok) {
                    if (res.status === 401) {
                        // If we have a cached payload, surface a
                        // dedicated refresh error and KEEP showing
                        // the cached data. Matches Library's old
                        // behavior where an expired session with a
                        // primed IDB cache doesn't kick the kid to
                        // /login mid-watch. Consumers can detect
                        // `refreshError === "unauthorized"` and
                        // render their own pill.
                        if (cached !== null) {
                            setRefreshError("unauthorized");
                            setIsStale(false);
                            setLoading(false);
                            return;
                        }
                        // No cache: sibling hooks bail their pending
                        // updates so we don't race two redirects,
                        // then we navigate. Observers bump runIdRef
                        // so any in-flight setState in their run()
                        // no-ops.
                        try {
                            window.dispatchEvent(new Event(AUTH_EXPIRED_EVENT));
                        } catch {
                            /* ignore */
                        }
                        clearSession();
                        nav("/login", { replace: true });
                        return;
                    }
                    const text = await res.text().catch(() => "");
                    throw new Error(`${res.status}${text ? `: ${text}` : ""}`);
                }
                const newEtag = res.headers.get("ETag") ?? "";
                const body = (await res.json()) as T;
                if (myId !== runIdRef.current) return;
                setData(body);
                setLoading(false);
                setIsStale(false);
                setError(null);
                setRefreshError(null);
                // Write etag BEFORE cache: the IDB cache backend
                // pulls the matching etag from the etag map at write
                // time, so the order matters. Sync backends ignore
                // it.
                if (etagBackend && newEtag) {
                    try {
                        etagBackend.write(key, newEtag);
                    } catch {
                        /* ignore */
                    }
                }
                if (cacheBackend) {
                    try {
                        const w = cacheBackend.write(key, body);
                        if (w instanceof Promise) w.catch(() => {});
                    } catch {
                        /* ignore */
                    }
                }
            } catch (err) {
                if (myId !== runIdRef.current) return;
                const msg = err instanceof Error ? err.message : "load failed";
                if (cached !== null) {
                    setRefreshError(msg);
                    // Leave isStale=true so consumers keep rendering
                    // their "still serving stale cache" UI (Library's
                    // "Offline - showing cached library" pill). Old
                    // hand-rolled Library never cleared cacheHit on
                    // fetch failure; clearing isStale here flashed
                    // the pill off the moment the fetch rejected.
                } else {
                    setError(msg);
                    setIsStale(false);
                }
                setLoading(false);
            }
        },
        [nav],
    );

    // Bind to the cross-resource auth-expired event. When another
    // hook's 401 fires it, every observer cancels its run by bumping
    // runIdRef so any in-flight run() comparing its captured myId
    // against runIdRef will bail before setState.
    useEffect(() => {
        const onExpired = () => {
            runIdRef.current++;
            setLoading(false);
            setIsStale(false);
        };
        window.addEventListener(AUTH_EXPIRED_EVENT, onExpired);
        return () => window.removeEventListener(AUTH_EXPIRED_EVENT, onExpired);
    }, []);

    // The fetch effect. Re-runs on any dep change.
    useEffect(() => {
        if (!url) {
            setLoading(false);
            return;
        }
        setLoading(true);
        setError(null);
        setRefreshError(null);
        void run(false);
        return () => {
            runIdRef.current++;
        };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, deps);

    const refresh = useCallback(() => run(true), [run]);

    return { data, error, loading, isStale, refreshError, refresh };
}
