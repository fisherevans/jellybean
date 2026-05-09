import {
    useCallback,
    useEffect,
    useLayoutEffect,
    useMemo,
    useRef,
    useState,
} from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { ArrowBendRightDown } from "@phosphor-icons/react";
import {
    bucketByAdded,
    bucketByWatched,
    ADDED_ORDER,
    WATCHED_ORDER,
    type AddedBucket,
    type Item,
    type WatchedBucket,
} from "jellybean-shared";
import {
    authHeaders,
    getSession,
    probeAdmin,
    withAuthRetry,
    type AdminUser,
    type Session,
} from "./auth";
import Tile from "./Tile";
import { clear as clearLibraryCache } from "./libraryCache";
import {
    buildLibraryKey,
    idbLibraryCache,
    idbLibraryEtags,
} from "./kidsCache";
import { useKidsResource } from "./useKidsResource";
import { useItemHiddenEvent } from "./itemHidden";
import { useOnlineStatus } from "./onlineStatus";
import AlphaPickerModal from "./AlphaPickerModal";
import OptionPickerModal from "./OptionPickerModal";
import OverrideModal, { useLongPressEnter } from "./OverrideModal";
import { useKidsHome } from "./KidsHome";
import { setHomeTab } from "./kidNav";
import { useProgressiveBack } from "./useProgressiveBack";
import { useStackScroll } from "./useStackScroll";
import { useHomeTabFocus } from "./useHomeTabFocus";

// Library is the kid's main browsing screen. Top-to-bottom:
//
//   [search][filter][sort][A-Z]   (controls row)
//   [grid - flat OR sectioned]
//
// Sort = "name" renders a single flat grid (with A-Z jump). Sort =
// "recently_added" / "recently_watched" renders time-bucketed
// sections (Added today / Watched this week / Never watched / etc.)
// and hides the A-Z jump - alpha quick-jump doesn't apply when
// content isn't alphabetized.
//
// Continue Watching lives only on Browse; Library is curation +
// browse, not "what was I in the middle of."

type LibraryItem = Pick<
    Item,
    "Id" | "Name" | "Type" | "DateCreated" | "ImageTags" | "UserData"
>;

type LibraryResponse = {
    Items: LibraryItem[] | null;
    HasMore?: boolean;
    NextStartIndex?: number;
    ProfileId?: number;
    LettersByName?: Record<string, number>;
};

type FilterId = "all" | "movies" | "shows";
type SortId = "name" | "recently_added" | "recently_watched";

const FILTER_STORAGE = "jellybean.kids.library.filter";
const SORT_STORAGE = "jellybean.kids.library.sort";

const FILTER_OPTIONS: { id: FilterId; label: string }[] = [
    { id: "all", label: "All" },
    { id: "movies", label: "Movies" },
    { id: "shows", label: "Shows" },
];
const SORT_OPTIONS: { id: SortId; label: string }[] = [
    { id: "name", label: "A - Z" },
    { id: "recently_added", label: "Recently added" },
    { id: "recently_watched", label: "Recently watched" },
];

function readFilter(): FilterId {
    try {
        const v = localStorage.getItem(FILTER_STORAGE);
        if (v === "all" || v === "movies" || v === "shows") return v;
    } catch {
        /* ignore */
    }
    return "all";
}
function readSort(): SortId {
    try {
        const v = localStorage.getItem(SORT_STORAGE);
        if (v === "name" || v === "recently_added" || v === "recently_watched")
            return v;
    } catch {
        /* ignore */
    }
    return "name";
}
function filterToType(f: FilterId): string {
    if (f === "movies") return "Movie";
    if (f === "shows") return "Series";
    return "Movie,Series";
}
function labelFor<T extends { id: string; label: string }>(
    list: T[],
    id: string,
): string {
    return list.find((o) => o.id === id)?.label ?? "";
}

// Section identity: visible sections only, with a stable id so React
// keys don't churn between sort changes.
type Section = {
    id: string;
    title?: string;
    items: LibraryItem[];
};

const ADDED_TITLES: Record<AddedBucket, string> = {
    today: "Added today",
    week: "Added this week",
    month: "Added this month",
    quarter: "Added in the past 3 months",
    year: "Added in the past year",
    earlier: "Added earlier",
};
const WATCHED_TITLES: Record<WatchedBucket, string> = {
    today: "Watched today",
    week: "Watched this week",
    month: "Watched this month",
    quarter: "Watched in the past 3 months",
    year: "Watched in the past year",
    earlier: "Watched earlier",
    never: "Never watched",
};

