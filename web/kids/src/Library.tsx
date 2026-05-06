import { useCallback, useEffect, useRef, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import {
    authHeaders,
    clearSession,
    getSession,
    probeAdmin,
    withAuthRetry,
    type AdminUser,
    type Session,
} from "./auth";
import MainMenuModal from "./MainMenuModal";
import Tile from "./Tile";
import {
    cacheKey as buildCacheKey,
    get as cacheGet,
    set as cacheSet,
} from "./libraryCache";
import { useOnlineStatus } from "./onlineStatus";
import AlphaBar, { firstIndexByLetter } from "./AlphaBar";
import OverrideModal, { useLongPressUp } from "./OverrideModal";
import TabPill, { TAB_SLOT_COUNT, tabHref } from "./TabPill";
import {
    scrollTileIntoRowStart,
    scrollWindowToCenter,
    scrollWindowToTop,
} from "./smoothScroll";
import { useProgressiveBack } from "./useProgressiveBack";
import { shouldShowWatchMenu } from "./Watch";

// Library is the kid's main browsing screen. Layout top-to-bottom:
//
//   [type filter: Both | Movies | TV]
//   [Continue Watching row (scroll-x), hidden if empty]
//   [main grid - infinite paginated]
//
// All three regions participate in a single D-pad focus model. State
// shape: a discriminated union for what's focused, plus an index. Keys
// move focus; on focus change, we ensure the focused element is scrolled
// into view. Enter / Space / Click on a tile navigates to playback.
//
// Auth paths:
//   - Kid path: a Session is in localStorage (token + userId + profileId).
//     Bearer token + Jellyfin user id + deviceId go in headers.
//   - Admin path: ?profileId=N in the URL; admin cookie auths the request.

type LibraryItem = {
    Id: string;
    Name: string;
    Type: string;
    ImageTags?: { Primary?: string };
    UserData?: { PlaybackPositionTicks?: number; PlayedPercentage?: number };
};

type LibraryResponse = {
    Items: LibraryItem[] | null;
    HasMore?: boolean;
    NextStartIndex?: number;
    ProfileId?: number;
};

type TypeFilter = "Both" | "Movies" | "TV";

const FILTER_STORAGE = "jellybean.kids.typeFilter";
const TYPE_FILTERS: TypeFilter[] = ["Both", "Movies", "TV"];

function filterToType(t: TypeFilter): string {
    return t === "Movies" ? "Movie" : t === "TV" ? "Series" : "Movie,Series";
}

type Focus =
    | { kind: "tab"; index: number }
    | { kind: "search" }
    | { kind: "filter"; index: number }
    | { kind: "cw"; index: number }
    | { kind: "grid"; index: number }
    | { kind: "alpha"; index: number };

const ALPHA_LETTERS = "ABCDEFGHIJKLMNOPQRSTUVWXYZ".split("");

const PAGE_SIZE = 24;

export default function Library() {
    const nav = useNavigate();
    const [searchParams] = useSearchParams();
    const [session] = useState<Session | null>(() => getSession());
    const [admin, setAdmin] = useState<AdminUser | null | undefined>(undefined);
    const adminProfileId = searchParams.get("profileId");

    // Save scroll position on unmount so a kid returning from /play
    // lands where they were. Restore happens in a second effect below
    // that waits for content to render - on mount the items are still
    // loading from IDB (Promise-resolved), so scrolling to Y here would
    // be clamped to 0 because the grid has no height yet.
    useEffect(() => {
        return () => {
            sessionStorage.setItem(
                "jellybean.kids.library.scrollY",
                String(window.scrollY),
            );
        };
    }, []);
    const restoredScrollRef = useRef(false);
    // Preserve search params (e.g. admin's profileId) when navigating to
    // /play so the back link can return to the same filtered library
    // view. Real kid users have no search params; this is a no-op for them.
    const playSuffix = searchParams.toString() ? `?${searchParams.toString()}` : "";

    const [filter, setFilter] = useState<TypeFilter>(() => {
        const v = localStorage.getItem(FILTER_STORAGE);
        return TYPE_FILTERS.includes(v as TypeFilter) ? (v as TypeFilter) : "Both";
    });
    // Search box (M8 #49). Server-side filter via /api/kids/library
    // ?search=. Debounced through `searchDebounced` so each keystroke
    // doesn't fire a request. Empty string means "no name filter."
    const [searchInput, setSearchInput] = useState("");
    const [searchDebounced, setSearchDebounced] = useState("");
    useEffect(() => {
        const id = window.setTimeout(() => setSearchDebounced(searchInput), 300);
        return () => window.clearTimeout(id);
    }, [searchInput]);

    const [continueItems, setContinueItems] = useState<LibraryItem[]>([]);
    const [items, setItems] = useState<LibraryItem[]>([]);
    const [hasMore, setHasMore] = useState(false);
    const [nextStart, setNextStart] = useState(0);
    const [loading, setLoading] = useState(true);
    const [loadingMore, setLoadingMore] = useState(false);
    const [error, setError] = useState<string | null>(null);
    // refreshError: separate from `error` so a background revalidation
    // failure doesn't replace the cached UI with an error screen. Shown
    // as a small inline string under the heading; the cached items stay
    // on screen.
    const [refreshError, setRefreshError] = useState<string | null>(null);
    // cacheHit: did this render of the library come from IDB? Drives the
    // offline pill - we only claim "showing cached library" when we
    // actually have cached content on screen.
    const [cacheHit, setCacheHit] = useState(false);
    // Bumped when the browser reports we came back online, to force the
    // load effect to re-run. The cache keys can't change on their own
    // (filter / session are stable), so we need an explicit nudge.
    const [retryNonce, setRetryNonce] = useState(0);
    const online = useOnlineStatus();

    const [focus, setFocus] = useState<Focus>({ kind: "search" });
    const tileRefs = useRef<Record<string, HTMLButtonElement | null>>({});
    // Two refs for the search affordance:
    //   searchWrapRef - the D-pad target (a tabbable div wrapping the
    //                   input). Focusing this does NOT open the IME.
    //                   Must be a div, not a <button>, because HTML5
    //                   forbids <input> as a descendant of <button> -
    //                   the parser would auto-close the button before
    //                   the input, leaving them as siblings, and the
    //                   wrap ref would land on a now-empty button.
    //   searchInputRef - the actual <input>. Focused on Enter, which
    //                    opens the IME on Android TV.
    const searchWrapRef = useRef<HTMLDivElement | null>(null);
    const searchInputRef = useRef<HTMLInputElement | null>(null);
    const sentinelRef = useRef<HTMLDivElement | null>(null);
    const [menuOpen, setMenuOpen] = useState(false);
    // Adult-override gesture (M9): long-press UP on a focused tile
    // opens the override modal targeting that item. Mirrors Browse.
    const [override, setOverride] = useState<{
        itemId: string;
        itemName: string;
    } | null>(null);

    useEffect(() => {
        probeAdmin().then(setAdmin);
    }, []);

    useEffect(() => {
        localStorage.setItem(FILTER_STORAGE, filter);
    }, [filter]);

    // When the browser flips back to online, re-trigger the load effect
    // so we revalidate against the server. The transition is what
    // matters; we don't refetch on every render while online is true.
    const wasOnline = useRef(online);
    useEffect(() => {
        if (!wasOnline.current && online) {
            setRetryNonce((n) => n + 1);
        }
        wasOnline.current = online;
    }, [online]);

    const buildURL = useCallback(
        (section: "all" | "continue-watching", startIndex: number) => {
            const url = new URL("/api/kids/library", window.location.origin);
            url.searchParams.set("section", section);
            url.searchParams.set("type", filterToType(filter));
            url.searchParams.set("limit", String(PAGE_SIZE));
            if (startIndex > 0) {
                url.searchParams.set("startIndex", String(startIndex));
            }
            // Search applies to the main grid. Continue Watching is a
            // small explicit list; filtering it would mostly produce
            // empty rows, so leave it alone.
            if (section === "all" && searchDebounced) {
                url.searchParams.set("search", searchDebounced);
            }
            if (adminProfileId) url.searchParams.set("profileId", adminProfileId);
            return url.toString();
        },
        [filter, adminProfileId, searchDebounced],
    );

    // fetchSection issues the network request, optionally with an
    // If-None-Match header for stale-while-revalidate. Returns either:
    //   - { status: "modified", page, etag }    full body to render + store
    //   - { status: "not-modified", etag }      caller keeps cached state
    // HTTP 4xx/5xx still throw so handlers route them through `error`.
    const fetchSection = useCallback(
        async (
            section: "all" | "continue-watching",
            startIndex: number,
            ifNoneMatch?: string,
        ): Promise<
            | { status: "modified"; page: LibraryResponse; etag: string }
            | { status: "not-modified"; etag: string }
        > => {
            const headers: Record<string, string> = { ...authHeaders() };
            if (ifNoneMatch) headers["If-None-Match"] = ifNoneMatch;
            // withAuthRetry: tolerate one transient 401 before
            // throwing UNAUTHORIZED. Real revocation still 401s on
            // retry; the cache-fallback branch downstream still
            // applies (it gates on haveCache, not on whether the
            // retry happened).
            const res = await withAuthRetry(() =>
                fetch(buildURL(section, startIndex), {
                    credentials: "same-origin",
                    headers,
                }),
            );
            const etag = res.headers.get("ETag") ?? "";
            if (res.status === 304) {
                return { status: "not-modified", etag };
            }
            if (!res.ok) {
                if (res.status === 401) {
                    // Stale bearer (kid token expired). Surface a
                    // distinct error type so the caller can wipe local
                    // session + redirect to /login.
                    const e = new Error("unauthorized");
                    (e as Error & { code?: string }).code = "UNAUTHORIZED";
                    throw e;
                }
                throw new Error(`${res.status}: ${await res.text()}`);
            }
            const page = (await res.json()) as LibraryResponse;
            return { status: "modified", page, etag };
        },
        [buildURL],
    );

    // useCache: false in admin-preview (no session means no userId to key
    // by). Admin previewing always does live fetches. Search results
    // also skip the cache - they're inherently transient and we don't
    // want every keystroke seeded into IDB.
    const useCache = !!session && !adminProfileId && !searchDebounced;
    const userId = session?.userId ?? "";
    const typeStr = filterToType(filter);
    const allKey = useCache
        ? buildCacheKey(userId, "all", typeStr, PAGE_SIZE, 0, "")
        : null;
    const cwKey = useCache
        ? buildCacheKey(userId, "continue-watching", typeStr, PAGE_SIZE, 0, "")
        : null;

    // Initial load (and re-load on filter change). Reads cached pages
    // first (if any) and renders them immediately, then revalidates with
    // If-None-Match. 304 keeps the cache; 200 replaces it; network
    // failure leaves the cached tiles in place and surfaces a small
    // refresh-failed indicator.
    useEffect(() => {
        if (admin === undefined) return;
        if (!session && !adminProfileId) {
            nav("/login", { replace: true });
            return;
        }
        let cancelled = false;
        setError(null);
        setRefreshError(null);
        setCacheHit(false);
        // Don't pre-flip to `loading=true`. If the cache has the new
        // filter's tiles we'll render them on the very next tick; the
        // current filter's tiles stay on screen in the meantime so
        // switching filters never flashes a spinner. We only set
        // `loading=true` below when the cache read confirms a miss
        // *and* we're going to need to wait on the network.
        setNextStart(0);
        setHasMore(false);

        // Cache keys are null in admin-preview mode (no userId).
        const allK = allKey;
        const cwK = cwKey;

        // Etags we send back as If-None-Match. Populated synchronously
        // from the cache reads below.
        let allEtag: string | undefined;
        let cwEtag: string | undefined;

        const cacheReads = (async () => {
            if (!allK && !cwK) {
                // Admin-preview: no cache to consult. Show the spinner
                // until the network resolves so the previous filter's
                // tiles aren't left lingering as a fake.
                setLoading(true);
                setItems([]);
                setContinueItems([]);
                return;
            }
            const [allHit, cwHit] = await Promise.all([
                allK ? cacheGet(allK) : Promise.resolve(null),
                cwK ? cacheGet(cwK) : Promise.resolve(null),
            ]);
            if (cancelled) return;
            if (allHit) {
                const cached = allHit.page as LibraryResponse;
                setItems(cached.Items ?? []);
                setHasMore(!!cached.HasMore);
                setNextStart(cached.NextStartIndex ?? (cached.Items?.length ?? 0));
                allEtag = allHit.etag;
                // Cached content is rendered: drop the spinner.
                setLoading(false);
                setCacheHit(true);
            } else {
                // No cache: blank the grid so we don't show stale items
                // from the previous filter while the network resolves,
                // and surface the spinner since we're waiting.
                setItems([]);
                setLoading(true);
            }
            if (cwHit) {
                const cached = cwHit.page as LibraryResponse;
                setContinueItems(cached.Items ?? []);
                cwEtag = cwHit.etag;
                setLoading(false);
                setCacheHit(true);
            } else {
                setContinueItems([]);
            }
        })();

        cacheReads
            .then(() =>
                Promise.all([
                    fetchSection("all", 0, allEtag),
                    fetchSection("continue-watching", 0, cwEtag),
                ]),
            )
            .then(([all, cw]) => {
                if (cancelled) return;
                if (all.status === "modified") {
                    setItems(all.page.Items ?? []);
                    setHasMore(!!all.page.HasMore);
                    setNextStart(
                        all.page.NextStartIndex ?? (all.page.Items?.length ?? 0),
                    );
                    if (allK && all.etag) {
                        cacheSet(allK, all.page, all.etag).catch(() => {});
                    }
                }
                if (cw.status === "modified") {
                    setContinueItems(cw.page.Items ?? []);
                    if (cwK && cw.etag) {
                        cacheSet(cwK, cw.page, cw.etag).catch(() => {});
                    }
                }
                setLoading(false);
                setRefreshError(null);
                // Live data won. We're no longer "showing cached" - flip
                // the pill off even if the browser still thinks it's
                // offline (captive portals etc.).
                setCacheHit(false);
            })
            .catch((err) => {
                if (cancelled) return;
                const isUnauthorized =
                    err &&
                    typeof err === "object" &&
                    (err as { code?: string }).code === "UNAUTHORIZED";
                const haveCache =
                    allEtag !== undefined || cwEtag !== undefined;
                // 401 with no cache to fall back on -> bearer is bust
                // and we can't render anything; redirect to /login.
                if (isUnauthorized && !haveCache) {
                    clearSession();
                    nav("/login", { replace: true });
                    return;
                }
                // 401 with cache: keep showing the cached library so
                // the kid isn't yanked to /login mid-browse, but flag
                // the stale auth via the refresh-error pill so the
                // kid (or a parent) sees something's off. The next
                // nav that requires fresh data will redirect.
                if (haveCache) {
                    setRefreshError(
                        isUnauthorized ? "Sign-in expired" : "Couldn't refresh",
                    );
                } else {
                    setError(String(err.message ?? err));
                }
                setLoading(false);
            });
        return () => {
            cancelled = true;
        };
        // allKey / cwKey already encode session + filter + adminProfileId;
        // depending on them keeps this effect stable across renders.
        // retryNonce kicks the effect when we come back online.
    }, [admin, session, adminProfileId, fetchSection, nav, allKey, cwKey, retryNonce]);

    // Infinite scroll for the main grid.
    useEffect(() => {
        if (!sentinelRef.current || !hasMore || loadingMore || loading) return;
        const el = sentinelRef.current;
        const obs = new IntersectionObserver(
            (entries) => {
                const visible = entries[0]?.isIntersecting ?? false;
                if (!visible) return;
                setLoadingMore(true);
                fetchSection("all", nextStart)
                    .then((res) => {
                        if (res.status !== "modified") return;
                        const page = res.page;
                        setItems((cur) => [...cur, ...(page.Items ?? [])]);
                        setNextStart(page.NextStartIndex ?? nextStart);
                        setHasMore(!!page.HasMore);
                    })
                    .catch((err) => setError(String(err.message ?? err)))
                    .finally(() => setLoadingMore(false));
            },
            { rootMargin: "400px" },
        );
        obs.observe(el);
        return () => obs.disconnect();
    }, [hasMore, loadingMore, loading, nextStart, fetchSection]);

    // Restore scroll once content has actually rendered. Fires once
    // (restoredScrollRef gates) after `loading` flips false and at
    // least one tile is on screen so the document body has the height
    // to accept the scroll. Cleared from sessionStorage at the same
    // time so a refresh-with-no-prior-navigation doesn't snap.
    //
    // Important: this runs *before* the focus effect below by virtue
    // of declaration order, so the focus effect's scrollIntoView (which
    // would otherwise jump to the focused filter pill at the top) is
    // overridden by the page-level scrollTo.
    useEffect(() => {
        if (restoredScrollRef.current) return;
        if (loading) return;
        if (items.length === 0 && continueItems.length === 0) return;
        const KEY = "jellybean.kids.library.scrollY";
        const saved = sessionStorage.getItem(KEY);
        sessionStorage.removeItem(KEY);
        restoredScrollRef.current = true;
        if (!saved) return;
        const y = Number(saved);
        if (!Number.isFinite(y) || y <= 0) return;
        // Two rAFs: first lets React commit the new tiles, second lets
        // the browser actually compute their layout. scrollTo before
        // either would clamp to whatever height the body had at commit
        // time.
        requestAnimationFrame(() => {
            requestAnimationFrame(() => {
                window.scrollTo(0, y);
            });
        });
    }, [loading, items.length, continueItems.length]);

    // preventScroll=true on focus() suppresses the browser's
    // auto-scroll-into-view so we control all scrolls via the
    // smoothScroll animator (rAF-driven, retargets on rapid presses
    // instead of canceling in-flight animations like the WebView's
    // native smooth scroll does).
    useEffect(() => {
        const inTopArea =
            focus.kind === "tab" ||
            focus.kind === "search" ||
            focus.kind === "filter";
        if (focus.kind === "search") {
            searchWrapRef.current?.focus({ preventScroll: true });
        } else if (focus.kind === "alpha") {
            const el = tileRefs.current[`alpha:${focus.index}`];
            if (el) el.focus({ preventScroll: true });
        } else {
            const key = focusKey(focus);
            const el = tileRefs.current[key];
            if (el) el.focus({ preventScroll: true });
        }
        if (inTopArea) {
            scrollWindowToTop();
        } else if (focus.kind === "cw") {
            const el = tileRefs.current[focusKey(focus)];
            if (el) {
                scrollTileIntoRowStart(el, 20);
                scrollWindowToCenter(el);
            }
        } else if (focus.kind === "grid") {
            const el = tileRefs.current[focusKey(focus)];
            if (el) scrollWindowToCenter(el);
        }
    }, [focus]);

    // Calculate columns in the grid based on viewport width so the
    // window keydown handler below knows how far ArrowUp / Down jumps.
    const gridRef = useRef<HTMLDivElement | null>(null);
    const columns = useGridColumns(gridRef);

    // Window-level keyboard listener so D-pad navigation works even
    // when DOM focus drifts to body (route transitions, the search
    // wrap occasionally not taking focus on cheap WebView builds).
    // Skip while a modal is open so the modal owns the keys.
    useEffect(() => {
        if (menuOpen || override) return;
        const handler = (e: KeyboardEvent) => {
            const k = e.key;
            if (
                k !== "ArrowLeft" &&
                k !== "ArrowRight" &&
                k !== "ArrowUp" &&
                k !== "ArrowDown" &&
                k !== "Enter" &&
                k !== " "
            ) {
                return;
            }
            const target = e.target as HTMLElement | null;
            const onSearchInput = target?.tagName === "INPUT";
            if (onSearchInput && k !== "ArrowUp" && k !== "ArrowDown" && k !== "Enter") {
                return;
            }
            e.preventDefault();
            setFocus((f) =>
                moveFocus(f, k, {
                    filterCount: TYPE_FILTERS.length,
                    cwCount: continueItems.length,
                    gridCount: items.length,
                    columns,
                    onActivate: () =>
                        activate(
                            f,
                            items,
                            continueItems,
                            filter,
                            setFilter,
                            nav,
                            playSuffix,
                            () => setMenuOpen(true),
                            () => searchInputRef.current?.focus(),
                            (gridIdx) =>
                                setFocus({ kind: "grid", index: gridIdx }),
                        ),
                }),
            );
        };
        window.addEventListener("keydown", handler);
        return () => window.removeEventListener("keydown", handler);
    }, [
        continueItems,
        items,
        columns,
        filter,
        nav,
        playSuffix,
        menuOpen,
        override,
    ]);

    // Re-focus the Menu tab when the menu modal closes. Without this
    // the page focus state is still tab[2] but DOM focus is on body
    // (the modal's last-focused button was unmounted with the modal),
    // so the kid sees the pill highlighted but pressing Enter does
    // nothing because no element receives the keydown.
    const wasMenuOpen = useRef(false);
    useEffect(() => {
        if (wasMenuOpen.current && !menuOpen) {
            tileRefs.current["tab:2"]?.focus({ preventScroll: true });
        }
        wasMenuOpen.current = menuOpen;
    }, [menuOpen]);

    // The currently-focused content tile (cw row or main grid),
    // null when focus is on the type filter.
    const focusedItem =
        focus.kind === "cw"
            ? continueItems[focus.index]
            : focus.kind === "grid"
              ? items[focus.index]
              : undefined;
    useLongPressUp(
        () => {
            if (!focusedItem || !session) return;
            setOverride({ itemId: focusedItem.Id, itemName: focusedItem.Name });
        },
        (focus.kind === "cw" || focus.kind === "grid") &&
            !!session &&
            override === null,
        600,
    );

    // Progressive Back escape: from anywhere below search, back lands
    // on the search bar. From there, the next back exits the page.
    useProgressiveBack(
        useCallback(() => {
            if (menuOpen) {
                setMenuOpen(false);
                return true;
            }
            if (override) {
                setOverride(null);
                return true;
            }
            if (focus.kind === "grid" && focus.index !== 0) {
                setFocus({ kind: "grid", index: 0 });
                return true;
            }
            if (focus.kind === "cw" && focus.index !== 0) {
                setFocus({ kind: "cw", index: 0 });
                return true;
            }
            if (focus.kind === "grid" || focus.kind === "cw" || focus.kind === "filter") {
                setFocus({ kind: "search" });
                return true;
            }
            return false;
        }, [focus, menuOpen, override]),
    );

    if (admin === undefined) return <div className="screen">Loading...</div>;

    return (
        <div className="library">
            <TabPill
                active="library"
                search={location.search}
                focusedIndex={focus.kind === "tab" ? focus.index : null}
                tabRef={(i, el) => {
                    tileRefs.current[`tab:${i}`] = el;
                }}
                onOpenMenu={() => setMenuOpen(true)}
            />
            {adminProfileId && !session && <AdminPreviewBanner />}

            <div className="library-controls">
                <div
                    ref={searchWrapRef}
                    role="button"
                    aria-label="Search library"
                    className={`library-search-wrap ${
                        focus.kind === "search" ? "focused" : ""
                    }`}
                    tabIndex={focus.kind === "search" ? 0 : -1}
                    onClick={() => searchInputRef.current?.focus()}
                    // Deliberately NO onFocus here. React's onFocus
                    // uses focusin which bubbles, so it would fire
                    // when the inner <input> receives focus too -
                    // calling setFocus({kind:"search"}) with a new
                    // object ref, re-running the focus effect, and
                    // bouncing DOM focus back from the input to the
                    // wrap (kid couldn't type). The state is already
                    // managed by the page's keyboard handler.
                >
                    <input
                        ref={searchInputRef}
                        type="search"
                        className="library-search"
                        placeholder="Search"
                        value={searchInput}
                        onChange={(e) => setSearchInput(e.target.value)}
                        // No tabIndex=-1: Android WebView's IME launch
                        // is gated on the focused input being in the
                        // normal tab order, and -1 was suppressing
                        // it. The wrap's tabIndex toggles to keep
                        // D-pad nav landing on the wrap first; the
                        // input only gets DOM focus when Enter on the
                        // wrap promotes it.
                        // Stop click bubbling so tapping the input
                        // doesn't double-fire (wrap's onClick refocuses).
                        onClick={(e) => e.stopPropagation()}
                    />
                </div>
            </div>

            <div className="filter-row" role="tablist">
                {TYPE_FILTERS.map((f, i) => {
                    const k = `filter:${i}`;
                    const active = filter === f;
                    return (
                        <button
                            key={f}
                            ref={(el) => (tileRefs.current[k] = el)}
                            className={`filter-pill ${active ? "active" : ""} ${
                                isFocused(focus, "filter", i) ? "focused" : ""
                            }`}
                            onClick={() => {
                                setFilter(f);
                                setFocus({ kind: "filter", index: i });
                            }}
                            onFocus={() => setFocus({ kind: "filter", index: i })}
                            tabIndex={isFocused(focus, "filter", i) ? 0 : -1}
                            role="tab"
                        >
                            {f}
                        </button>
                    );
                })}
            </div>

            {error && <p className="error">{error}</p>}
            {!online && cacheHit && (
                <p className="kids-offline-pill" role="status">
                    Offline - showing cached library
                </p>
            )}
            {online && refreshError && (
                <p className="library-refresh-error" role="status">
                    {refreshError}
                </p>
            )}

            {loading ? (
                <p className="library-state">Loading...</p>
            ) : (
                <>
                    {continueItems.length > 0 && (
                        <section className="cw-row" aria-label="Continue watching">
                            <h2 className="row-title">Continue Watching</h2>
                            <div className="cw-scroll">
                                {continueItems.map((it, i) => (
                                    <Tile
                                        key={`cw:${it.Id}`}
                                        item={it}
                                        size="cw"
                                        focused={isFocused(focus, "cw", i)}
                                        showProgress
                                        onClick={() => {
                                            setFocus({ kind: "cw", index: i });
                                            const href = shouldShowWatchMenu(it)
                                                ? `/watch/${encodeURIComponent(it.Id)}${playSuffix}`
                                                : `/play/${encodeURIComponent(it.Id)}${playSuffix}`;
                                            nav(href);
                                        }}
                                        onFocus={() => setFocus({ kind: "cw", index: i })}
                                        refCallback={(el) => (tileRefs.current[`cw:${i}`] = el)}
                                    />
                                ))}
                            </div>
                        </section>
                    )}

                    <section aria-label="Library">
                        {items.length === 0 ? (
                            <p className="library-state">
                                Nothing here yet. Ask a parent to mark titles
                                visible.
                            </p>
                        ) : (
                            <div className="grid" ref={gridRef}>
                                {items.map((it, i) => (
                                    <Tile
                                        key={`grid:${it.Id}`}
                                        item={it}
                                        size="library"
                                        focused={isFocused(focus, "grid", i)}
                                        onClick={() => {
                                            setFocus({ kind: "grid", index: i });
                                            const href = shouldShowWatchMenu(it)
                                                ? `/watch/${encodeURIComponent(it.Id)}${playSuffix}`
                                                : `/play/${encodeURIComponent(it.Id)}${playSuffix}`;
                                            nav(href);
                                        }}
                                        onFocus={() => setFocus({ kind: "grid", index: i })}
                                        refCallback={(el) =>
                                            (tileRefs.current[`grid:${i}`] = el)
                                        }
                                    />
                                ))}
                            </div>
                        )}
                        <div ref={sentinelRef} className="sentinel" />
                        {loadingMore && <p className="library-state">Loading more...</p>}
                    </section>
                </>
            )}
            {override && (
                <OverrideModal
                    itemId={override.itemId}
                    itemName={override.itemName}
                    onClose={() => setOverride(null)}
                />
            )}
            {items.length > 0 && (
                <AlphaBar
                    items={items}
                    focusedIndex={focus.kind === "alpha" ? focus.index : null}
                    letterRef={(i, el) => {
                        tileRefs.current[`alpha:${i}`] = el;
                    }}
                    onLetterClick={(_letter, gridIdx) => {
                        setFocus({ kind: "grid", index: gridIdx });
                    }}
                />
            )}
            {menuOpen && <MainMenuModal onClose={() => setMenuOpen(false)} />}
        </div>
    );
}

// AdminPreviewBanner is rendered when the kids client is being previewed
// from the admin app (i.e. ?profileId=N is in the URL). The kids SPA's
// basename is /kids, so the link uses a real <a href> to escape back to
// the admin shell rather than the React Router Link.
function AdminPreviewBanner() {
    return (
        <div className="admin-preview-banner" role="status">
            <span>Previewing as admin. Resume / continue-watching are disabled in preview.</span>
            <a href="/manage-kids" className="admin-preview-back">
                Back to admin
            </a>
        </div>
    );
}

function focusKey(f: Focus): string {
    if (f.kind === "search") return "search";
    return `${f.kind}:${f.index}`;
}

function isFocused(f: Focus, kind: Focus["kind"], index?: number): boolean {
    if (f.kind !== kind) return false;
    if (kind === "search") return true;
    return "index" in f && f.index === index;
}

type MoveOpts = {
    filterCount: number;
    cwCount: number;
    gridCount: number;
    columns: number;
    onActivate: () => void;
};

function moveFocus(f: Focus, key: string, opts: MoveOpts): Focus {
    if (key === "Enter" || key === " ") {
        opts.onActivate();
        return f;
    }
    switch (f.kind) {
        case "tab":
            if (key === "ArrowLeft") return { kind: "tab", index: Math.max(0, f.index - 1) };
            if (key === "ArrowRight")
                return { kind: "tab", index: Math.min(TAB_SLOT_COUNT - 1, f.index + 1) };
            if (key === "ArrowDown") return { kind: "search" };
            return f;
        case "search":
            // Let the input own ArrowLeft / ArrowRight (caret movement)
            // and any printable text. Only Up / Down navigate.
            if (key === "ArrowUp") return { kind: "tab", index: 1 };
            if (key === "ArrowDown") return { kind: "filter", index: 0 };
            return f;
        case "filter":
            if (key === "ArrowLeft") return { kind: "filter", index: Math.max(0, f.index - 1) };
            if (key === "ArrowRight")
                return { kind: "filter", index: Math.min(opts.filterCount - 1, f.index + 1) };
            if (key === "ArrowUp") return { kind: "search" };
            if (key === "ArrowDown") {
                if (opts.cwCount > 0) return { kind: "cw", index: 0 };
                if (opts.gridCount > 0) return { kind: "grid", index: 0 };
            }
            return f;
        case "cw":
            if (key === "ArrowLeft") return { kind: "cw", index: Math.max(0, f.index - 1) };
            if (key === "ArrowRight")
                return { kind: "cw", index: Math.min(opts.cwCount - 1, f.index + 1) };
            if (key === "ArrowUp") return { kind: "filter", index: 0 };
            if (key === "ArrowDown") {
                if (opts.gridCount > 0) return { kind: "grid", index: 0 };
            }
            return f;
        case "grid": {
            const cols = Math.max(1, opts.columns);
            const i = f.index;
            if (key === "ArrowLeft") {
                if (i % cols === 0) return f;
                return { kind: "grid", index: i - 1 };
            }
            if (key === "ArrowRight") {
                // At the rightmost column, ArrowRight jumps into the
                // A-Z bar so the kid can hit the jumpscroll without
                // backtracking up to filter row.
                if ((i + 1) % cols === 0 || i === opts.gridCount - 1) {
                    return { kind: "alpha", index: 0 };
                }
                return { kind: "grid", index: i + 1 };
            }
            if (key === "ArrowDown") {
                const next = i + cols;
                if (next < opts.gridCount) return { kind: "grid", index: next };
                return { kind: "grid", index: opts.gridCount - 1 };
            }
            if (key === "ArrowUp") {
                if (i < cols) {
                    if (opts.cwCount > 0)
                        return { kind: "cw", index: Math.min(opts.cwCount - 1, i) };
                    return { kind: "filter", index: 0 };
                }
                return { kind: "grid", index: i - cols };
            }
            return f;
        }
        case "alpha": {
            // Vertical strip on the right side of the page. Up/Down
            // walks letters, Left returns to the grid, Enter activates.
            // Pressing Up at the topmost letter exits to filter row.
            if (key === "ArrowUp") {
                if (f.index <= 0) return { kind: "filter", index: 0 };
                return { kind: "alpha", index: f.index - 1 };
            }
            if (key === "ArrowDown") {
                return {
                    kind: "alpha",
                    index: Math.min(ALPHA_LETTERS.length - 1, f.index + 1),
                };
            }
            if (key === "ArrowLeft") {
                if (opts.gridCount > 0) return { kind: "grid", index: 0 };
                return { kind: "filter", index: 0 };
            }
            return f;
        }
    }
}

function activate(
    f: Focus,
    items: LibraryItem[],
    cw: LibraryItem[],
    filter: TypeFilter,
    setFilter: (t: TypeFilter) => void,
    nav: ReturnType<typeof useNavigate>,
    playSuffix: string,
    onOpenMenu: () => void,
    onOpenSearch: () => void,
    onAlphaJump: (index: number) => void,
) {
    if (f.kind === "tab") {
        if (f.index === 2) {
            onOpenMenu();
            return;
        }
        const target = f.index === 0 ? "browse" : "library";
        nav(tabHref(target, playSuffix));
        return;
    }
    if (f.kind === "search") {
        // Enter on the highlighted search bar promotes DOM focus to
        // the real <input>, which opens the Android TV IME. Pure D-pad
        // navigation onto search just highlights it, no IME.
        onOpenSearch();
        return;
    }
    if (f.kind === "alpha") {
        const letter = ALPHA_LETTERS[f.index];
        const idx = firstIndexByLetter(items)[letter];
        if (idx !== undefined) onAlphaJump(idx);
        return;
    }
    if (f.kind === "filter") {
        const next = TYPE_FILTERS[f.index];
        if (next) setFilter(next);
        return;
    }
    const target = f.kind === "cw" ? cw[f.index] : items[f.index];
    if (target) {
        const href = shouldShowWatchMenu(target)
            ? `/watch/${encodeURIComponent(target.Id)}${playSuffix}`
            : `/play/${encodeURIComponent(target.Id)}${playSuffix}`;
        nav(href);
    }
    void filter;
}

function useGridColumns(ref: React.RefObject<HTMLDivElement>): number {
    const [cols, setCols] = useState(4);
    useEffect(() => {
        if (!ref.current) return;
        const el = ref.current;
        const update = () => {
            const style = window.getComputedStyle(el);
            const cs = style.getPropertyValue("grid-template-columns");
            // "180px 180px 180px 180px" -> 4
            const n = cs.split(" ").filter(Boolean).length;
            if (n > 0) setCols(n);
        };
        update();
        const obs = new ResizeObserver(update);
        obs.observe(el);
        return () => obs.disconnect();
    }, [ref]);
    return cols;
}

