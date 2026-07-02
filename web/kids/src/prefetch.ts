// prefetch: warm the library cache off the critical path.
//
// Triggered from the Index gate (on app open / session-restore) and from
// Login (right after a successful sign-in, before the navigate to
// /library). The goal is to start the library fetch *before* the user
// lands on Library, so by the time Library mounts the IDB cache is hot
// and the network revalidation is already complete (or in flight).
//
// Cache key composition must match Library.tsx exactly. If they drift,
// Library will miss its own warmed entries and the prefetch is wasted.
//
// Failure modes are all swallowed: this is opportunistic warmup, not
// load-bearing. A 401, a network error, or an IDB write failure all
// resolve to no-op. The user will hit the regular Library load path on
// the next navigate.

import { authHeaders, getSession } from "./auth";
import {
    cacheKey as buildCacheKey,
    get as cacheGet,
    set as cacheSet,
    type LibraryResponse,
} from "./libraryCache";

// Match Library.tsx defaults. Filter defaults to "All" -> Movie,Series.
const DEFAULT_TYPE = "Movie,Series";
const DEFAULT_SECTION = "all";
const DEFAULT_LIMIT = 24;
const DEFAULT_START = 0;
const DEFAULT_SEARCH = "";
const DEFAULT_SORT = "name";

// Single in-flight gate. If a prefetch is already running (e.g. Login
// fired one and the post-login navigate triggers Index which would fire
// another), the second call is a no-op. This is also the reason
// Library.tsx isn't a trigger site: its own mount fetch is the
// authoritative path, and we don't want to race it.
let inflight: Promise<void> | null = null;

export function prefetchLibrary(): void {
    if (inflight) return;
    const session = getSession();
    if (!session) return;
    inflight = run(session.userId)
        .catch(() => {})
        .finally(() => {
            inflight = null;
        });
}

async function run(userId: string): Promise<void> {
    const key = buildCacheKey(
        userId,
        DEFAULT_SECTION,
        DEFAULT_TYPE,
        DEFAULT_LIMIT,
        DEFAULT_START,
        DEFAULT_SEARCH,
        DEFAULT_SORT,
    );

    // Read any existing etag so the server can short-circuit with 304.
    let ifNoneMatch: string | undefined;
    try {
        const cached = await cacheGet("library", key);
        if (cached?.etag) ifNoneMatch = cached.etag;
    } catch {
        // Ignore; we'll just do an unconditional GET.
    }

    const url = new URL("/api/kids/library", window.location.origin);
    url.searchParams.set("section", DEFAULT_SECTION);
    url.searchParams.set("type", DEFAULT_TYPE);
    url.searchParams.set("limit", String(DEFAULT_LIMIT));
    url.searchParams.set("sort", DEFAULT_SORT);

    const headers: Record<string, string> = { ...authHeaders() };
    if (ifNoneMatch) headers["If-None-Match"] = ifNoneMatch;

    const res = await fetch(url.toString(), {
        credentials: "same-origin",
        headers,
    });
    if (res.status === 304) return;
    if (!res.ok) return;
    const etag = res.headers.get("ETag") ?? "";
    const page = (await res.json()) as LibraryResponse;
    if (etag) {
        await cacheSet("library", key, page, etag);
    }
}