function buildSections(items: LibraryItem[], sort: SortId): Section[] {
    if (items.length === 0) return [];
    if (sort === "name") {
        return [{ id: "all", items }];
    }
    if (sort === "recently_added") {
        const adapted = items.map((it) => ({
            it,
            dateCreated: it.DateCreated,
        }));
        const buckets = bucketByAdded(adapted);
        return ADDED_ORDER.filter((b) => buckets[b].length > 0).map((b) => ({
            id: `added:${b}`,
            title: ADDED_TITLES[b],
            items: buckets[b].map((x) => x.it),
        }));
    }
    // recently_watched
    const adapted = items.map((it) => ({
        it,
        name: it.Name,
        userData: { lastPlayedDate: it.UserData?.LastPlayedDate },
    }));
    const buckets = bucketByWatched(adapted);
    return WATCHED_ORDER.filter((b) => buckets[b].length > 0).map((b) => ({
        id: `watched:${b}`,
        title: WATCHED_TITLES[b],
        items: buckets[b].map((x) => x.it),
    }));
}

type Focus =
    | { kind: "alphaBtn" }
    | { kind: "search" }
    | { kind: "filter" }
    | { kind: "sort" }
    | { kind: "grid"; section: number; item: number };

const PAGE_SIZE = 5000;

export default function Library() {
    const nav = useNavigate();
    const [searchParams] = useSearchParams();
    const [session] = useState<Session | null>(() => getSession());
    const [admin, setAdmin] = useState<AdminUser | null | undefined>(undefined);
    const adminProfileId = searchParams.get("profileId");

    useEffect(() => {
        setHomeTab("library");
    }, []);
    const restoredScrollRef = useRef(false);
    const playSuffix = searchParams.toString()
        ? `?${searchParams.toString()}`
        : "";

    // Transform-based vertical scroll. window.scrollTo on this
    // WebView retriggers a 200-1000ms full-viewport repaint per
    // write, which made the smoothScroll animator freeze for
    // seconds at a time on Down. Stack-based transform scroll
    // (same pattern Browse uses) stays GPU-only.
    const stack = useStackScroll();

    const navToWatch = useCallback(
        (itemId: string) => {
            try {
                // stackY is negative when scrolled down; persist
                // the absolute amount so the post-load restore
                // can re-apply it without sign confusion.
                const scrollAmount = Math.max(
                    0,
                    -(stack.stackYRef.current ?? 0),
                );
                sessionStorage.setItem(
                    "jellybean.kids.library.scrollY",
                    String(scrollAmount),
                );
                sessionStorage.setItem(
                    "jellybean.kids.library.expectBack",
                    "1",
                );
            } catch {
                /* ignore */
            }
            nav(`/watch/${encodeURIComponent(itemId)}${playSuffix}`);
        },
        [nav, playSuffix, stack.stackYRef],
    );

    const [filter, setFilter] = useState<FilterId>(() => readFilter());
    const [sort, setSort] = useState<SortId>(() => readSort());
    const [filterOpen, setFilterOpen] = useState(false);
    const [sortOpen, setSortOpen] = useState(false);
    const [searchInput, setSearchInput] = useState("");
    const [searchDebounced, setSearchDebounced] = useState("");
    useEffect(() => {
        const id = window.setTimeout(() => setSearchDebounced(searchInput), 300);
        return () => window.clearTimeout(id);
    }, [searchInput]);

    const [items, setItems] = useState<LibraryItem[]>([]);
    const [lettersByName, setLettersByName] = useState<Record<string, number>>(
        {},
    );
    const [alphaModalOpen, setAlphaModalOpen] = useState(false);
    const [hasMore, setHasMore] = useState(false);
    const [nextStart, setNextStart] = useState(0);
    const [loadingMore, setLoadingMore] = useState(false);
    const [loadMoreError, setLoadMoreError] = useState<string | null>(null);
    const [retryNonce, setRetryNonce] = useState(0);
    const online = useOnlineStatus();

    const tileRefs = useRef<Record<string, HTMLButtonElement | null>>({});
    const homeCtx = useKidsHome();
    const { focus, setFocus, tabFocused, setTabFocused, handleBack } =
        useHomeTabFocus<Focus>({
            initialFocus: { kind: "search" },
            getFirstContentSlot: () => ({ kind: "search" }),
            scrollToTop: () => stack.setStackY(0, true),
            tabNav: {
                tabFocused: homeCtx.tabFocused,
                setTabFocused: homeCtx.setTabFocused,
            },
        });
    const searchWrapRef = useRef<HTMLDivElement | null>(null);
    const searchInputRef = useRef<HTMLInputElement | null>(null);
    const sentinelRef = useRef<HTMLDivElement | null>(null);
    const sectionGridRefs = useRef<(HTMLDivElement | null)[]>([]);
    const [override, setOverride] = useState<{
        itemId: string;
        itemName: string;
        itemType: string;
        seriesId?: string;
        seriesName?: string;
        played?: boolean;
    } | null>(null);

    useEffect(() => {
        probeAdmin().then(setAdmin);
    }, []);

    useEffect(() => {
        try {
            localStorage.setItem(FILTER_STORAGE, filter);
        } catch {
            /* ignore */
        }
    }, [filter]);
    useEffect(() => {
        try {
            localStorage.setItem(SORT_STORAGE, sort);
        } catch {
            /* ignore */
        }
    }, [sort]);

    const wasOnline = useRef(online);
    useEffect(() => {
        if (!wasOnline.current && online) {
            setRetryNonce((n) => n + 1);
        }
        wasOnline.current = online;
    }, [online]);

    // buildURL is shared between the first-page hook and the
    // load-more callback. The hook calls it with startIndex=0; load
    // more with the running cursor. searchDebounced disables both
    // the cache (server response varies per query) and the
    // background refetch on cache hit (no cache to revalidate).
    const buildURL = useCallback(
        (startIndex: number) => {
            const url = new URL("/api/kids/library", window.location.origin);
            url.searchParams.set("section", "all");
            url.searchParams.set("type", filterToType(filter));
            url.searchParams.set("sort", sort);
            url.searchParams.set("limit", String(PAGE_SIZE));
            if (startIndex > 0) {
                url.searchParams.set("startIndex", String(startIndex));
            }
            if (searchDebounced) {
                url.searchParams.set("search", searchDebounced);
            }
            if (adminProfileId)
                url.searchParams.set("profileId", adminProfileId);
            return url.toString();
        },
        [filter, sort, adminProfileId, searchDebounced],
    );

    const useCache = !!session && !adminProfileId && !searchDebounced;
    const userId = session?.userId ?? "";
    const typeStr = filterToType(filter);
    const cacheKey = useCache
        ? buildLibraryKey(userId, "all", typeStr, PAGE_SIZE, 0, "", sort)
        : "";

    const cache = useMemo(() => idbLibraryCache<LibraryResponse>(), []);
    const etagBackend = useMemo(() => idbLibraryEtags(), []);
    const firstPageURL = useMemo(() => {
        if (admin === undefined) return null;
        if (!session && !adminProfileId) return null;
        return buildURL(0);
    }, [admin, session, adminProfileId, buildURL]);

    const {
        data: firstPage,
        error: hookError,
        loading,
        isStale: cacheHit,
        refreshError: hookRefreshError,
    } = useKidsResource<LibraryResponse>({
        url: firstPageURL,
        cache: useCache ? cache : undefined,
        cacheKey: useCache ? cacheKey : undefined,
        etag: useCache ? etagBackend : undefined,
        // Refetch when filter/sort/search/retry change. cacheKey
        // covers filter+sort+searchDebounced indirectly but isn't a
        // dep on its own (it's "" when useCache is false).
        deps: [firstPageURL, retryNonce],
    });

    // Drive the page-state from the hook's data. When the hook
    // delivers a cache hit synchronously, this fires immediately
    // and the kid sees tiles. When the network revalidation lands
    // and is a 200 (modified), the hook re-fires with the fresh
    // data and we re-derive. 304s don't refire data so we don't
    // re-derive (correct - the cached values are still current).
    useEffect(() => {
        if (!firstPage) return;
        setItems(firstPage.Items ?? []);
        setHasMore(!!firstPage.HasMore);
        setNextStart(firstPage.NextStartIndex ?? (firstPage.Items?.length ?? 0));
        setLettersByName(firstPage.LettersByName ?? {});
    }, [firstPage]);

    // Reset paging state when the URL changes (filter/sort/search
    // swap). Otherwise the IntersectionObserver-driven load-more
    // would fire against the previous filter's nextStart.
    useEffect(() => {
        setNextStart(0);
        setHasMore(false);
        setLoadMoreError(null);
    }, [firstPageURL]);

    // Map the hook's refreshError to Library's banner text. The
    // dedicated "unauthorized" sentinel surfaces a friendlier "Sign-in
    // expired" rather than the literal status code.
    const refreshError =
        hookRefreshError === "unauthorized"
            ? "Sign-in expired"
            : hookRefreshError !== null
              ? "Couldn't refresh"
              : null;
    const error = hookError;

    useEffect(() => {
        if (!loading) {
            window.dispatchEvent(new Event("jellybean:ready"));
        }
    }, [loading]);

    // Auth gate (mirrors Browse). Runs once admin probe completes.
    useEffect(() => {
        if (admin === undefined) return;
        if (!session && !adminProfileId) {
            nav("/login", { replace: true });
        }
    }, [admin, session, adminProfileId, nav]);

    // Infinite scroll only applies when sort=name (recency sorts
    // return the entire visible set in one response, so there's no
    // sentinel to observe). Load-more stays a manual fetch (no
    // useKidsResource) - the hook is shaped for "page-level data
    // that flips on URL change," not for appending to a list.
    const loadMorePage = useCallback(async () => {
        const url = buildURL(nextStart);
        const res = await withAuthRetry(() =>
            fetch(url, {
                credentials: "same-origin",
                headers: authHeaders(),
            }),
        );
        if (!res.ok) {
            throw new Error(`${res.status}: ${await res.text()}`);
        }
        return (await res.json()) as LibraryResponse;
    }, [buildURL, nextStart]);
    useEffect(() => {
        if (sort !== "name") return;
        if (!sentinelRef.current || !hasMore || loadingMore || loading) return;
        const el = sentinelRef.current;
        const obs = new IntersectionObserver(
            (entries) => {
                const visible = entries[0]?.isIntersecting ?? false;
                if (!visible) return;
                setLoadingMore(true);
                loadMorePage()
                    .then((page) => {
                        setItems((cur) => [...cur, ...(page.Items ?? [])]);
                        setNextStart(page.NextStartIndex ?? nextStart);
                        setHasMore(!!page.HasMore);
                    })
                    .catch((err) =>
                        setLoadMoreError(String(err.message ?? err)),
                    )
                    .finally(() => setLoadingMore(false));
            },
            { rootMargin: "400px" },
        );
        obs.observe(el);
        return () => obs.disconnect();
    }, [sort, hasMore, loadingMore, loading, nextStart, loadMorePage]);

    // Parent hid an item from the modal: drop it from the in-memory
    // list and nuke the library cache so a remount refetches a clean
    // slate. We don't surgically rewrite IDB here because the
    // alphabet index (LettersByName) would still point at stale
    // offsets; clearing forces a fresh fetch on next mount, which is
    // cheap and matches the kid's expectation that the item is just
    // gone.
    useItemHiddenEvent((hiddenId) => {
        setItems((cur) => cur.filter((it) => it.Id !== hiddenId));
        clearLibraryCache().catch(() => {});
    });

    const sections = useMemo(() => buildSections(items, sort), [items, sort]);
    const totalItems = items.length;

    // After a sort change, any "grid" focus that pointed into the
    // previous section layout may now point past the new sections /
    // out of bounds. Clamp it so the focus DOM-management effect
    // doesn't try to focus a missing ref. Controls focus is fine as-is.
    useEffect(() => {
        if (focus.kind !== "grid") return;
        const sec = sections[focus.section];
        if (sec && focus.item < sec.items.length) return;
        if (sections.length === 0) {
            setFocus({ kind: "search" });
            return;
        }
        setFocus({ kind: "grid", section: 0, item: 0 });
    }, [sections, focus]);

    // Post-load scroll handling. The saved value is the absolute
    // scroll-amount (positive number representing how far down the
    // kid was); we apply it as a negative stackY (translate3d up).
    useEffect(() => {
        if (restoredScrollRef.current) return;
        if (loading) return;
        if (totalItems === 0) return;
        restoredScrollRef.current = true;
        const FLAG = "jellybean.kids.library.expectBack";
        const KEY = "jellybean.kids.library.scrollY";
        const expecting = sessionStorage.getItem(FLAG) === "1";
        sessionStorage.removeItem(FLAG);
        sessionStorage.removeItem(KEY);
        if (!expecting) {
            stack.setStackY(0, true);
            return;
        }
        const saved = sessionStorage.getItem(KEY);
        if (!saved) return;
        const y = Number(saved);
        if (!Number.isFinite(y) || y <= 0) return;
        // Two rAFs for parity with the old window-scroll path: lets
        // React commit + the browser settle layout before we
        // restore. With transform-based scroll the timing matters
        // less, but it doesn't hurt and keeps behavior stable across
        // image-load sizing wobble.
        requestAnimationFrame(() => {
            requestAnimationFrame(() => {
                stack.setStackY(-y, true);
            });
        });
    }, [loading, totalItems, stack]);

    const columns = useGridColumns(sectionGridRefs, sections);

    // Focus DOM management.
    useEffect(() => {
        if (tabFocused) return;
        if (focus.kind === "search") {
            searchWrapRef.current?.focus({ preventScroll: true });
            stack.scrollToTop();
            return;
        }
        if (
            focus.kind === "alphaBtn" ||
            focus.kind === "filter" ||
            focus.kind === "sort"
        ) {
            const el = tileRefs.current[focusKey(focus)];
            if (el) el.focus({ preventScroll: true });
            stack.scrollToTop();
            return;
        }
        // grid
        const el = tileRefs.current[focusKey(focus)];
        if (!el) return;
        el.focus({ preventScroll: true });
        const onFirstRow =
            focus.section === 0 && focus.item < Math.max(1, columns);
        if (onFirstRow) {
            stack.scrollToTop();
        } else {
            stack.scrollToCenter(el);
        }
    }, [focus, columns, tabFocused, stack]);

    const wasTabFocused = useRef(true);
    useEffect(() => {
        if (wasTabFocused.current && !tabFocused) {
            setFocus({ kind: "search" });
        }
        wasTabFocused.current = tabFocused;
    }, [tabFocused]);

    useLayoutEffect(() => {
        stack.setStackY(0, true);
        // stack is stable across renders; safe to omit from deps.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    // tabFocused → true scroll-to-top + blur lives in useHomeTabFocus.

    const lastMoveRef = useRef(0);
    const REPEAT_MIN_MS = 90;
    useEffect(() => {
        if (override || tabFocused) return;
        if (filterOpen || sortOpen || alphaModalOpen) return;
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
            if (
                onSearchInput &&
                k !== "ArrowUp" &&
                k !== "ArrowDown" &&
                k !== "Enter"
            ) {
                return;
            }
            e.preventDefault();
            if (e.repeat) {
                const now = performance.now();
                if (now - lastMoveRef.current < REPEAT_MIN_MS) return;
                lastMoveRef.current = now;
            } else {
                lastMoveRef.current = performance.now();
            }
            // Up off the controls row hands focus back to the tab nav.
            if (
                k === "ArrowUp" &&
                (focus.kind === "search" ||
                    focus.kind === "filter" ||
                    focus.kind === "sort" ||
                    focus.kind === "alphaBtn")
            ) {
                setTabFocused(true);
                return;
            }
            setFocus((f) =>
                moveFocus(f, k, {
                    sections,
                    columns,
                    onActivate: () =>
                        activate(f, {
                            setFilterOpen,
                            setSortOpen,
                            setAlphaModalOpen,
                            openSearch: () =>
                                searchInputRef.current?.focus(),
                        }),
                }),
            );
        };
        window.addEventListener("keydown", handler);
        return () => window.removeEventListener("keydown", handler);
    }, [
        focus,
        sections,
        columns,
        override,
        tabFocused,
        setTabFocused,
        filterOpen,
        sortOpen,
        alphaModalOpen,
    ]);

    const focusedItem =
        focus.kind === "grid"
            ? sections[focus.section]?.items[focus.item]
            : undefined;
    const handleShortPress = useCallback(() => {
        if (!focusedItem) return;
        navToWatch(focusedItem.Id);
    }, [focusedItem, navToWatch]);
    const handleLongPress = useCallback(() => {
        if (!focusedItem) return;
        const pct = focusedItem.UserData?.PlayedPercentage ?? 0;
        setOverride({
            itemId: focusedItem.Id,
            itemName: focusedItem.Name,
            itemType: focusedItem.Type,
            played: pct >= 90,
        });
    }, [focusedItem]);
    useLongPressEnter({
        enabled:
            !!focusedItem &&
            !!session &&
            override === null &&
            !tabFocused &&
            !filterOpen &&
            !sortOpen &&
            !alphaModalOpen,
        onShortPress: handleShortPress,
        onLongPress: handleLongPress,
    });

    useProgressiveBack(
        useCallback(() => {
            if (override) {
                setOverride(null);
                return true;
            }
            if (filterOpen) {
                setFilterOpen(false);
                return true;
            }
            if (sortOpen) {
                setSortOpen(false);
                return true;
            }
            if (alphaModalOpen) {
                setAlphaModalOpen(false);
                setFocus({ kind: "alphaBtn" });
                return true;
            }
            // Hand off to useHomeTabFocus for the load-bearing reset
            // (setTabFocused + setFocus(search) in a single render).
            // See web/kids/CLAUDE.md ("Back-then-Down focus contract").
            return handleBack();
        }, [
            override,
            alphaModalOpen,
            filterOpen,
            sortOpen,
            setFocus,
            handleBack,
        ]),
    );

    if (admin === undefined) return <div className="screen">Loading...</div>;

    return (
        <div className="library">
            {adminProfileId && !session && <AdminPreviewBanner />}
            <div ref={stack.stackRef} className="kids-stack library-stack">

            <div className="library-controls">
                <div
                    ref={searchWrapRef}
                    role="button"
                    aria-label="Search library"
                    className={`library-search-wrap ${
                        !tabFocused && focus.kind === "search" ? "focused" : ""
                    }`}
                    tabIndex={!tabFocused && focus.kind === "search" ? 0 : -1}
                    onClick={() => searchInputRef.current?.focus()}
                >
                    <input
                        ref={searchInputRef}
                        type="search"
                        className="library-search"
                        placeholder="Search"
                        value={searchInput}
                        onChange={(e) => setSearchInput(e.target.value)}
                        onClick={(e) => e.stopPropagation()}
                    />
                </div>
                <button
                    type="button"
                    ref={(el) => (tileRefs.current["filter"] = el)}
                    className={`library-dropdown-btn ${
                        !tabFocused && focus.kind === "filter" ? "focused" : ""
                    }`}
                    tabIndex={!tabFocused && focus.kind === "filter" ? 0 : -1}
                    onClick={() => setFilterOpen(true)}
                    onFocus={() => setFocus({ kind: "filter" })}
                >
                    <span className="library-dropdown-label">Filter:</span>
                    <span className="library-dropdown-value">
                        {labelFor(FILTER_OPTIONS, filter)}
                    </span>
                </button>
                <button
                    type="button"
                    ref={(el) => (tileRefs.current["sort"] = el)}
                    className={`library-dropdown-btn ${
                        !tabFocused && focus.kind === "sort" ? "focused" : ""
                    }`}
                    tabIndex={!tabFocused && focus.kind === "sort" ? 0 : -1}
                    onClick={() => setSortOpen(true)}
                    onFocus={() => setFocus({ kind: "sort" })}
                >
                    <span className="library-dropdown-label">Sort:</span>
                    <span className="library-dropdown-value">
                        {labelFor(SORT_OPTIONS, sort)}
                    </span>
                </button>
                <button
                    type="button"
                    ref={(el) => (tileRefs.current["alphaBtn"] = el)}
                    className={`library-alpha-btn library-jump-btn ${
                        !tabFocused && focus.kind === "alphaBtn"
                            ? "focused"
                            : ""
                    }`}
                    tabIndex={
                        !tabFocused && focus.kind === "alphaBtn" ? 0 : -1
                    }
                    onClick={() => setAlphaModalOpen(true)}
                    onFocus={() => setFocus({ kind: "alphaBtn" })}
                    aria-label="Jump"
                    title="Jump"
                >
                    <span>Jump</span>
                    <ArrowBendRightDown weight="bold" aria-hidden />
                </button>
            </div>

            {(error || loadMoreError) && (
                <p className="error">{error ?? loadMoreError}</p>
            )}
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
            ) : sections.length === 0 ? (
                <p className="library-state">
                    Nothing here yet. Ask a parent to mark titles visible.
                </p>
            ) : (
                <>
                    {sections.map((s, sIdx) => (
                        <section
                            key={s.id}
                            className="kids-section"
                            aria-label={s.title ?? "Library"}
                        >
                            {s.title && (
                                <h2 className="kids-section-title">
                                    {s.title}
                                </h2>
                            )}
                            <div
                                className="grid"
                                ref={(el) =>
                                    (sectionGridRefs.current[sIdx] = el)
                                }
                            >
                                {s.items.map((it, i) => {
                                    const key = `grid:${sIdx}:${i}`;
                                    const isFoc =
                                        focus.kind === "grid" &&
                                        focus.section === sIdx &&
                                        focus.item === i;
                                    return (
                                        <Tile
                                            key={`${s.id}:${it.Id}`}
                                            item={it}
                                            size="library"
                                            focused={!tabFocused && isFoc}
                                            showProgress
                                            onClick={() => {
                                                setFocus({
                                                    kind: "grid",
                                                    section: sIdx,
                                                    item: i,
                                                });
                                                navToWatch(it.Id);
                                            }}
                                            onFocus={() =>
                                                setFocus({
                                                    kind: "grid",
                                                    section: sIdx,
                                                    item: i,
                                                })
                                            }
                                            refCallback={(el) =>
                                                (tileRefs.current[key] = el)
                                            }
                                        />
                                    );
                                })}
                            </div>
                        </section>
                    ))}
                    {sort === "name" && (
                        <div ref={sentinelRef} className="sentinel" />
                    )}
                    {loadingMore && (
                        <p className="library-state">Loading more...</p>
                    )}
                </>
            )}
            </div>
            {override && (
                <OverrideModal
                    itemId={override.itemId}
                    itemName={override.itemName}
                    itemType={override.itemType}
                    seriesId={override.seriesId}
                    seriesName={override.seriesName}
                    played={override.played}
                    onClose={() => setOverride(null)}
                />
            )}
            {filterOpen && (
                <OptionPickerModal
                    title="Filter"
                    options={FILTER_OPTIONS}
                    currentId={filter}
                    onSelect={(id) => {
                        setFilter(id as FilterId);
                        setFilterOpen(false);
                    }}
                    onClose={() => setFilterOpen(false)}
                />
            )}
            {sortOpen && (
                <OptionPickerModal
                    title="Sort"
                    options={SORT_OPTIONS}
                    currentId={sort}
                    onSelect={(id) => {
                        setSort(id as SortId);
                        setSortOpen(false);
                    }}
                    onClose={() => setSortOpen(false)}
                />
            )}
            {alphaModalOpen &&
                (sort === "name" ? (
                    <AlphaPickerModal
                        lettersByName={lettersByName}
                        onPick={(gridIdx) => {
                            setAlphaModalOpen(false);
                            // Alpha picker indexes the flat (sort=name)
                            // grid; section 0 holds everything in that mode.
                            setFocus({
                                kind: "grid",
                                section: 0,
                                item: gridIdx,
                            });
                        }}
                        onClose={() => {
                            setAlphaModalOpen(false);
                            setFocus({ kind: "alphaBtn" });
                        }}
                    />
                ) : (
                    <OptionPickerModal
                        title="Jump to"
                        options={sections.map((s) => ({
                            id: s.id,
                            label: s.title ?? "All",
                        }))}
                        currentId=""
                        onSelect={(id) => {
                            const idx = sections.findIndex(
                                (s) => s.id === id,
                            );
                            setAlphaModalOpen(false);
                            if (idx >= 0) {
                                setFocus({
                                    kind: "grid",
                                    section: idx,
                                    item: 0,
                                });
                            } else {
                                setFocus({ kind: "alphaBtn" });
                            }
                        }}
                        onClose={() => {
                            setAlphaModalOpen(false);
                            setFocus({ kind: "alphaBtn" });
                        }}
                    />
                ))}
        </div>
    );
}

function AdminPreviewBanner() {
    return (
        <div className="admin-preview-banner" role="status">
            <span>
                Previewing as admin. Resume / continue-watching are disabled
                in preview.
            </span>
            <a href="/manage-kids" className="admin-preview-back">
                Back to admin
            </a>
        </div>
    );
}

function focusKey(f: Focus): string {
    if (f.kind === "grid") return `grid:${f.section}:${f.item}`;
    return f.kind;
}

type MoveOpts = {
    sections: Section[];
    columns: number;
    onActivate: () => void;
};

function moveFocus(f: Focus, key: string, opts: MoveOpts): Focus {
    if (key === "Enter" || key === " ") {
        opts.onActivate();
        return f;
    }
    const firstGrid: Focus | null =
        opts.sections.length > 0 && opts.sections[0].items.length > 0
            ? { kind: "grid", section: 0, item: 0 }
            : null;
    switch (f.kind) {
        case "search":
            if (key === "ArrowLeft") return f;
            if (key === "ArrowRight") return { kind: "filter" };
            if (key === "ArrowDown") return firstGrid ?? f;
            return f;
        case "filter":
            if (key === "ArrowLeft") return { kind: "search" };
            if (key === "ArrowRight") return { kind: "sort" };
            if (key === "ArrowDown") return firstGrid ?? f;
            return f;
        case "sort":
            if (key === "ArrowLeft") return { kind: "filter" };
            if (key === "ArrowRight") return { kind: "alphaBtn" };
            if (key === "ArrowDown") return firstGrid ?? f;
            return f;
        case "alphaBtn":
            if (key === "ArrowLeft") return { kind: "sort" };
            if (key === "ArrowDown") return firstGrid ?? f;
            return f;
        case "grid": {
            return moveGrid(f, key, opts);
        }
    }
}

function moveGrid(
    f: { kind: "grid"; section: number; item: number },
    key: string,
    opts: MoveOpts,
): Focus {
    const cols = Math.max(1, opts.columns);
    const sec = opts.sections[f.section];
    if (!sec) return f;
    const len = sec.items.length;
    const i = f.item;
    const col = i % cols;
    const rowInSec = Math.floor(i / cols);
    if (key === "ArrowLeft") {
        if (col === 0) return f;
        return { kind: "grid", section: f.section, item: i - 1 };
    }
    if (key === "ArrowRight") {
        if (col + 1 >= cols || i + 1 >= len) return f;
        return { kind: "grid", section: f.section, item: i + 1 };
    }
    if (key === "ArrowDown") {
        // Within section: advance to next row even if it's a partial
        // (last) row. Clamp the column to the last item that row has.
        const nextRowStart = (rowInSec + 1) * cols;
        if (nextRowStart < len) {
            const nextRowItems = Math.min(cols, len - nextRowStart);
            const target = Math.min(col, nextRowItems - 1);
            return {
                kind: "grid",
                section: f.section,
                item: nextRowStart + target,
            };
        }
        // No next row in this section: hop to first row of next
        // section, clamped to that row's width.
        const nextSec = opts.sections[f.section + 1];
        if (nextSec) {
            const firstRowItems = Math.min(cols, nextSec.items.length);
            const target = Math.min(col, firstRowItems - 1);
            return {
                kind: "grid",
                section: f.section + 1,
                item: Math.max(0, target),
            };
        }
        // No further sections: stay (don't drift to a different col).
        return f;
    }
    if (key === "ArrowUp") {
        if (rowInSec > 0) {
            const prevRowStart = (rowInSec - 1) * cols;
            return {
                kind: "grid",
                section: f.section,
                item: prevRowStart + col,
            };
        }
        // First row of section: hop to last row of previous section,
        // clamped to that row's width.
        if (f.section > 0) {
            const prev = opts.sections[f.section - 1];
            const prevLen = prev.items.length;
            const lastRowStart = Math.floor((prevLen - 1) / cols) * cols;
            const lastRowItems = prevLen - lastRowStart;
            const target = Math.min(col, lastRowItems - 1);
            return {
                kind: "grid",
                section: f.section - 1,
                item: lastRowStart + Math.max(0, target),
            };
        }
        // First row of first section: hand off to controls row.
        return { kind: "search" };
    }
    return f;
}

type ActivateHandlers = {
    setFilterOpen: (v: boolean) => void;
    setSortOpen: (v: boolean) => void;
    setAlphaModalOpen: (v: boolean) => void;
    openSearch: () => void;
};

function activate(f: Focus, h: ActivateHandlers) {
    if (f.kind === "filter") {
        h.setFilterOpen(true);
        return;
    }
    if (f.kind === "sort") {
        h.setSortOpen(true);
        return;
    }
    if (f.kind === "alphaBtn") {
        h.setAlphaModalOpen(true);
        return;
    }
    if (f.kind === "search") {
        h.openSearch();
        return;
    }
    // grid Enter is owned by useLongPressEnter; not reached here.
}

// useGridColumns reports the grid track count (CSS columns) shared
// across all section grids. All grids use the same `.grid` CSS
// template so the count is identical between them.
//
// Reading `getComputedStyle(grid).gridTemplateColumns` is the
// authoritative source: with `grid-template-columns: repeat(auto-fill,
// minmax(170px, 1fr))`, the computed value resolves to a list of
// real px tracks (e.g. "186.4px 186.4px ..."). Counting whitespace-
// separated tokens gives the actual column count regardless of how
// many items the first row has.
//
// The previous implementation counted children sharing offsetTop on
// the first non-empty grid, which broke when sections like "Added
// today" had only one item: that section's first row had 1 child, so
// columns was reported as 1 and Down navigation collapsed to "next
// item" instead of "next row".
function useGridColumns(
    refs: React.MutableRefObject<(HTMLDivElement | null)[]>,
    sections: Section[],
): number {
    const [cols, setCols] = useState(4);
    useEffect(() => {
        const update = () => {
            const grid = refs.current.find((g) => g && g.children.length > 0);
            if (!grid) return;
            const tpl = window
                .getComputedStyle(grid)
                .gridTemplateColumns.trim();
            if (tpl && tpl !== "none") {
                const tracks = tpl.split(/\s+/).filter(Boolean).length;
                if (tracks > 0) {
                    setCols(tracks);
                    return;
                }
            }
            // Fallback: count children sharing the first child's
            // offsetTop on the LARGEST grid (most likely to have a
            // full first row).
            let best: HTMLDivElement | null = null;
            let bestLen = 0;
            for (const g of refs.current) {
                if (g && g.children.length > bestLen) {
                    best = g;
                    bestLen = g.children.length;
                }
            }
            if (!best) return;
            const first = best.children[0] as HTMLElement;
            const firstTop = first.offsetTop;
            let count = 0;
            for (let i = 0; i < best.children.length; i++) {
                const c = best.children[i] as HTMLElement;
                if (Math.abs(c.offsetTop - firstTop) > 1) break;
                count++;
            }
            if (count > 0) setCols(count);
        };
        update();
        window.addEventListener("resize", update);
        return () => window.removeEventListener("resize", update);
    }, [refs, sections]);
    return cols;
}
